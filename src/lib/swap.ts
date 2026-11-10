import { type Address, type WalletClient, encodeFunctionData } from "viem";
import {
  type ChainCfg,
  type ReserveV3Route,
  type V2Route,
  ROUTER_ADDRESS_THIS,
  brokerAbi,
  erc20Abi,
  quoterAbi,
  routerAbi,
  v2RouterAbi,
} from "./contracts";

export type Quote = {
  gdIn: bigint;
  out: bigint; // native out (18 decimals)
  mid?: { amount: bigint; symbol: string; decimals: number }; // intermediate stable, reserve route only
  fee?: number; // chosen Uniswap v3 fee tier
};

export const applySlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

// ---------- quoting ----------

async function quoteStableToNative(cfg: ChainCfg, r: ReserveV3Route, amountIn: bigint) {
  const results = await Promise.all(
    r.fees.map((fee) =>
      cfg.client
        .simulateContract({
          address: r.quoter,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: r.stable.address, tokenOut: r.nativeToken, amountIn, fee, sqrtPriceLimitX96: 0n }],
        })
        .then((x) => ({ fee, out: x.result[0] }))
        .catch(() => ({ fee, out: 0n })),
    ),
  );
  const best = results.reduce((a, b) => (b.out > a.out ? b : a));
  if (best.out === 0n) throw new Error(`No ${r.stable.symbol} → ${cfg.nativeSymbol} liquidity`);
  return best;
}

const quoteGdToStable = (cfg: ChainCfg, r: ReserveV3Route, gdIn: bigint) =>
  cfg.client.readContract({
    address: r.broker,
    abi: brokerAbi,
    functionName: "getAmountOut",
    args: [r.exchangeProvider, r.exchangeId, cfg.gd.address, r.stable.address, gdIn],
  });

async function quoteV2(cfg: ChainCfg, r: V2Route, gdIn: bigint) {
  const amounts = await cfg.client.readContract({
    address: r.router,
    abi: v2RouterAbi,
    functionName: "getAmountsOut",
    args: [gdIn, r.path],
  });
  return amounts[amounts.length - 1];
}

export async function quote(cfg: ChainCfg, gdIn: bigint): Promise<Quote> {
  const r = cfg.route;
  if (r.kind === "v2") return { gdIn, out: await quoteV2(cfg, r, gdIn) };
  const stableOut = await quoteGdToStable(cfg, r, gdIn);
  const { fee, out } = await quoteStableToNative(cfg, r, stableOut);
  return { gdIn, out, fee, mid: { amount: stableOut, symbol: r.stable.symbol, decimals: r.stable.decimals } };
}

/** Worst-case output after slippage (reserve route applies slippage on both legs). */
export function minOut(cfg: ChainCfg, q: Quote, bps: number) {
  const once = applySlippage(q.out, bps);
  return cfg.route.kind === "reserve-v3" ? applySlippage(once, bps) : once;
}

