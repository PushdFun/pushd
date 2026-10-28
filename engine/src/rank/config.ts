// The settings of the ranking (src/rank): who can be in the pool, how the score is weighed, how the Top N rotates and
// how hard each outside source may be asked. All from the environment; the defaults are what the site describes.
//
// Who PUSHD watches: crypto token projects with a token listed on a DEX (found through DexScreener, CoinGecko and
// GitHub search), a real public GitHub, out for a while, and still updating. Not chains' foundations, big platforms or
// famous people: the public denylist below names the obvious giants, and a private list (data/deny.private.json, or
// PUSHD_DENY_PRIVATE on a host) names accounts that are never shown at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.ts";
import type { GroupKey } from "../types.ts";

type Env = Record<string, string | undefined>;
const num = (v: string | undefined, d: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The five camps, mapped to the token space. The keys stay as they were (the feed, the scouts and the site use them);
 * what each camp holds is what the label says.
 */
export const CAMP_LABEL: Record<GroupKey, string> = {
  launchpads: "Solana and pump.fun",
  chain: "Robinhood Chain",
  wallets: "Base and EVM",
  ai: "AI agents",
  oss: "Tools and infra",
};

/** The score's parts and their default weights. */
export const PART_DEFS = [
  { key: "commits", label: "commits and pushes", weight: 3 },
  { key: "contributors", label: "active contributors", weight: 2 },
  { key: "releases", label: "releases and tags", weight: 1.5 },
  { key: "newRepos", label: "new repos", weight: 1 },
  { key: "stars", label: "new stars", weight: 1 },
  { key: "forks", label: "new forks", weight: 0.5 },
  { key: "issues", label: "issues and pull requests", weight: 1.5 },
  { key: "followers", label: "followers", weight: 0.4 },
  { key: "pushd", label: "PUSHD's own signals", weight: 1 },
  { key: "token", label: "token: age and volume trend", weight: 0.6 },
] as const;
export type PartKey = (typeof PART_DEFS)[number]["key"];

/** Big chains, foundations, platforms, companies and famous people: never in the pool, whatever their token. */
export const GIANTS = [
  "ethereum", "bitcoin", "solana-labs", "solana-foundation", "anza-xyz", "firedancer-io", "solana-program", "openai", "anthropics", "google",
  "google-deepmind", "google-gemini", "google-research", "microsoft", "facebook", "facebookresearch", "meta-llama", "twitter", "x", "xai-org",
  "torvalds", "vbuterin", "coinbase", "base", "base-org", "MetaMask", "Uniswap", "bnb-chain", "binance", "binance-chain", "ethereum-optimism",
  "OffchainLabs", "matter-labs", "MystenLabs", "aptos-labs", "ava-labs", "near", "ton-blockchain", "tronprotocol", "cosmos", "paritytech",
  "polkadot-fellows", "input-output-hk", "IntersectMBO", "cardano-foundation", "smartcontractkit", "huggingface", "NVIDIA", "apple", "aws",
  "vercel", "ripple", "XRPLF", "stellar", "dogecoin", "litecoin-project", "monero-project", "filecoin-project", "ipfs", "protocol",
  "LedgerHQ", "trezor", "safe-global", "OpenZeppelin", "foundry-rs", "paradigmxyz", "Consensys", "sigp", "prysmaticlabs", "flashbots",
  "aave", "compound-finance", "makerdao", "sky-ecosystem", "lidofinance", "curvefi", "balancer", "1inch", "0xProject", "wormhole-foundation",
  "LayerZero-Labs", "tether", "circlefin", "okx", "bybit-exchange", "kucoin", "crypto-com", "gemini", "krakenfx", "hyperledger", "robinhood",
  "ondoprotocol", "backed-fi", "jup-ag", "raydium-io", "pancakeswap", "pendle-finance", "aerodrome-finance", "orca-so", "gmx-io", "dydxprotocol", "sushiswap", "fetchai",
  "aeyakovenko", "gavofyork", "karpathy", "simonw", "ggerganov", "geohot", "lucidrains", "antirez", "sindresorhus", "yyx990803", "gaearon",
  "dhh", "rauchg", "shadcn", "mitchellh", "jart", "tj", "ThePrimeagen", "levelsio", "balajis", "fiatjaf", "jessepollak", "karalabe",
];

export type PrivateDeny = { accounts: string[]; repoNames: string[] };

/** The private list: PUSHD_DENY_PRIVATE ("a,b,c" accounts; "repo:axon" for repo names), else data/deny.private.json. */
export function privateDeny(env: Env = process.env, file = join(ROOT, "data", "deny.private.json")): PrivateDeny {
  const fromEnv = list(env.PUSHD_DENY_PRIVATE);
  const out: PrivateDeny = { accounts: [], repoNames: [] };
  if (fromEnv.length) {
    for (const x of fromEnv) (x.startsWith("repo:") ? out.repoNames : out.accounts).push(x.replace(/^repo:/, ""));
  } else if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<PrivateDeny>;
      out.accounts = Array.isArray(j.accounts) ? j.accounts.filter((x) => typeof x === "string") : [];
      out.repoNames = Array.isArray(j.repoNames) ? j.repoNames.filter((x) => typeof x === "string") : [];
    } catch {
      /* unreadable: nothing extra */
    }
  }
  return out;
}

