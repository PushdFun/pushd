// GH Archive (data.gharchive.org): GitHub's public events, one gzip file an hour, free and outside the API's limits.
// An hour is streamed and counted as it arrives (nothing is kept on disk): for every event in a repo whose owner is in
// the pool, the kind of event, the repo, and the person behind it (bots left out). The archive is a sample of GitHub's
// public timeline (a few thousand events an hour lately, mostly pull requests, issues, stars and releases), so it is
// one signal of several; the daily pass reads commits through the search API.
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { DB } from "../db.ts";
import { isBot } from "./classify.ts";
import { bookSource } from "./store.ts";

export type GhaEvent = {
  type: string;
  actor?: { login?: string };
  repo?: { name?: string };
  created_at?: string;
  payload?: { action?: string; ref_type?: string; size?: number; distinct_size?: number; pull_request?: { merged?: boolean; merged_at?: string | null } };
};

/** The hour's file name: 2026-10-28-9 (GH Archive writes the hour without a leading zero). */
export const hourKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)}-${d.getUTCHours()}`;
};

/** What one event counts as, or null when it counts for nothing. */
export function kindOf(e: GhaEvent): { k: string; n: number; contributor: boolean } | null {
  const a = e.payload?.action;
  switch (e.type) {
    case "PushEvent":
      return { k: "commits", n: Math.max(1, Math.min(50, e.payload?.distinct_size ?? e.payload?.size ?? 1)), contributor: true };
    case "PullRequestEvent":
      if (a === "opened" || a === "reopened") return { k: "pr_open", n: 1, contributor: true };
      if (a === "closed" && (e.payload?.pull_request?.merged || e.payload?.pull_request?.merged_at)) return { k: "pr_merged", n: 1, contributor: true };
      if (a === "merged") return { k: "pr_merged", n: 1, contributor: true };
      return { k: "pr_other", n: 1, contributor: true };
    case "PullRequestReviewEvent":
    case "PullRequestReviewCommentEvent":
      return { k: "review", n: 1, contributor: true };
    case "IssuesEvent":
      return a === "opened" || a === "reopened" ? { k: "issue_open", n: 1, contributor: false } : { k: "issue_other", n: 1, contributor: false };
    case "IssueCommentEvent":
      return { k: "comment", n: 1, contributor: false };
    case "WatchEvent":
      return { k: "star", n: 1, contributor: false };
    case "ForkEvent":
      return { k: "fork", n: 1, contributor: false };
    case "ReleaseEvent":
      return a === "published" || a === "released" || !a ? { k: "release", n: 1, contributor: true } : null;
    case "CreateEvent":
      return e.payload?.ref_type === "tag" ? { k: "tag", n: 1, contributor: true } : e.payload?.ref_type === "repository" ? { k: "new_repo", n: 1, contributor: true } : null;
    default:
      return null;
  }
}

export type HourResult = { hour: string; status: number; events: number; kept: number; bytes: number; ms: number };

/** Adds up a stream of events into the store for the owners `want` names (lower case). */
export async function countEvents(db: DB, hour: string, lines: AsyncIterable<string>, want: (owner: string) => boolean): Promise<{ events: number; kept: number }> {
  const acts = new Map<string, number>();
  const actors = new Set<string>();
  const repos = new Map<string, number>();
  let events = 0;
  let kept = 0;
  const day = hour.slice(0, 10);
  for await (const line of lines) {
    if (!line) continue;
    events++;
    let e: GhaEvent;
    try {
      e = JSON.parse(line) as GhaEvent;
    } catch {
      continue;
    }
    const full = e.repo?.name ?? "";
    const owner = full.split("/")[0]?.toLowerCase();
    if (!owner || !want(owner)) continue;
    const actor = e.actor?.login ?? "";
    if (isBot(actor)) continue;
    const k = kindOf(e);
    if (!k) continue;
    kept++;
    acts.set(`${owner}\u0000${k.k}`, (acts.get(`${owner}\u0000${k.k}`) ?? 0) + k.n);
    if (k.contributor && actor) actors.add(`${owner}\u0000${actor.toLowerCase()}`);
    repos.set(`${owner}\u0000${full}`, (repos.get(`${owner}\u0000${full}`) ?? 0) + 1);
  }
  const tx = db.transaction(() => {
    const a = db.prepare("INSERT INTO act_hour (login, hour, k, n) VALUES (?, ?, ?, ?) ON CONFLICT(login, hour, k) DO UPDATE SET n = excluded.n");
    for (const [key, n] of acts) {
      const [o, k] = key.split("\u0000");
      a.run(o, hour, k, n);
    }
    const b = db.prepare("INSERT OR IGNORE INTO act_actor (login, day, actor) VALUES (?, ?, ?)");
    for (const key of actors) {
      const [o, who] = key.split("\u0000");
      b.run(o, day, who);
    }
    const c = db.prepare("INSERT INTO act_repo (login, repo, day, n) VALUES (?, ?, ?, ?) ON CONFLICT(login, repo, day) DO UPDATE SET n = n + excluded.n");
    for (const [key, n] of repos) {
      const [o, r] = key.split("\u0000");
      c.run(o, r, day, n);
    }
  });
  tx();
  return { events, kept };
}

/** Streams one hour from GH Archive and counts it. Never keeps the file. A missing hour (not out yet) is a 404. */
export async function processHour(db: DB, hour: string, want: (owner: string) => boolean, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<HourResult> {
  const t0 = now();
  let res: Response;
  try {
    res = await fetchImpl(`https://data.gharchive.org/${hour}.json.gz`, { headers: { "user-agent": "pushd-ranking" }, signal: AbortSignal.timeout(180_000) });
  } catch {
    bookSource(db, "gharchive", false, 0, t0);
    return { hour, status: 0, events: 0, kept: 0, bytes: 0, ms: now() - t0 };
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    bookSource(db, "gharchive", false, 0, t0);
    return { hour, status: res.status, events: 0, kept: 0, bytes: 0, ms: now() - t0 };
  }
  let bytes = 0;
  const raw = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  raw.on("data", (c: Buffer) => (bytes += c.length));
  const gunzip = raw.pipe(createGunzip());
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  let counted: { events: number; kept: number } = { events: 0, kept: 0 };
  let status = 200;
  try {
    counted = await countEvents(db, hour, rl, want);
  } catch {
    status = 502;
  }
  bookSource(db, "gharchive", status === 200, bytes, t0);
  const out = { hour, status, ...counted, bytes, ms: now() - t0 };
  db.prepare("INSERT INTO gha_hours (hour, events, kept, bytes, ms, at, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hour) DO UPDATE SET events = excluded.events, kept = excluded.kept, bytes = excluded.bytes, ms = excluded.ms, at = excluded.at, status = excluded.status").run(
    hour,
    out.events,
    out.kept,
    out.bytes,
    out.ms,
    now(),
    status,
  );
  return out;
}

/** The hours not read yet, newest first, from `back` hours ago up to the last full hour (a missing hour is tried again on the next pass). */
export function hoursToRead(db: DB, back: number, now = Date.now()): string[] {
  const done = new Set((db.prepare("SELECT hour FROM gha_hours WHERE status = 200").all() as { hour: string }[]).map((r) => r.hour));
  const out: string[] = [];
  for (let h = 1; h <= back; h++) {
    const k = hourKey(now - h * 3_600_000);
    if (!done.has(k)) out.push(k);
  }
  return out;
}
