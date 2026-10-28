// $PUSHD settings, all from the environment (or engine/.env). Everything here is public (addresses and numbers)
// except whether a keeper key is set; the key itself is only ever read in keeper-chain.ts.
//
// With none of these set the engine behaves exactly as before: /v1/token says "launching soon", no keeper runs and
// holder sign-in answers that it opens at launch.
//
//   PUSHD_BURN_POT_ADDRESS      the burn pot (contracts/token-deploy.sh writes it to contracts/broadcast/token.env)
//   PUSHD_SPLITTER_ADDRESS      the fee address (the splitter)
//   PUSHD_BURN_POT_BLOCK        the block the pot was deployed in: where burns are looked for
//   PUSHD_TOKEN_ADDRESS         $PUSHD, once launched (read from the pot when empty)
//   PUSHD_TOKEN_RPC_URL         Robinhood Chain RPC for reads (the public node when empty)
//   PUSHD_EXPLORER_URL          the explorer (Robinhood Chain's Blockscout by default)
//
//   PUSHD_HOLDER_MIN            whole $PUSHD a wallet must hold for the live feed (1,000,000)
//   PUSHD_HOLDER_CACHE_MINUTES  how long a wallet's balance is trusted before it is read again (10)
//   PUSHD_HOLDER_SESSION_DAYS   how long a sign-in lasts (7)
//   PUSHD_SITE_URL              the site the sign-in message names (https://pushd.fun)
//
//   PUSHD_KEEPER                off: the keeper never runs, whatever else is set
//   PUSHD_KEEPER_KEY            the keeper wallet's key (gas only). Read in keeper-chain.ts alone
//   PUSHD_KEEPER_RPC_URL        a node for sending (falls back to the read RPC)
//   PUSHD_KEEPER_EVERY_MINUTES  how often it looks (15)
//   PUSHD_KEEPER_MIN_GAS_ETH    below this the keeper sends nothing and says so (0.0005)
//   PUSHD_KEEPER_MAX_GWEI       refused above this gas price (0.5)
//   PUSHD_KEEPER_DAILY_GAS      gas units a UTC day may use (8,000,000)
//   PUSHD_KEEPER_MIN_SWEEP_ETH  the least a sweep must move (0.0002)

export const ROBINHOOD_CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
/** The Pons launch factory $PUSHD launches through (contracts/lib.sh). */
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

export const WEI = 10n ** 18n;

export type TokenConfig = {
  token: string | null;
  pot: string | null;
  splitter: string | null;
  potBlock: number | null;
  rpcUrl: string;
  /** True when the read RPC is the public node (no RPC set). */
  publicRpc: boolean;
  explorer: string;
  chainId: number;
  holder: {
    minWhole: string;
    minWei: bigint;
    cacheMinutes: number;
    sessionDays: number;
    siteUrl: string;
  };
  keeper: {
    /** PUSHD_KEEPER=off: never runs. */
    switchedOff: boolean;
    keySet: boolean;
    rpcUrl: string;
    everyMinutes: number;
    minGasWei: bigint;
    maxGwei: number;
    dailyGas: number;
    minSweepWei: bigint;
  };
};

type Env = Record<string, string | undefined>;

export const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
export const sameAddress = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase());
const addr = (v: string | undefined) => (isAddress(v?.trim()) ? v!.trim() : null);
const https = (v: string | undefined) => (/^https:\/\/\S+$/.test(v?.trim() ?? "") ? v!.trim() : null);
const rpc = (v: string | undefined) => (/^https?:\/\/\S+$/.test(v?.trim() ?? "") ? v!.trim() : null);
const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number((v ?? "").replace(/[,_\s]/g, ""));
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/** A decimal string of ETH or whole tokens to wei, on the digits, never through a float. Null when not a plain decimal. */
export function toWei(v: string | undefined | null): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec((v ?? "").replace(/[,_\s]/g, ""));
  if (!m) return null;
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** Whole tokens ("100000", "100,000") as a plain digit string above zero, or null. */
function wholeTokens(v: string | undefined | null): string | null {
  const s = (v ?? "").replace(/[,_\s]/g, "");
  return /^\d{1,24}$/.test(s) && BigInt(s) > 0n ? BigInt(s).toString() : null;
}