export type RankConfig = {
  on: boolean;
  size: number;
  enterRank: number;
  enterPasses: number;
  exitRank: number;
  exitPasses: number;
  minDwellHours: number;
  campMin: number;
  weights: Record<PartKey, number>;
  /** the time constant of the decay inside each window, in days (newer activity counts more) */
  decayDays: number;
  pool: {
    minLiquidityUsd: number;
    minVolumeUsd: number;
    minPairDays: number;
    /** the GitHub owner must have pushed within this many days */
    activeDays: number;
    maxMcapUsd: number;
    /** users with more followers than this count as famous people, not projects */
    famousFollowers: number;
    chains: string[];
    geckoCategories: string[];
  };
  sources: {
    gharchive: boolean;
    gharchiveBackfillHours: number;
    dexPerMin: number;
    geckoPerMin: number;
    geckoDetailsPerDay: number;
    websitesPerDay: number;
    pumpfun: boolean;
    codeSearchPages: number;
    /** words for DexScreener's pair search (each gives up to 30 pairs with their links) */
    dexSearch: string[];
    /** search API calls a minute the ranking may make (GitHub allows 30 with a token, 10 without; lookups get the rest) */
    searchPerMin: number;
    /** owners whose repos and commits are read by the search API in one deep pass */
    deepOwners: number;
  };
  everyHourMin: number;
  deepEveryHours: number;
  deny: { giants: Set<string>; private: PrivateDeny; extra: Set<string> };
};

