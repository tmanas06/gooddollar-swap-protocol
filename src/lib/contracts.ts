import { type Address, type Chain, type PublicClient, createPublicClient, defineChain, fallback, http, parseAbi } from "viem";

/*
 * Addresses: GoodDollar/GoodProtocol releases/deployment.json ("production-xdc", "production-celo",
 * "production" = Fuse) + Uniswap v3 / Voltage deployments. All verified on-chain.
 */

const mkChain = (id: number, name: string, symbol: string, rpcs: string[], explorer: string) =>
  defineChain({
    id,
    name,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: rpcs } },
    blockExplorers: { default: { name: "Explorer", url: explorer } },
  });

type Token = { address: Address; symbol: string; decimals: number };

/** G$ -> stable via GoodDollar reserve (Mento Broker), then stable -> native via Uniswap v3. */
export type ReserveV3Route = {
  kind: "reserve-v3";
  broker: Address;
  exchangeProvider: Address;
  exchangeId: `0x${string}`;
  stable: Token;
  router: Address; // Uniswap SwapRouter02
  quoter: Address; // Uniswap QuoterV2
  fees: number[]; // candidate pool fees for stable/native; best quote wins
  nativeToken: Address; // wrapped native (or CELO's ERC20 which *is* native)
  unwrap: boolean; // true: router must unwrap WETH-style token to native
};

/** G$ -> native via a Uniswap-v2 style router (swapExactTokensForETH). */
export type V2Route = {
  kind: "v2";
  router: Address;
  path: Address[];
  dexName: string;
};

export type ChainKey = "xdc" | "celo" | "fuse";

export type ChainCfg = {
  key: ChainKey;
  chain: Chain;
  client: PublicClient;
  gd: Token;
  nativeSymbol: string;
  route: ReserveV3Route | V2Route;
  routeLabel: string;
};

const client = (chain: Chain) =>
  createPublicClient({ chain, transport: fallback(chain.rpcUrls.default.http.map((u) => http(u))) }) as PublicClient;

const xdc = mkChain(
  50,
  "XDC Network",
  "XDC",
  ["https://xdc.public-rpc.com", "https://erpc.xdcrpc.com", "https://erpc.xinfin.network"],
  "https://xdcscan.com",
);
const celo = mkChain(42220, "Celo", "CELO", ["https://forno.celo.org", "https://celo.drpc.org"], "https://celoscan.io");
const fuse = mkChain(122, "Fuse", "FUSE", ["https://rpc.fuse.io", "https://fuse.drpc.org"], "https://explorer.fuse.io");

export const CHAINS: Record<ChainKey, ChainCfg> = {
  xdc: {
    key: "xdc",
    chain: xdc,
    client: client(xdc),
    gd: { address: "0xEC2136843a983885AebF2feB3931F73A8eBEe50c", symbol: "G$", decimals: 18 },
    nativeSymbol: "XDC",
    routeLabel: "GoodReserve → Uniswap v3",
    route: {
      kind: "reserve-v3",
      broker: "0x88de45906D4F5a57315c133620cfa484cB297541",
      exchangeProvider: "0x2fFBB49055d487DdBBb0C052Cd7c2a02A7971e41",
      exchangeId: "0xf8d028730f58a008390c265fca425bb912e4c7efa370d4cef756a06f5029acd2",
      stable: { address: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", symbol: "USDC", decimals: 6 },
      router: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
      quoter: "0x5911cB3633e764939edc2d92b7e1ad375Bb57649",
      fees: [500, 3000],
      nativeToken: "0x951857744785e80e2de051c32ee7b25f9c458c42", // WXDC
      unwrap: true,
    },
  },
  celo: {
    key: "celo",
    chain: celo,
    client: client(celo),
    gd: { address: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A", symbol: "G$", decimals: 18 },
    nativeSymbol: "CELO",
    routeLabel: "GoodReserve → Uniswap v3",
    route: {
      kind: "reserve-v3",
      broker: "0x88de45906D4F5a57315c133620cfa484cB297541",
      exchangeProvider: "0x2fFBB49055d487DdBBb0C052Cd7c2a02A7971e41",
      exchangeId: "0xba77f5c7bb3317643c6d81d1ef3f9913561741d92095f88efa402faf2cbe9124",
      stable: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", symbol: "cUSD", decimals: 18 },
      router: "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
      quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8",
      fees: [100, 3000],
      nativeToken: "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO (ERC20 == native)
      unwrap: false,
    },
  },
  fuse: {
    key: "fuse",
    chain: fuse,
    client: client(fuse),
    gd: { address: "0x495d133B938596C9984d462F007B676bDc57eCEC", symbol: "G$", decimals: 2 },
    nativeSymbol: "FUSE",
    routeLabel: "Voltage (G$/WFUSE pool)",
    route: {
      kind: "v2",
      dexName: "Voltage",
      router: "0xE3F85aAd0c8DD7337427B9dF5d0fB741d65EEEB5",
      path: ["0x495d133B938596C9984d462F007B676bDc57eCEC", "0x0BE9e53fd7EDaC9F859882AfdDa116645287C629"],
    },
  },
};

// SwapRouter02 sentinel: keep output in the router so it can be unwrapped to native.
export const ROUTER_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const;

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const brokerAbi = parseAbi([
  "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)",
]);

export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
]);

export const v2RouterAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);