export async function getBalances(cfg: ChainCfg, account: Address) {
  const [gd, native] = await Promise.all([
    cfg.client.readContract({ address: cfg.gd.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    cfg.client.getBalance({ address: account }),
  ]);
  return { gd, native };
}

// ---------- execution ----------

export type StepStatus = "pending" | "active" | "done" | "skipped" | "error";
export type Step = { id: string; label: string };
type Progress = (step: string, status: StepStatus, txHash?: `0x${string}`) => void;

export function stepsFor(cfg: ChainCfg): Step[] {
  const r = cfg.route;
  if (r.kind === "v2")
    return [
      { id: "approveGd", label: `Approve G$ for ${r.dexName}` },
      { id: "swap", label: `Swap G$ → ${cfg.nativeSymbol} (${r.dexName})` },
    ];
  return [
    { id: "approveGd", label: "Approve G$ for GoodReserve" },
    { id: "swapGd", label: `Swap G$ → ${r.stable.symbol} (GoodReserve)` },
    { id: "approveStable", label: `Approve ${r.stable.symbol} for Uniswap` },
    { id: "swapStable", label: `Swap ${r.stable.symbol} → ${cfg.nativeSymbol} (Uniswap v3)` },
  ];
}

type Ctx = { cfg: ChainCfg; wallet: WalletClient; account: Address; onProgress: Progress };

async function waitOk(cfg: ChainCfg, hash: `0x${string}`) {
  const r = await cfg.client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readAllowance = (cfg: ChainCfg, token: Address, account: Address, spender: Address) =>
  cfg.client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });

async function ensureAllowance(ctx: Ctx, token: Address, spender: Address, amount: bigint, step: string) {
  const { cfg, wallet, account, onProgress } = ctx;
  const current = await readAllowance(cfg, token, account, spender);
  if (current >= amount) return onProgress(step, "skipped");
  onProgress(step, "active");
  const hash = await wallet.writeContract({
    account,
    chain: cfg.chain,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  onProgress(step, "active", hash);
  await waitOk(cfg, hash);

  // Public RPCs are load-balanced; the node we read from next may lag a block or two behind
  // the one that confirmed the approval. Wait until the new allowance is actually visible.
  let seen = 0n;
  for (let i = 0; i < 15; i++) {
    seen = await readAllowance(cfg, token, account, spender);
    if (seen >= amount) break;
    await sleep(2000);
  }
  if (seen < amount) {
    throw new Error(
      `Approval confirmed but allowance is ${seen} (< ${amount} needed). ` +
        "If your wallet let you edit the spending cap, approve at least the swap amount and try again.",
    );
  }
  onProgress(step, "done", hash);
}

const isAllowanceError = (e: unknown) =>
  /allowance|STF|TRANSFER_FROM_FAILED|insufficient/i.test(String((e as { message?: string })?.message ?? e));

/** Simulate, send, wait. Simulation surfaces revert reasons before the wallet prompt. */
async function send(ctx: Ctx, step: string, call: Parameters<ChainCfg["client"]["simulateContract"]>[0]) {
  const { cfg, wallet, account, onProgress } = ctx;
  onProgress(step, "active");
  // Retry simulation briefly if a lagging RPC node hasn't seen a just-confirmed approval/transfer.
  let sim: Awaited<ReturnType<ChainCfg["client"]["simulateContract"]>> | undefined;
  for (let i = 0; ; i++) {
    try {
      sim = await cfg.client.simulateContract({ ...call, account } as typeof call);
      break;
    } catch (e) {
      if (i >= 4 || !isAllowanceError(e)) throw e;
      await sleep(3000);
    }
  }
  const { request } = sim;
  const hash = await wallet.writeContract({ ...request, chain: cfg.chain } as Parameters<WalletClient["writeContract"]>[0]);
  onProgress(step, "active", hash);
  await waitOk(cfg, hash);
  onProgress(step, "done", hash);
}

const balanceOf = (cfg: ChainCfg, token: Address, account: Address) =>
  cfg.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });

async function swapReserveV3(ctx: Ctx, r: ReserveV3Route, gdIn: bigint, bps: number) {
  const { cfg, account } = ctx;

  // Leg 1: G$ -> stable through the GoodDollar reserve
  await ensureAllowance(ctx, cfg.gd.address, r.broker, gdIn, "approveGd");
  const before = await balanceOf(cfg, r.stable.address, account);
  const expectedStable = await quoteGdToStable(cfg, r, gdIn);
  await send(ctx, "swapGd", {
    address: r.broker,
    abi: brokerAbi,
    functionName: "swapIn",
    args: [r.exchangeProvider, r.exchangeId, cfg.gd.address, r.stable.address, gdIn, applySlippage(expectedStable, bps)],
  });
  const stableIn = (await balanceOf(cfg, r.stable.address, account)) - before;
  if (stableIn <= 0n) throw new Error(`No ${r.stable.symbol} received from the reserve swap`);

  // Leg 2: stable -> native via Uniswap v3 (re-quoted with the actual amount received)
  await ensureAllowance(ctx, r.stable.address, r.router, stableIn, "approveStable");
  const { fee, out } = await quoteStableToNative(cfg, r, stableIn);
  const min = applySlippage(out, bps);
  const swapCall = (recipient: Address) =>
    encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: r.stable.address,
          tokenOut: r.nativeToken,
          fee,
          recipient,
          amountIn: stableIn,
          amountOutMinimum: min,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  const calls = r.unwrap
    ? [swapCall(ROUTER_ADDRESS_THIS), encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [min, account] })]
    : [swapCall(account)];
  await send(ctx, "swapStable", {
    address: r.router,
    abi: routerAbi,
    functionName: "multicall",
    args: [deadline(), calls],
  });
  return out;
}

async function swapV2(ctx: Ctx, r: V2Route, gdIn: bigint, bps: number) {
  const { cfg, account } = ctx;
  await ensureAllowance(ctx, cfg.gd.address, r.router, gdIn, "approveGd");
  const out = await quoteV2(cfg, r, gdIn);
  await send(ctx, "swap", {
    address: r.router,
    abi: v2RouterAbi,
    functionName: "swapExactTokensForETH",
    args: [gdIn, applySlippage(out, bps), r.path, account, deadline()],
  });
  return out;
}

export async function swapGdToNative(opts: {
  cfg: ChainCfg;
  wallet: WalletClient;
  account: Address;
  gdIn: bigint;
  slippageBps: number;
  onProgress: Progress;
}): Promise<bigint> {
  const { cfg, gdIn, slippageBps, ...rest } = opts;
  const ctx: Ctx = { cfg, ...rest };
  const r = cfg.route;
  return r.kind === "v2" ? swapV2(ctx, r, gdIn, slippageBps) : swapReserveV3(ctx, r, gdIn, slippageBps);
}
