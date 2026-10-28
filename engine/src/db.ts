// The store: one sqlite file (data/pushd.sqlite, never committed). Everything the watcher saw, every line it made,
// the catches log (never edited after it is written), the HTTP cache for conditional requests, the cost log, and the
// queue of repo preview pictures (src/media.ts; the pictures themselves are files in data/media).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CostEntry } from "./summary.ts";
import type { FeedItem, GroupKey, Heat, Kind, Signal } from "./types.ts";

export type DB = Database.Database;

export const HEAT_RANK: Record<Heat, number> = { low: 1, medium: 2, high: 3, veryHigh: 4 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  handle TEXT PRIMARY KEY,
  baseline_at TEXT,
  history_since TEXT,
  next_due_at INTEGER NOT NULL DEFAULT 0,
  polls INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  last_status INTEGER
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  fork INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repos_handle ON repos(handle, created_at);
CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  type TEXT NOT NULL,
  repo TEXT,
  github_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  verdict TEXT,
  item_id TEXT
);
CREATE INDEX IF NOT EXISTS events_handle ON events(handle, github_at);
CREATE INDEX IF NOT EXISTS events_repo ON events(repo, type, github_at);
CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL,
  group_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  version TEXT,
  summary TEXT NOT NULL,
  summary_source TEXT NOT NULL,
  heat TEXT NOT NULL,
  heat_rank INTEGER NOT NULL,
  score INTEGER NOT NULL,
  signals TEXT NOT NULL,
  github_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  url TEXT,
  backfill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_shown ON items(shown_at);
