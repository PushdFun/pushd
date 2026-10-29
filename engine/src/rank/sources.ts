// The outside sources the pool is gathered from, each paced, capped, cached and booked (source_calls):
//   - DexScreener's public API: the latest token profiles and boosts, and the pairs of any token (liquidity, volume,
//     when its oldest pair was created, its links). At most PUSHD_DEX_PER_MIN calls a minute (DexScreener allows 60
//     to 300).
//   - CoinGecko's free API: the coins of a few categories by volume, then each coin's links (repos_url.github) and
//     its addresses per chain. At most PUSHD_GECKO_PER_MIN calls a minute and PUSHD_GECKO_DETAILS_PER_DAY coin pages a
//     day; a coin page is kept for a week.
//   - A token's own website, read once a week for a GitHub link when the listings give none: one page, 256 KB at most,
//     PUSHD_POOL_WEBSITES_PER_DAY a day.
//   - pump.fun's coin page, off by default (PUSHD_POOL_PUMPFUN=on): its API sits behind a bot check.
// Nothing here is trusted as instructions: it is data, read for links and numbers only.
import type { DB } from "../db.ts";
import { bookSource, cachedSource, storeSource } from "./store.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Fetcher = typeof fetch;

/** Spaces calls to one source: at most `perMin` a minute. */
export class Pace {
  private last = 0;
  constructor(
    private readonly perMin: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
  ) {}
  async turn() {
    const gap = 60_000 / this.perMin;
    const wait = this.last + gap - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }
}

export type SourceDeps = { db: DB; fetchImpl?: Fetcher; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (m: string) => void };

