"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Address,
  type EIP1193Provider,
  type WalletClient,
  createWalletClient,
  custom,
  formatUnits,
  parseUnits,
} from "viem";
import { CHAINS, type ChainCfg, type ChainKey } from "@/lib/contracts";
import { type Quote, type StepStatus, getBalances, minOut, quote, stepsFor, swapGdToNative } from "@/lib/swap";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const fmt = (v: bigint, d: number, max = 6) =>
  Number(formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: max });

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function errMsg(e: unknown) {
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage ?? err?.message ?? String(e);
}

async function ensureChain(provider: EIP1193Provider, cfg: ChainCfg) {
  const { chain } = cfg;
  const hex = `0x${chain.id.toString(16)}` as const;
  const current = await provider.request({ method: "eth_chainId" });
  if (Number(current) === chain.id) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: [chain.blockExplorers!.default.url],
        },
      ],
    });
  }
}

const ORDER: ChainKey[] = ["xdc", "celo", "fuse"];

export default function SwapCard() {
  const [chainKey, setChainKey] = useState<ChainKey>("xdc");
  const cfg = CHAINS[chainKey];
  const [account, setAccount] = useState<Address>();
  const [balances, setBalances] = useState<{ key: ChainKey; gd: bigint; native: bigint }>();
  const [amount, setAmount] = useState("");
  const [lastQuote, setLastQuote] = useState<Quote & { key: ChainKey }>();
  const [slippageBps, setSlippageBps] = useState(100);
  const [steps, setSteps] = useState<Record<string, { status: StepStatus; hash?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const gdIn = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount, cfg.gd.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, cfg.gd.decimals]);

  const refreshBalances = useCallback(async (key: ChainKey, acc: Address) => {
    try {
      const b = await getBalances(CHAINS[key], acc);
      setBalances({ key, ...b });
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const walletFor = (c: ChainCfg): WalletClient =>
    createWalletClient({ chain: c.chain, transport: custom(window.ethereum!) });

  const connect = async () => {
    setError(undefined);
    const provider = window.ethereum;
    if (!provider) {
      setError("No wallet found. Install MetaMask or another EVM wallet.");
      return;
    }
    try {
      await provider.request({ method: "eth_requestAccounts" });
      await ensureChain(provider, cfg);
      const [acc] = await walletFor(cfg).getAddresses();
      setAccount(acc);
      refreshBalances(chainKey, acc);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const selectChain = async (key: ChainKey) => {
    if (key === chainKey || busy) return;
    setChainKey(key);
    setAmount("");
    setSteps({});
    setError(undefined);
    setSuccess(undefined);
    if (account) {
      refreshBalances(key, account);
      try {
        await ensureChain(window.ethereum!, CHAINS[key]);
      } catch (e) {
        setError(errMsg(e));
      }
    }
  };

  // React to wallet account changes.
  const chainKeyRef = useRef(chainKey);
  useEffect(() => {
    chainKeyRef.current = chainKey;
  }, [chainKey]);
  useEffect(() => {
    const p = window.ethereum;
    if (!p?.on) return;
    const onAccounts = (accs: string[]) => {
      const acc = accs[0] as Address | undefined;
      setAccount(acc);
      if (acc) refreshBalances(chainKeyRef.current, acc);
      else setBalances(undefined);
    };
    p.on("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, [refreshBalances]);

  // Debounced quoting. The quote is only shown while it matches the current input + chain.
  useEffect(() => {
    if (gdIn === 0n) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await quote(CHAINS[chainKey], gdIn);
        if (!cancelled) {
          setLastQuote({ ...res, key: chainKey });
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError(`Quote failed: ${errMsg(e)}`);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [gdIn, chainKey]);

  const q = lastQuote && gdIn > 0n && lastQuote.key === chainKey && lastQuote.gdIn === gdIn ? lastQuote : undefined;
  const quoting = gdIn > 0n && !q && !error;
  const bal = balances?.key === chainKey ? balances : undefined;
  const insufficient = bal !== undefined && gdIn > bal.gd;
  const noGas = bal !== undefined && bal.native === 0n;
  const stepList = stepsFor(cfg);

  const doSwap = async () => {
    if (!account || !q) return;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    setSteps(Object.fromEntries(stepList.map((s) => [s.id, { status: "pending" as StepStatus }])));
    let currentStep: string | undefined;
    try {
      await ensureChain(window.ethereum!, cfg);
      const out = await swapGdToNative({
        cfg,
        wallet: walletFor(cfg),
        account,
        gdIn,
        slippageBps,
        onProgress: (id, status, hash) => {
          currentStep = id;
          setSteps((s) => ({ ...s, [id]: { status, hash: hash ?? s[id]?.hash } }));
        },
      });
      setSuccess(
        `Swapped ${fmt(gdIn, cfg.gd.decimals, 2)} G$ for ~${fmt(out, 18, 4)} ${cfg.nativeSymbol} on ${cfg.chain.name}`,
      );
      setAmount("");
    } catch (e) {
      if (currentStep) setSteps((s) => ({ ...s, [currentStep!]: { ...s[currentStep!], status: "error" } }));
      setError(errMsg(e));
    } finally {
      setBusy(false);
      refreshBalances(chainKey, account);
    }
  };

  const rate = q && q.gdIn > 0n ? Number(formatUnits(q.out, 18)) / Number(formatUnits(q.gdIn, cfg.gd.decimals)) : undefined;

  let cta = "Swap";
  if (!account) cta = "Connect wallet";
  else if (gdIn === 0n) cta = "Enter an amount";
  else if (insufficient) cta = "Insufficient G$ balance";
  else if (noGas) cta = `Need ${cfg.nativeSymbol} for gas`;
  else if (quoting || !q) cta = "Fetching quote…";
  else if (busy) cta = "Swapping…";

  const disabled = account ? busy || quoting || !q || gdIn === 0n || insufficient || noGas : false;
  const explorer = cfg.chain.blockExplorers!.default.url;

  return (
    <div className="w-full max-w-md">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          G$ → {cfg.nativeSymbol}
        </h1>
        {account ? (
          <span className="rounded-full border border-[var(--line)] px-3 py-1 font-mono text-sm">{short(account)}</span>
        ) : (
          <button onClick={connect} className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white">
            Connect
          </button>
        )}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-1 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-1" role="tablist">
        {ORDER.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={k === chainKey}
            disabled={busy}
            onClick={() => selectChain(k)}
            className={`rounded-xl py-2 text-sm font-medium transition ${
              k === chainKey ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:bg-[var(--field)]"
            }`}
          >
            {CHAINS[k].chain.name.replace(" Network", "")}
          </button>
        ))}
      </div>

      <div className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-sm">
        <div className="rounded-2xl bg-[var(--field)] p-4">
          <div className="flex justify-between text-sm text-[var(--muted)]">
            <span>You pay</span>
            {bal && (
              <button
                className="hover:text-[var(--fg)]"
                onClick={() => setAmount(formatUnits(bal.gd, cfg.gd.decimals))}
                disabled={busy}
              >
                Balance: {fmt(bal.gd, cfg.gd.decimals, 2)} · Max
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              inputMode="decimal"
              placeholder="0"
              value={amount}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (new RegExp(`^\\d*\\.?\\d{0,${cfg.gd.decimals}}$`).test(v)) setAmount(v);
              }}
              className="min-w-0 flex-1 bg-transparent text-3xl outline-none placeholder:text-[var(--muted)]"
            />
            <span className="rounded-full bg-[var(--card)] px-3 py-1 font-medium">G$</span>
          </div>
        </div>

        <div className="my-1 flex justify-center text-[var(--muted)]">↓</div>

        <div className="rounded-2xl bg-[var(--field)] p-4">
          <div className="flex justify-between text-sm text-[var(--muted)]">
            <span>You receive (estimated)</span>
            {bal && <span>Balance: {fmt(bal.native, 18, 4)}</span>}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span className={`min-w-0 flex-1 truncate text-3xl ${quoting ? "opacity-50" : ""}`}>
              {q ? fmt(q.out, 18, 6) : "0"}
            </span>
            <span className="rounded-full bg-[var(--card)] px-3 py-1 font-medium">{cfg.nativeSymbol}</span>
          </div>
        </div>

        {q && (
          <dl className="mt-3 space-y-1.5 px-1 text-sm text-[var(--muted)]">
            <div className="flex justify-between">
              <dt>Rate</dt>
              <dd>
                1 G$ ≈ {rate?.toPrecision(4)} {cfg.nativeSymbol}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Route</dt>
              <dd className="text-right">
                {q.mid
                  ? `G$ → ${fmt(q.mid.amount, q.mid.decimals, 4)} ${q.mid.symbol} → ${cfg.nativeSymbol}`
                  : cfg.routeLabel}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Minimum received</dt>
              <dd>
                {fmt(minOut(cfg, q, slippageBps), 18, 6)} {cfg.nativeSymbol}
              </dd>
            </div>
          </dl>
        )}

        <div className="mt-3 flex items-center justify-between px-1 text-sm">
          <span className="text-[var(--muted)]">Slippage{cfg.route.kind === "reserve-v3" ? " (per leg)" : ""}</span>
          <div className="flex gap-1">
            {[50, 100, 200].map((bps) => (
              <button
                key={bps}
                onClick={() => setSlippageBps(bps)}
                disabled={busy}
                className={`rounded-full px-2.5 py-0.5 ${
                  slippageBps === bps ? "bg-[var(--accent)] text-white" : "bg-[var(--field)]"
                }`}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={account ? doSwap : connect}
          disabled={disabled}
          className="mt-4 w-full rounded-2xl bg-[var(--accent)] py-3.5 text-lg font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cta}
        </button>

        {Object.keys(steps).length > 0 && (
          <ol className="mt-4 space-y-2 text-sm">
            {stepList.map(({ id, label }) => {
              const s = steps[id];
              const icon = { pending: "○", active: "◌", done: "●", skipped: "–", error: "✕" }[s?.status ?? "pending"];
              return (
                <li key={id} className="flex items-center justify-between gap-2">
                  <span className={s?.status === "active" ? "animate-pulse" : s?.status === "skipped" ? "opacity-50" : ""}>
                    <span className="mr-2 inline-block w-3">{icon}</span>
                    {label}
                    {s?.status === "skipped" && " (already approved)"}
                  </span>
                  {s?.hash && (
                    <a className="text-[var(--accent)] underline" href={`${explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {error && <p className="mt-3 break-words rounded-xl bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {success && <p className="mt-3 rounded-xl bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{success}</p>}
      </div>

      <p className="mt-4 px-2 text-center text-xs text-[var(--muted)]">
        {cfg.route.kind === "reserve-v3"
          ? `Swaps G$ via the GoodDollar reserve, then ${cfg.route.stable.symbol} → ${cfg.nativeSymbol} on Uniswap v3. Up to 4 wallet confirmations.`
          : `Swaps G$ → ${cfg.nativeSymbol} on ${cfg.route.dexName}. Up to 2 wallet confirmations.`}{" "}
        You need a little {cfg.nativeSymbol} for gas.
      </p>
    </div>
  );
}