CREATE INDEX IF NOT EXISTS items_github ON items(github_at);
CREATE TABLE IF NOT EXISTS catches (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  heat TEXT NOT NULL,
  score INTEGER NOT NULL,
  github_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  url TEXT,
  item TEXT NOT NULL,
  logged_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS catches_no_update BEFORE UPDATE ON catches BEGIN SELECT RAISE(ABORT, 'the catches log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS catches_no_delete BEFORE DELETE ON catches BEGIN SELECT RAISE(ABORT, 'the catches log is append-only'); END;
CREATE TABLE IF NOT EXISTS costs (
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  usd REAL NOT NULL,
  ref TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  file TEXT,
  content_type TEXT,
  bytes INTEGER,
  queued_at TEXT NOT NULL,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS media_due ON media(status, next_try_at);
CREATE TABLE IF NOT EXISTS media_tries (at INTEGER NOT NULL);
-- extra facts about a line's repo for its page (src/enrich.ts): the README's first lines, the repo's facts, a push's
-- commits, a release's notes, a gist's text. Keyed "readme:owner/name", "commits:owner/name@sha" and so on; status is
-- the HTTP status of the fetch (a 404 is kept too, so it is not asked again for a day)
CREATE TABLE IF NOT EXISTS gh_extra (
  k TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_extra_tries (at INTEGER NOT NULL, api INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_github ON events(github_at);
-- builders' GitHub pictures (src/avatars.ts), fetched at most once a week each
CREATE TABLE IF NOT EXISTS avatars (
  handle TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  file TEXT,
  content_type TEXT,
  fetched_at INTEGER NOT NULL
);
-- $PUSHD (src/token): the burn pot's Burned events as read from its logs, newest kept; how far they were read and
-- the keeper's numbers live in meta (token_scan, keeper)
CREATE TABLE IF NOT EXISTS token_burns (
  n INTEGER PRIMARY KEY,
  tx TEXT NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  eth TEXT NOT NULL
);
-- holder sign-in (src/token/holders.ts): single-use messages, sessions (only a hash of the token is kept), each
-- wallet's last read balance, and a holder's own watchlist and alert choices. Addresses in lower case.
CREATE TABLE IF NOT EXISTS holder_challenges (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS holder_sessions (
  id_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS holder_sessions_address ON holder_sessions(address);
CREATE TABLE IF NOT EXISTS holder_balances (
  address TEXT PRIMARY KEY,
  wei TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
-- every GitHub API request, booked to the part of PUSHD that made it (src/plan.ts): the measured spend per hour
CREATE TABLE IF NOT EXISTS gh_spend (
  at INTEGER NOT NULL,
  part TEXT NOT NULL,
  resource TEXT NOT NULL,
  free INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS gh_spend_at ON gh_spend(at, part);
CREATE TABLE IF NOT EXISTS holder_prefs (
  address TEXT PRIMARY KEY,
  follow TEXT NOT NULL,
  mute TEXT NOT NULL,
  alert_heat TEXT NOT NULL,
  alert_mine INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // added later: the scouts a holder follows (src/scouts)
  const cols = (db.prepare("PRAGMA table_info(holder_prefs)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("scouts")) db.exec("ALTER TABLE holder_prefs ADD COLUMN scouts TEXT NOT NULL DEFAULT '[]'");
  // added later: lines of accounts that left the watch set without a token (the old hand-made list) stay stored, out of view
  const icols = (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name);
  if (!icols.includes("hidden")) db.exec("ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  return db;
}

// ---- items ----

/** A line as stored: the site's shape plus what the engine keeps for itself. */
export type StoredItem = {
  id: string;
  key: string;
  handle: string;
  group: GroupKey;
  kind: Kind;
  repo: string;
  version?: string;
  summary: string;
  summarySource: "ai" | "fallback";
  heat: Heat;
  score: number;
  signals: Signal[];
  githubAt: string;
  seenAt: string;
  shownAt: string;
  url: string | null;
  backfill: boolean;
};

type Row = {
  seq: number;
  id: string;
  key: string;
  handle: string;
  group_key: GroupKey;
  kind: Kind;
  repo: string;
  version: string | null;
  summary: string;
  summary_source: "ai" | "fallback";
  heat: Heat;
  score: number;
  signals: string;
  github_at: string;
  seen_at: string;
  shown_at: string;
  url: string | null;
  backfill: number;
};

const toStored = (r: Row): StoredItem & { seq: number } => ({
  seq: r.seq,
  id: r.id,
  key: r.key,
  handle: r.handle,
  group: r.group_key,
  kind: r.kind,
  repo: r.repo,
  ...(r.version ? { version: r.version } : {}),
  summary: r.summary,
  summarySource: r.summary_source,
  heat: r.heat,
  score: r.score,
  signals: JSON.parse(r.signals) as Signal[],
  githubAt: r.github_at,
  seenAt: r.seen_at,
  shownAt: r.shown_at,
  url: r.url,
  backfill: !!r.backfill,
});

/** Stores a line once; a second line with the same key is ignored. Returns true when it was new. */
export function insertItem(db: DB, it: StoredItem): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO items (id, key, handle, group_key, kind, repo, version, summary, summary_source, heat, heat_rank, score, signals, github_at, seen_at, shown_at, url, backfill)
       VALUES (@id, @key, @handle, @group, @kind, @repo, @version, @summary, @summarySource, @heat, @heatRank, @score, @signals, @githubAt, @seenAt, @shownAt, @url, @backfill)`,
    )
    .run({
      ...it,
      version: it.version ?? null,
      heatRank: HEAT_RANK[it.heat],
      signals: JSON.stringify(it.signals),
      backfill: it.backfill ? 1 : 0,
    });
  if (res.changes === 0) return false;
  if (HEAT_RANK[it.heat] >= HEAT_RANK.high) logCatch(db, it);
  return true;
}

/** A catch: high heat and up. Written once, never edited (the table refuses updates and deletes). */
function logCatch(db: DB, it: StoredItem) {
  db.prepare(
    `INSERT OR IGNORE INTO catches (id, handle, kind, repo, heat, score, github_at, seen_at, shown_at, url, item, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(it.id, it.handle, it.kind, it.repo, it.heat, it.score, it.githubAt, it.seenAt, it.shownAt, it.url, JSON.stringify(it), new Date().toISOString());
}

export type ItemQuery = {
  /** only lines shown at or before this time (the public delay) */
  shownBefore?: string;
  /** only lines shown after this time (the stream) */
  shownAfter?: string;
  group?: GroupKey;
  minHeat?: Heat;
  handle?: string;
  limit?: number;
  /** lines kept out of view (an account that left without a token) too */
  withHidden?: boolean;
};

export function queryItems(db: DB, q: ItemQuery = {}): (StoredItem & { seq: number })[] {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  const add = (sql: string, name: string, value: unknown) => {
    where.push(sql);
    args[name] = value;
  };
  if (q.shownBefore) add("shown_at <= @shownBefore", "shownBefore", q.shownBefore);
  if (q.shownAfter) add("shown_at > @shownAfter", "shownAfter", q.shownAfter);
  if (q.group) add("group_key = @group", "group", q.group);
  if (q.minHeat) add("heat_rank >= @rank", "rank", HEAT_RANK[q.minHeat]);
  if (q.handle) add("lower(handle) = lower(@handle)", "handle", q.handle.replace(/^@/, ""));
  if (!q.withHidden) where.push("hidden = 0");
  args.limit = Math.max(1, Math.min(500, q.limit ?? 100));
  const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY github_at DESC, seq DESC LIMIT @limit`;
  return (db.prepare(sql).all(args) as Row[]).map(toStored);
}

/** Lines stored after a sequence number, in the order they were stored (the stream's cursor). */
export function itemsAfterSeq(db: DB, seq: number, limit = 200) {
  return (db.prepare("SELECT * FROM items WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(seq, limit) as Row[]).map(toStored);
}

/** The last line stored that was shown at or before a moment (where a new stream starts). */
export function lastSeqShownBy(db: DB, at: string): number {
  return (db.prepare("SELECT coalesce(max(seq), 0) AS s FROM items WHERE shown_at <= ?").get(at) as { s: number }).s;
}

/**
 * Keeps the lines of accounts that are no longer watched and have no token out of view (the old hand-made list): the
 * public feed shows token projects only. `keep`: the handles that stay in view (every project in the pool).
 */
export function hideOutside(db: DB, keep: (handle: string) => boolean): number {
  const handles = (db.prepare("SELECT DISTINCT handle FROM items WHERE hidden = 0").all() as { handle: string }[]).map((r) => r.handle);
  let n = 0;
  for (const h of handles) if (!keep(h)) n += db.prepare("UPDATE items SET hidden = 1 WHERE handle = ?").run(h).changes;
  return n;
}

export function isHidden(db: DB, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM items WHERE id = ? AND hidden = 1").get(id);
}

export function getItemById(db: DB, id: string) {
  const r = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
  return r ? toStored(r) : null;
}

export function getItemByKey(db: DB, key: string) {
  const r = db.prepare("SELECT * FROM items WHERE key = ?").get(key) as Row | undefined;
  return r ? toStored(r) : null;
}

export type CatchRow = StoredItem & { loggedAt: string };

export function queryCatches(db: DB, shownBefore?: string, limit = 200): CatchRow[] {
  const rows = db
    .prepare(`SELECT item, logged_at FROM catches WHERE id NOT IN (SELECT id FROM items WHERE hidden = 1) ${shownBefore ? "AND shown_at <= @shownBefore" : ""} ORDER BY shown_at DESC LIMIT @limit`)
    .all({ shownBefore, limit: Math.max(1, Math.min(1000, limit)) }) as { item: string; logged_at: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.item) as StoredItem), loggedAt: r.logged_at }));
}

// ---- events (dedup) ----

export function seenEvent(db: DB, key: string): boolean {
  return !!db.prepare("SELECT 1 FROM events WHERE key = ?").get(key);
}

export function recordEvent(
  db: DB,
  e: { key: string; handle: string; type: string; repo: string | null; githubAt: string; seenAt: string; verdict?: string | null; itemId?: string | null },
): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO events (key, handle, type, repo, github_at, seen_at, verdict, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(e.key, e.handle, e.type, e.repo, e.githubAt, e.seenAt, e.verdict ?? null, e.itemId ?? null);
  return r.changes > 0;
}

export function setVerdict(db: DB, key: string, verdict: string, itemId: string | null = null) {
  db.prepare("UPDATE events SET verdict = ?, item_id = ? WHERE key = ?").run(verdict, itemId, key);
}

/** The account's latest public activity before a moment. */
export function prevActivity(db: DB, handle: string, before: string): string | null {
  const r = db.prepare("SELECT max(github_at) AS t FROM events WHERE handle = ? AND github_at < ? AND key NOT LIKE 'repo:%' AND key NOT LIKE 'gist:%'").get(handle, before) as { t: string | null };
  return r.t;
}

/** The latest push to a repo before a moment, from what the watcher has seen. */
export function prevPush(db: DB, fullName: string, before: string): string | null {
  const r = db.prepare("SELECT max(github_at) AS t FROM events WHERE repo = ? AND type = 'push' AND github_at < ?").get(fullName, before) as { t: string | null };
  return r.t;
}

// ---- repos ----

export type RepoRow = { id: number; handle: string; name: string; full_name: string; created_at: string; pushed_at: string | null; fork: number; default_branch: string | null };

export function knownRepo(db: DB, id: number): RepoRow | null {
  return (db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined) ?? null;
}

export function repoByName(db: DB, fullName: string): RepoRow | null {
  return (db.prepare("SELECT * FROM repos WHERE lower(full_name) = lower(?)").get(fullName) as RepoRow | undefined) ?? null;
}

export function upsertRepo(db: DB, r: Omit<RepoRow, "fork"> & { fork: boolean }, seenAt: string) {
  db.prepare(
    `INSERT INTO repos (id, handle, name, full_name, created_at, pushed_at, fork, default_branch, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, full_name = excluded.full_name, pushed_at = excluded.pushed_at, default_branch = excluded.default_branch`,
  ).run(r.id, r.handle, r.name, r.full_name, r.created_at, r.pushed_at, r.fork ? 1 : 0, r.default_branch, seenAt);
}

/** When the account's previous own repo (not a fork) was created, before a moment. */
export function prevRepoCreated(db: DB, handle: string, before: string, exceptFullName: string): string | null {
  const r = db
    .prepare("SELECT max(created_at) AS t FROM repos WHERE handle = ? AND fork = 0 AND created_at < ? AND lower(full_name) <> lower(?)")
    .get(handle, before, exceptFullName) as { t: string | null };
  return r.t;
}

// ---- accounts (the schedule) ----

export type AccountRow = { handle: string; baseline_at: string | null; history_since: string | null; next_due_at: number; polls: number; last_poll_at: string | null; last_status: number | null };

export function account(db: DB, handle: string): AccountRow {
  db.prepare("INSERT OR IGNORE INTO accounts (handle) VALUES (?)").run(handle);
  return db.prepare("SELECT * FROM accounts WHERE handle = ?").get(handle) as AccountRow;
}

export function updateAccount(db: DB, handle: string, patch: Partial<Omit<AccountRow, "handle">>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE handle = @handle`).run({ ...patch, handle });
}

// ---- the GitHub spend book (src/plan.ts) ----

export function bookSpend(db: DB, part: string, resource: "core" | "search", free: boolean, at = Date.now()) {
  db.prepare("INSERT INTO gh_spend (at, part, resource, free) VALUES (?, ?, ?, ?)").run(at, part, resource, free ? 1 : 0);
}

/** Requests booked since a moment: per part and resource, the counted ones and the free 304s apart. */
export function spendSince(db: DB, since: number): { part: string; resource: string; n: number; free: number }[] {
  return db.prepare("SELECT part, resource, sum(1 - free) AS n, sum(free) AS free FROM gh_spend WHERE at >= ? GROUP BY part, resource ORDER BY part").all(since) as { part: string; resource: string; n: number; free: number }[];
}

/** Counted (not 304) requests one part made since a moment. */
export function spentBy(db: DB, part: string, since: number, resource: "core" | "search" = "core"): number {
  return (db.prepare("SELECT count(*) AS n FROM gh_spend WHERE part = ? AND resource = ? AND free = 0 AND at >= ?").get(part, resource, since) as { n: number }).n;
}

export function pruneSpend(db: DB, before: number) {
  db.prepare("DELETE FROM gh_spend WHERE at < ?").run(before);
}

// ---- http cache, costs, meta ----

export function cached(db: DB, url: string): { etag: string | null; body: string } | null {
  return (db.prepare("SELECT etag, body FROM http_cache WHERE url = ?").get(url) as { etag: string | null; body: string } | undefined) ?? null;
}

export function storeCache(db: DB, url: string, etag: string | null, body: string) {
  db.prepare("INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at").run(
    url,
    etag,
    body,
    new Date().toISOString(),
  );
}

export function logCost(db: DB, c: CostEntry) {
  db.prepare("INSERT INTO costs (at, provider, model, input_tokens, output_tokens, usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?)").run(c.at, c.provider, c.model, c.inputTokens, c.outputTokens, c.usd, c.ref);
}

export function totalCost(db: DB): { calls: number; usd: number } {
  return db.prepare("SELECT count(*) AS calls, coalesce(sum(usd), 0) AS usd FROM costs").get() as { calls: number; usd: number };
}

export function setMeta(db: DB, k: string, v: string) {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export function getMeta(db: DB, k: string): string | null {
  return (db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v ?? null;
}

/** The site's shape for a stored line. `mediaUrl`: the API path of the repo's preview picture, when it is stored. */
export function toFeedItem(it: StoredItem, who: { name?: string; org?: string } | undefined, mediaUrl: string | null = null): FeedItem {
  return {
    id: it.id,
    handle: it.handle,
    ...(who?.name ? { name: who.name } : {}),
    ...(who?.org ? { org: who.org } : {}),
    group: it.group,
    kind: it.kind,
    repo: it.repo,
    ...(it.version ? { version: it.version } : {}),
    summary: it.summary,
    heat: it.heat,
    score: it.score,
    signals: it.signals,
    githubAt: it.githubAt,
    shownAt: it.shownAt,
    url: it.url,
    mediaUrl,
    sample: false,
    // seen on the watcher's first look at the account, after it happened: its shownAt says nothing about speed
    ...(it.backfill ? { backfill: true } : {}),
  };
}

// ---- extra repo facts (src/enrich.ts) ----

export type Extra = { status: number; body: string | null; fetchedAt: number };

export function getExtra(db: DB, k: string): Extra | null {
  const r = db.prepare("SELECT status, body, fetched_at FROM gh_extra WHERE k = ?").get(k) as { status: number; body: string | null; fetched_at: number } | undefined;
  return r ? { status: r.status, body: r.body, fetchedAt: r.fetched_at } : null;
}

export function setExtra(db: DB, k: string, status: number, body: string | null, at = Date.now()) {
  db.prepare("INSERT INTO gh_extra (k, status, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at").run(k, status, body, at);
}