export function rankConfigFromEnv(env: Env = process.env, authenticated = false): RankConfig {
  const weights = Object.fromEntries(PART_DEFS.map((p) => [p.key, num(env[`PUSHD_RANK_W_${p.key.toUpperCase()}`], p.weight, 0, 100)])) as Record<PartKey, number>;
  const size = num(env.PUSHD_TOP_SIZE, 100, 10, 500);
  return {
    on: env.PUSHD_RANK?.trim().toLowerCase() !== "off",
    size,
    enterRank: num(env.PUSHD_RANK_ENTER, Math.round(size * 0.9), 1, size),
    enterPasses: num(env.PUSHD_RANK_ENTER_PASSES, 3, 1, 100),
    exitRank: num(env.PUSHD_RANK_EXIT, Math.round(size * 1.3), size, size * 5),
    exitPasses: num(env.PUSHD_RANK_EXIT_PASSES, 6, 1, 500),
    minDwellHours: num(env.PUSHD_RANK_MIN_DWELL_HOURS, 24, 0, 24 * 60),
    campMin: num(env.PUSHD_RANK_CAMP_MIN, 8, 0, 20),
    weights,
    decayDays: num(env.PUSHD_RANK_DECAY_DAYS, 7, 0.5, 60),
    pool: {
      minLiquidityUsd: num(env.PUSHD_POOL_MIN_LIQUIDITY_USD, 20_000),
      minVolumeUsd: num(env.PUSHD_POOL_MIN_VOLUME_USD, 5_000),
      minPairDays: num(env.PUSHD_POOL_MIN_PAIR_DAYS, 30, 0, 3650),
      activeDays: num(env.PUSHD_POOL_ACTIVE_DAYS, 30, 1, 365),
      maxMcapUsd: num(env.PUSHD_POOL_MAX_MCAP_USD, 300_000_000),
      famousFollowers: num(env.PUSHD_POOL_FAMOUS_FOLLOWERS, 20_000),
      chains: list(env.PUSHD_POOL_CHAINS).length ? list(env.PUSHD_POOL_CHAINS) : ["solana", "base", "robinhood", "ethereum", "arbitrum", "bsc"],
      geckoCategories: list(env.PUSHD_POOL_GECKO_CATEGORIES).length
        ? list(env.PUSHD_POOL_GECKO_CATEGORIES)
        : ["pump-fun", "solana-meme-coins", "ai-agents", "ai-agent-launchpad", "ai-meme-coins", "ai-framework", "base-meme-coins", "base-native", "robinhood-ecosystem", "robinhood-chain-meme", "virtuals-protocol-ecosystem", "launchpad", "metadao-launchpad"],
    },
    sources: {
      gharchive: env.PUSHD_RANK_GHARCHIVE?.trim().toLowerCase() !== "off",
      gharchiveBackfillHours: num(env.PUSHD_RANK_GHARCHIVE_BACKFILL_HOURS, 72, 0, 24 * 30),
      dexPerMin: num(env.PUSHD_DEX_PER_MIN, 30, 1, 250),
      geckoPerMin: num(env.PUSHD_GECKO_PER_MIN, 5, 1, 30),
      geckoDetailsPerDay: num(env.PUSHD_GECKO_DETAILS_PER_DAY, 150, 0, 5000),
      websitesPerDay: num(env.PUSHD_POOL_WEBSITES_PER_DAY, 600, 0, 5000),
      pumpfun: env.PUSHD_POOL_PUMPFUN?.trim().toLowerCase() === "on",
      codeSearchPages: num(env.PUSHD_POOL_CODE_SEARCH_PAGES, 3, 0, 10),
      dexSearch: list(env.PUSHD_POOL_DEX_SEARCH).length
        ? list(env.PUSHD_POOL_DEX_SEARCH)
        : ["ai agent", "agents", "pump", "solana ai", "base ai", "robinhood", "launchpad", "framework", "protocol", "sdk", "mcp", "bot", "terminal", "dex", "oracle", "virtuals", "eliza", "swarm", "inference", "zk"],
      searchPerMin: num(env.PUSHD_RANK_SEARCH_PER_MIN, authenticated ? 18 : 5, 1, 30),
      deepOwners: num(env.PUSHD_RANK_DEEP_OWNERS, authenticated ? 400 : 60, 0, 5000),
    },
    everyHourMin: num(env.PUSHD_RANK_EVERY_MIN, 60, 5, 24 * 60),
    deepEveryHours: num(env.PUSHD_RANK_DEEP_EVERY_HOURS, 24, 1, 24 * 14),
    deny: { giants: new Set(GIANTS.map((g) => g.toLowerCase())), private: privateDeny(env), extra: new Set(list(env.PUSHD_DENY).map((x) => x.toLowerCase())) },
  };
}

/** Is this login one PUSHD never puts in the pool? `privateOnly`: only the never-shown list (lookups use this). */
export function denied(c: Pick<RankConfig, "deny">, login: string, o: { privateOnly?: boolean } = {}): boolean {
  const l = login.toLowerCase();
  if (c.deny.private.accounts.some((a) => a.toLowerCase() === l)) return true;
  if (o.privateOnly) return false;
  return c.deny.giants.has(l) || c.deny.extra.has(l);
}

/** A repo name on the private list (never shown, whoever owns it). */
export const deniedRepo = (c: Pick<RankConfig, "deny">, repo: string) => c.deny.private.repoNames.some((r) => r.toLowerCase() === repo.toLowerCase());