async function getJson<T>(d: SourceDeps, source: string, url: string, pace: Pace, o: { cacheKey?: string; maxAgeMs?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; data: T | null }> {
  const now = d.now ?? Date.now;
  if (o.cacheKey && o.maxAgeMs) {
    const c = cachedSource(d.db, o.cacheKey, o.maxAgeMs, now());
    if (c) return { status: c.status, data: c.body ? (JSON.parse(c.body) as T) : null };
  }
  await pace.turn();
  let res: Response;
  try {
    res = await (d.fetchImpl ?? fetch)(url, { headers: { accept: "application/json", "user-agent": "pushd-ranking", ...(o.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  } catch {
    bookSource(d.db, source, false, 0, now());
    return { status: 0, data: null };
  }
  const text = res.ok ? (await res.text()).slice(0, 4_000_000) : (await res.body?.cancel().catch(() => undefined), "");
  bookSource(d.db, source, res.ok, text.length, now());
  if (!res.ok) {
    if (o.cacheKey && res.status === 404) storeSource(d.db, o.cacheKey, 404, null, now());
    return { status: res.status, data: null };
  }
  try {
    const data = JSON.parse(text) as T;
    if (o.cacheKey) storeSource(d.db, o.cacheKey, 200, text, now());
    return { status: 200, data };
  } catch {
    return { status: 502, data: null };
  }
}

// ---- DexScreener ----

export type DexLink = { type?: string; label?: string; url: string };
export type DexProfile = { chainId: string; tokenAddress: string; url?: string; description?: string; links?: DexLink[] };
export type DexPair = {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken?: { address: string; symbol?: string };
  volume?: { h24?: number; h6?: number; h1?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { websites?: { label?: string; url: string }[]; socials?: { type?: string; url: string }[] };
};

/** A token's market as the DEX listing has it: its best pair, its oldest pair's age, and every link it lists. */
export type TokenMarket = {
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  url: string | null;
  liquidityUsd: number;
  volumeUsd: number;
  volumeH6: number;
  mcapUsd: number | null;
  pairCreatedAt: number | null;
  links: string[];
};

export class DexScreener {
  private readonly pace: Pace;
  constructor(
    private readonly d: SourceDeps,
    perMin: number,
  ) {
    this.pace = new Pace(perMin, d.sleep, d.now);
  }

  /** The latest token profiles, latest boosts, top boosts and community takeovers: new tokens with their links. */
  async discover(chains: string[]): Promise<DexProfile[]> {
    const out: DexProfile[] = [];
    for (const path of ["token-profiles/latest/v1", "token-boosts/latest/v1", "token-boosts/top/v1", "community-takeovers/latest/v1"]) {
      const r = await getJson<DexProfile[]>(this.d, "dexscreener", `https://api.dexscreener.com/${path}`, this.pace);
      for (const p of Array.isArray(r.data) ? r.data : []) if (p?.tokenAddress && chains.includes(p.chainId)) out.push(p);
    }
    return out;
  }

  /** DexScreener's pair search for a few words (up to 30 pairs each). */
  async search(q: string): Promise<DexPair[]> {
    const r = await getJson<{ pairs?: DexPair[] }>(this.d, "dexscreener", `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, this.pace, { cacheKey: `dex:search:${q}`, maxAgeMs: 6 * HOUR });
    return r.data?.pairs ?? [];
  }

  /** Markets for up to 30 tokens of one chain per call. */
  async markets(chain: string, addresses: string[]): Promise<Map<string, TokenMarket>> {
    const out = new Map<string, TokenMarket>();
    const uniq = [...new Set(addresses)];
    for (let i = 0; i < uniq.length; i += 30) {
      const batch = uniq.slice(i, i + 30);
      const r = await getJson<DexPair[]>(this.d, "dexscreener", `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${batch.map(encodeURIComponent).join(",")}`, this.pace);
      const pairs = Array.isArray(r.data) ? r.data : [];
      for (const a of batch) {
        const mine = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === a.toLowerCase());
        if (!mine.length) continue;
        const best = [...mine].sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];
        const created = mine.map((p) => p.pairCreatedAt ?? 0).filter((t) => t > 0);
        const links = new Set<string>();
        for (const p of mine) for (const l of [...(p.info?.websites ?? []), ...(p.info?.socials ?? [])]) if (l?.url) links.add(l.url);
        out.set(a.toLowerCase(), {
          chain,
          address: best.baseToken.address,
          symbol: best.baseToken.symbol ?? null,
          name: best.baseToken.name ?? null,
          url: best.url ?? null,
          liquidityUsd: mine.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0),
          volumeUsd: mine.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0),
          volumeH6: mine.reduce((s, p) => s + (p.volume?.h6 ?? 0), 0),
          mcapUsd: best.marketCap ?? best.fdv ?? null,
          pairCreatedAt: created.length ? Math.min(...created) : null,
          links: [...links],
        });
      }
    }
    return out;
  }
}

// ---- CoinGecko ----

export type GeckoMarket = { id: string; symbol: string; name: string; market_cap: number | null; total_volume: number | null };
export type GeckoCoin = {
  id: string;
  symbol: string;
  name: string;
  categories?: string[];
  platforms?: Record<string, string>;
  links?: { homepage?: string[]; repos_url?: { github?: string[] } };
  description?: { en?: string };
};

/** CoinGecko's chain names to DexScreener's. */
export const GECKO_CHAIN: Record<string, string> = { solana: "solana", base: "base", robinhood: "robinhood", ethereum: "ethereum", "arbitrum-one": "arbitrum", "binance-smart-chain": "bsc" };

export class CoinGecko {
  private readonly pace: Pace;
  /** coin pages this pass may still read, so one pass never holds up the hourly ones for long */
  private passLeft = Infinity;
  constructor(
    private readonly d: SourceDeps,
    perMin: number,
    private readonly detailsPerDay: number,
  ) {
    this.pace = new Pace(perMin, d.sleep, d.now);
  }

  /** Starts a pass that may read at most `max` new coin pages. */
  startPass(max: number) {
    this.passLeft = max;
  }

  private detailsToday(): number {
    const now = (this.d.now ?? Date.now)();
    return (this.d.db.prepare("SELECT count(*) AS n FROM source_calls WHERE source = 'coingecko-coin' AND at >= ?").get(now - DAY) as { n: number }).n;
  }

  /** One category's coins, by volume, one page (kept six hours). */
  async category(id: string, perPage = 250): Promise<GeckoMarket[]> {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${encodeURIComponent(id)}&order=volume_desc&per_page=${perPage}&page=1`;
    let r = await getJson<GeckoMarket[]>(this.d, "coingecko", url, this.pace, { cacheKey: `gecko:cat:${id}`, maxAgeMs: 6 * HOUR });
    if (r.status === 429) {
      // the free API's per-minute limit: one more try after a minute
      await this.backoff();
      r = await getJson<GeckoMarket[]>(this.d, "coingecko", url, this.pace, { cacheKey: `gecko:cat:${id}`, maxAgeMs: 6 * HOUR });
    }
    return Array.isArray(r.data) ? r.data : [];
  }

  private backoff() {
    return (this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(65_000);
  }

  /** Every coin's addresses per chain, in one call (kept a day). */
  async platforms(): Promise<Map<string, { symbol: string; name: string; platforms: Record<string, string> }>> {
    const r = await getJson<{ id: string; symbol: string; name: string; platforms?: Record<string, string> }[]>(this.d, "coingecko", "https://api.coingecko.com/api/v3/coins/list?include_platform=true", this.pace, { cacheKey: "gecko:list", maxAgeMs: DAY });
    return new Map((Array.isArray(r.data) ? r.data : []).map((c) => [c.id, { symbol: c.symbol?.toUpperCase(), name: c.name, platforms: c.platforms ?? {} }]));
  }

  /** A coin's page (links, addresses, categories), kept a week; null when the day's cap is reached and it is not kept. */
  async coin(id: string): Promise<GeckoCoin | null> {
    const k = `gecko:coin:${id}`;
    const c = cachedSource(this.d.db, k, 7 * DAY, (this.d.now ?? Date.now)());
    if (c) return c.body ? (JSON.parse(c.body) as GeckoCoin) : null;
    if (this.passLeft <= 0 || this.detailsToday() >= this.detailsPerDay) return null;
    this.passLeft--;
    const r = await getJson<GeckoCoin>(
      this.d,
      "coingecko-coin",
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
      this.pace,
      { cacheKey: k, maxAgeMs: 7 * DAY },
    );
    if (r.status === 429) {
      await this.backoff();
      const again = await getJson<GeckoCoin>(this.d, "coingecko-coin", `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, this.pace, { cacheKey: k, maxAgeMs: 7 * DAY });
      return again.data;
    }
    return r.data;
  }
}

// ---- a token's website and pump.fun ----

export class Websites {
  private readonly pace: Pace;
  constructor(
    private readonly d: SourceDeps,
    private readonly perDay: number,
  ) {
    this.pace = new Pace(20, d.sleep, d.now);
  }

  /** The page's HTML (256 KB at most), read once a week per site; null when over the day's cap or it fails. */
  async page(url: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol) || /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.|discord\.|instagram\.com|tiktok\.com|youtube\.com|medium\.com|linktr\.ee)$/i.test(u.hostname)) return null;
    // only public hosts: never an address inside a private network
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[|0\.)/.test(u.hostname) || !u.hostname.includes(".")) return null;
    const k = `site:${u.origin}`;
    const now = (this.d.now ?? Date.now)();
    const c = cachedSource(this.d.db, k, 7 * DAY, now);
    if (c) return c.body;
    const today = (this.d.db.prepare("SELECT count(*) AS n FROM source_calls WHERE source = 'website' AND at >= ?").get(now - DAY) as { n: number }).n;
    if (today >= this.perDay) return null;
    await this.pace.turn();
    let body: string | null = null;
    let status = 0;
    try {
      const res = await (this.d.fetchImpl ?? fetch)(u.origin + u.pathname, { headers: { "user-agent": "pushd-ranking", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
      status = res.status;
      if (res.ok && /text\/html|text\/plain/.test(res.headers.get("content-type") ?? "")) {
        const reader = res.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        while (reader && size < 262_144) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          size += value.length;
        }
        await reader?.cancel().catch(() => undefined);
        body = Buffer.concat(parts).toString("utf8").slice(0, 262_144);
      } else await res.body?.cancel().catch(() => undefined);
    } catch {
      body = null;
    }
    bookSource(this.d.db, "website", body != null, body?.length ?? 0, now);
    storeSource(this.d.db, k, status || 0, body, now);
    return body;
  }
}

/** pump.fun's coin page (links), when switched on. Its API usually answers a bot check; then nothing is asked again for a day. */
export async function pumpfunLinks(d: SourceDeps, mint: string): Promise<string[]> {
  const pace = new Pace(10, d.sleep, d.now);
  const now = (d.now ?? Date.now)();
  if (cachedSource(d.db, "pumpfun:blocked", DAY, now)) return [];
  const r = await getJson<{ website?: string; twitter?: string; telegram?: string }>(d, "pumpfun", `https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`, pace, { cacheKey: `pumpfun:${mint}`, maxAgeMs: 7 * DAY });
  if (r.status === 403) storeSource(d.db, "pumpfun:blocked", 403, null, now);
  return r.data ? [r.data.website, r.data.twitter].filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)) : [];
}