export const DEFAULT_HOLDER_MIN = "1000000";

export function tokenConfigFromEnv(env: Env = process.env): TokenConfig {
  const readRpc = rpc(env.PUSHD_TOKEN_RPC_URL);
  const block = Number(env.PUSHD_BURN_POT_BLOCK);
  const holderMin = wholeTokens(env.PUSHD_HOLDER_MIN) ?? DEFAULT_HOLDER_MIN;
  const maxGwei = Number(env.PUSHD_KEEPER_MAX_GWEI);
  return {
    token: addr(env.PUSHD_TOKEN_ADDRESS),
    pot: addr(env.PUSHD_BURN_POT_ADDRESS),
    splitter: addr(env.PUSHD_SPLITTER_ADDRESS),
    potBlock: Number.isSafeInteger(block) && block > 0 ? block : null,
    rpcUrl: readRpc ?? PUBLIC_RPC,
    publicRpc: readRpc === null,
    explorer: https(env.PUSHD_EXPLORER_URL)?.replace(/\/+$/, "") ?? EXPLORER,
    chainId: ROBINHOOD_CHAIN_ID,
    holder: {
      minWhole: holderMin,
      minWei: BigInt(holderMin) * WEI,
      cacheMinutes: int(env.PUSHD_HOLDER_CACHE_MINUTES, 10, 1, 24 * 60),
      sessionDays: int(env.PUSHD_HOLDER_SESSION_DAYS, 7, 1, 90),
      siteUrl: rpc(env.PUSHD_SITE_URL)?.replace(/\/+$/, "") ?? "https://pushd.fun",
    },
    keeper: {
      switchedOff: env.PUSHD_KEEPER?.trim() === "off",
      keySet: /^0x[0-9a-fA-F]{64}$/.test(env.PUSHD_KEEPER_KEY?.trim() ?? ""),
      rpcUrl: rpc(env.PUSHD_KEEPER_RPC_URL) ?? readRpc ?? PUBLIC_RPC,
      everyMinutes: int(env.PUSHD_KEEPER_EVERY_MINUTES, 15, 1, 24 * 60),
      minGasWei: toWei(env.PUSHD_KEEPER_MIN_GAS_ETH) ?? toWei("0.0005")!,
      maxGwei: maxGwei > 0 && maxGwei <= 1000 ? maxGwei : 0.5,
      dailyGas: int(env.PUSHD_KEEPER_DAILY_GAS, 8_000_000, 100_000, 1_000_000_000),
      minSweepWei: toWei(env.PUSHD_KEEPER_MIN_SWEEP_ETH) ?? toWei("0.0002")!,
    },
  };
}

/** The keeper runs only when it is not switched off and its key and both contracts are set. */
export function keeperStatus(c: TokenConfig): { on: boolean; missing: string[] } {
  const missing: string[] = [];
  if (c.keeper.switchedOff) missing.push("Switched off (PUSHD_KEEPER=off).");
  if (!c.keeper.keySet) missing.push("A keeper key (PUSHD_KEEPER_KEY) for a wallet that holds a little ETH for gas.");
  if (!c.pot) missing.push("The burn pot (PUSHD_BURN_POT_ADDRESS).");
  if (!c.splitter) missing.push("The fee address (PUSHD_SPLITTER_ADDRESS).");
  return { on: missing.length === 0, missing };
}

/** Whether a balance reaches the holder threshold. Exact, in wei: one wei under is not a holder. */
export const isHolder = (c: TokenConfig, wei: bigint | null) => wei !== null && wei >= c.holder.minWei;
