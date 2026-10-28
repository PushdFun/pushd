// Settings, all from the environment (or engine/.env when it exists). Nothing here is required to run locally.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupKey, WatchEntry } from "./types.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envFile = join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const num = (v: string | undefined, d: number) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * The GitHub token: PUSHD_GITHUB_TOKEN, else (local runs only) the file ~/.pushd-github-token when it exists. Never
 * logged, never written anywhere. Tests hand in an empty environment and no file.
 */
export function githubTokenFrom(env: Record<string, string | undefined> = process.env, file: string | null = join(homedir(), ".pushd-github-token")): string | null {
  const v = env.PUSHD_GITHUB_TOKEN?.trim();
  if (v) return v;
  if (!file || !existsSync(file)) return null;
  try {
    const t = readFileSync(file, "utf8").trim();
    return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export const config = {
  dbPath: process.env.PUSHD_DB?.trim() || join(ROOT, "data", "pushd.sqlite"),
  watchlistPath: process.env.PUSHD_WATCHLIST?.trim() || join(ROOT, "data", "watchlist.json"),
  githubToken: githubTokenFrom(),
  /** the store of holders' added accounts' lines (kept apart from the public feed) */
  extrasDbPath: process.env.PUSHD_EXTRAS_DB?.trim() || join(ROOT, "data", "extras.sqlite"),
  /** the admin key (x-pushd-admin-key): the suggestions inbox and the internal status. Off when empty. */
  adminKey: process.env.PUSHD_ADMIN_KEY?.trim() || null,
  openRouterKey: process.env.PUSHD_OPENROUTER_KEY?.trim() || null,
  openRouterModel: process.env.PUSHD_OPENROUTER_MODEL?.trim() || undefined,
  port: num(process.env.PUSHD_ENGINE_PORT, 3701),
  host: process.env.PUSHD_ENGINE_HOST?.trim() || "127.0.0.1",
  liveKey: process.env.PUSHD_LIVE_KEY?.trim() || null,
  publicDelayMinutes: num(process.env.PUSHD_PUBLIC_DELAY_MINUTES, 5),
  /** on the first look at an account, lines from this many hours back still go in the feed (marked as backfill) */
  backfillHours: num(process.env.PUSHD_BACKFILL_HOURS, 48),
  /** repo preview pictures: where they are kept, how many fetches an hour at most, and an off switch */
  mediaDir: process.env.PUSHD_MEDIA_DIR?.trim() || join(ROOT, "data", "media"),
  mediaPerHour: num(process.env.PUSHD_MEDIA_PER_HOUR, 30),
  media: (process.env.PUSHD_MEDIA?.trim().toLowerCase() ?? "on") !== "off",
  /** an item's page: fetch what is not stored (README, repo facts, commits); off = stored data only */
  enrich: (process.env.PUSHD_ENRICH?.trim().toLowerCase() ?? "on") !== "off",
  /** API requests an hour for that, at most (default: 6 without a token, 300 with one) */
  enrichPerHour: process.env.PUSHD_ENRICH_PER_HOUR?.trim() ? num(process.env.PUSHD_ENRICH_PER_HOUR, 6) : undefined,
  /** the watched accounts' GitHub pictures; off = the site draws initials */
  avatars: (process.env.PUSHD_AVATARS?.trim().toLowerCase() ?? "on") !== "off",
};

export const GROUP_KEYS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];

export type Watchlist = { verifiedAt: string; accounts: WatchEntry[] };

/** Reads and checks data/watchlist.json: every entry complete, no handle twice. */
export function loadWatchlist(path = config.watchlistPath): Watchlist {
  const wl = JSON.parse(readFileSync(path, "utf8")) as Watchlist;
  const seen = new Set<string>();
  for (const e of wl.accounts) {
    for (const k of ["handle", "name", "org", "group", "type", "source"] as const)
      if (!e[k] || typeof e[k] !== "string") throw new Error(`watchlist: ${e.handle ?? "?"} has no ${k}`);
    if (!GROUP_KEYS.includes(e.group)) throw new Error(`watchlist: ${e.handle} has an unknown group ${e.group}`);
    if (e.type !== "user" && e.type !== "org") throw new Error(`watchlist: ${e.handle} has an unknown type ${e.type}`);
    const k = e.handle.toLowerCase();
    if (seen.has(k)) throw new Error(`watchlist: ${e.handle} is on it twice`);
    seen.add(k);
  }
  return wl;
}
