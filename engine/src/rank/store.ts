// The ranking's tables: the candidate pool (one row per GitHub owner, with its token), the activity the public event
// archive showed, the rotation's state, history and log, and the measured calls to the outside sources.
import type { DB } from "../db.ts";
import type { GroupKey, RankToken } from "../types.ts";

export const RANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS pool (
  login TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  type TEXT,
  name TEXT,
  symbol TEXT,
  chain TEXT,
  address TEXT,
  dex_url TEXT,
  pair_created_at INTEGER,
  liquidity_usd REAL,
  volume_usd REAL,
  volume_h6 REAL,
  mcap_usd REAL,
  token_at INTEGER,
  repo TEXT,
  camp TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  why TEXT,
  followers INTEGER,
  followers_at INTEGER,
  gh TEXT,
  gh_at INTEGER,
  added_at INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS pool_status ON pool(status);
CREATE TABLE IF NOT EXISTS token_vol (login TEXT NOT NULL, day TEXT NOT NULL, volume REAL NOT NULL, PRIMARY KEY (login, day));
CREATE TABLE IF NOT EXISTS act_hour (login TEXT NOT NULL, hour TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (login, hour, k));
CREATE TABLE IF NOT EXISTS act_actor (login TEXT NOT NULL, day TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (login, day, actor));
CREATE TABLE IF NOT EXISTS act_repo (login TEXT NOT NULL, repo TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (login, repo, day));
CREATE TABLE IF NOT EXISTS gha_hours (hour TEXT PRIMARY KEY, events INTEGER, kept INTEGER, bytes INTEGER, ms INTEGER, at INTEGER, status INTEGER);
CREATE TABLE IF NOT EXISTS rank_state (
  login TEXT PRIMARY KEY,
  in_top INTEGER NOT NULL DEFAULT 0,
  entered_at INTEGER,
  left_at INTEGER,
  streak_in INTEGER NOT NULL DEFAULT 0,
  streak_out INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  score REAL,
  parts TEXT,
  top_repos TEXT,
  last_active TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS rank_history (at INTEGER NOT NULL, login TEXT NOT NULL, rank INTEGER NOT NULL, score REAL NOT NULL, PRIMARY KEY (at, login));
CREATE INDEX IF NOT EXISTS rank_history_login ON rank_history(login, at);
CREATE TABLE IF NOT EXISTS rank_log (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, login TEXT NOT NULL, change TEXT NOT NULL, rank INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rank_passes (at INTEGER PRIMARY KEY, kind TEXT NOT NULL, pool INTEGER NOT NULL, eligible INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS source_calls (at INTEGER NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS source_calls_at ON source_calls(at, source);
CREATE TABLE IF NOT EXISTS source_cache (k TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT, at INTEGER NOT NULL);
`;

export const ensureRankSchema = (db: DB) => db.exec(RANK_SCHEMA);

/** What the deep pass read of an owner on GitHub (the search API): its repos and its commits. */
export type GhRead = {
  type: "user" | "org";
  display: string;
  repos: { name: string; stars: number; forks: number; createdAt: string; pushedAt: string | null; fork: boolean; archived: boolean; size: number; description: string | null; topics: string[]; language: string | null; template: boolean }[];
  /** commits on its repos: in the last day, week and 30 days, and their distinct authors */
  commits: { d1: number; d7: number; d30: number; authors7: number; authors30: number; total30: number };
  pushedAt: string | null;
  readAt: number;
};

export type PoolRow = {
  login: string;
  display: string;
  type: "user" | "org" | null;
  name: string | null;
  symbol: string | null;
  chain: string | null;
  address: string | null;
  dex_url: string | null;
  pair_created_at: number | null;
  liquidity_usd: number | null;
  volume_usd: number | null;
  volume_h6: number | null;
  mcap_usd: number | null;
  token_at: number | null;
  repo: string | null;
  camp: GroupKey;
  categories: string;
  description: string | null;
  sources: string;
  status: "new" | "ok" | "out";
  why: string | null;
  followers: number | null;
  followers_at: number | null;
  gh: string | null;
  gh_at: number | null;
  added_at: number;
  checked_at: number | null;
};

export const poolRow = (db: DB, login: string) => (db.prepare("SELECT * FROM pool WHERE login = ?").get(login.toLowerCase()) as PoolRow | undefined) ?? null;

export function ghRead(r: Pick<PoolRow, "gh">): GhRead | null {
  if (!r.gh) return null;
  try {
    return JSON.parse(r.gh) as GhRead;
  } catch {
    return null;
  }
}

export function tokenOf(r: PoolRow, now = Date.now()): RankToken | null {
  if (!r.chain || !r.address) return null;
  return {
    symbol: r.symbol,
    name: r.name,
    chain: r.chain,
    address: r.address,
    url: r.dex_url,
    pairDays: r.pair_created_at ? Math.floor((now - r.pair_created_at) / 86_400_000) : null,
    liquidityUsd: r.liquidity_usd,
    volumeUsd: r.volume_usd,
    readAt: r.token_at ? new Date(r.token_at).toISOString() : null,
  };
}

/** Books one call to an outside source (DexScreener, CoinGecko, a website, the event archive). */
export function bookSource(db: DB, source: string, ok: boolean, bytes = 0, at = Date.now()) {
  db.prepare("INSERT INTO source_calls (at, source, ok, bytes) VALUES (?, ?, ?, ?)").run(at, source, ok ? 1 : 0, bytes);
}

export function sourceCalls(db: DB, since: number): { source: string; calls: number; failed: number; bytes: number }[] {
  return db.prepare("SELECT source, count(*) AS calls, sum(1 - ok) AS failed, sum(bytes) AS bytes FROM source_calls WHERE at >= ? GROUP BY source ORDER BY source").all(since) as { source: string; calls: number; failed: number; bytes: number }[];
}

export function cachedSource(db: DB, k: string, maxAgeMs: number, now = Date.now()): { status: number; body: string | null } | null {
  const r = db.prepare("SELECT status, body, at FROM source_cache WHERE k = ?").get(k) as { status: number; body: string | null; at: number } | undefined;
  return r && now - r.at < maxAgeMs ? { status: r.status, body: r.body } : null;
}

export function storeSource(db: DB, k: string, status: number, body: string | null, at = Date.now()) {
  db.prepare("INSERT INTO source_cache (k, status, body, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET status = excluded.status, body = excluded.body, at = excluded.at").run(k, status, body, at);
}
