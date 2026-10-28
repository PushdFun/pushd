// Repo preview pictures: GitHub's own share picture for a repo (opengraph.githubassets.com), fetched once, server side,
// kept on disk (data/media, never committed) and served by the API at /v1/media/:id with long cache headers. The site
// shows it on the repo's card; without one it draws its own card, so a missing picture is never a broken one.
//
// GitHub rate-limits that service (it answered 429 on 28 Oct 2026), so every fetch goes through this queue: one at a
// time, a repo only once however many lines point at it, a cap per hour, a pause after a 429 (Retry-After when GitHub
// sends one, otherwise a wait that doubles with every 429 in a row), and a later retry for anything that failed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, setMeta, type DB } from "./db.ts";

export const OG_HOST = "https://opengraph.githubassets.com";

/** The picture's id: a hash of the repo's full name, so the URL says nothing and two spellings are one picture. */
export const mediaId = (fullName: string) => createHash("sha256").update(fullName.toLowerCase()).digest("hex").slice(0, 24);
export const MEDIA_ID = /^[a-f0-9]{24}$/;

/** owner/repo for a line about a repo (new repo, push, release); null for a gist or a line with no GitHub link. */
export function repoOfItem(it: { kind: string; url: string | null }): string | null {
  if (it.kind === "gist" || !it.url) return null;
  const m = it.url.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)(?:[/?#]|$)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export type MediaRow = {
  id: string;
  full_name: string;
  status: "queued" | "done" | "missing" | "failed";
  attempts: number;
  next_try_at: number;
  last_status: number | null;
  file: string | null;
  content_type: string | null;
  bytes: number | null;
  queued_at: string;
  fetched_at: string | null;
};

/** A stored picture, when there is one. */
export function mediaDone(db: DB, id: string): MediaRow | null {
  return (db.prepare("SELECT * FROM media WHERE id = ? AND status = 'done'").get(id) as MediaRow | undefined) ?? null;
}

/** The API path of a line's picture, or null while there is none. */
export function mediaUrlFor(db: DB, it: { kind: string; url: string | null }): string | null {
  const full = repoOfItem(it);
  if (!full) return null;
  const id = mediaId(full);
  return mediaDone(db, id) ? `/v1/media/${id}` : null;
}

export type StepResult = "idle" | "paused" | "capped" | "fetched" | "missing" | "retry" | "failed" | "rate-limited";

export type MediaOptions = {
  db: DB;
  /** where the pictures go */
  dir: string;
  /** fetches at most this many an hour (every try counts, a 429 too) */
  perHour?: number;
  /** the gap between two fetches */
  minGapMs?: number;
  /** the first pause after a 429 with no Retry-After; it doubles with each 429 in a row */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** a picture that fails this many times (not counting 429s) is given up on; the site draws its card */
  maxAttempts?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
};

const HOUR = 3_600_000;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Does the file start like the picture type it claims? */
function looksLike(type: string, b: Buffer): boolean {
  if (type === "image/png") return b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/gif") return b.length > 6 && b.subarray(0, 4).toString("latin1") === "GIF8";
  if (type === "image/webp") return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export class MediaQueue {
  private readonly o: Required<Omit<MediaOptions, "log">> & { log: (msg: string) => void };
  private stopped = false;
  private wake: (() => void) | null = null;
  /** fetches made by this queue (for the logs and the tests) */
  fetches = 0;

  constructor(o: MediaOptions) {
    this.o = {
      db: o.db,
      dir: o.dir,
      perHour: o.perHour ?? 30,
      minGapMs: o.minGapMs ?? 20_000,
      backoffMs: o.backoffMs ?? 10 * 60_000,
      maxBackoffMs: o.maxBackoffMs ?? 6 * HOUR,
      maxAttempts: o.maxAttempts ?? 5,
      maxBytes: o.maxBytes ?? 3 * 1024 * 1024,
      fetchImpl: o.fetchImpl ?? fetch,
      now: o.now ?? Date.now,
      log: o.log ?? (() => {}),
    };
  }

  /** Puts a repo in the queue, once: a second call for the same repo (any case) changes nothing. Returns its id. */
  enqueue(fullName: string): string {
    const id = mediaId(fullName);
    const r = this.o.db
      .prepare("INSERT OR IGNORE INTO media (id, full_name, status, attempts, next_try_at, queued_at) VALUES (?, ?, 'queued', 0, 0, ?)")
      .run(id, fullName, new Date(this.o.now()).toISOString());
    if (r.changes) this.wake?.();
    return id;
  }

  /** Queues the repo of a line, when it is about one. */
  enqueueItem(it: { kind: string; url: string | null }): string | null {
    const full = repoOfItem(it);
    return full ? this.enqueue(full) : null;
  }

  /** Queues the repos of every line already in the store (lines from before the queue existed). */
  enqueueExisting(): number {
    let n = 0;
    for (const it of this.o.db.prepare("SELECT kind, url FROM items").all() as { kind: string; url: string | null }[]) {
      const full = repoOfItem(it);
      if (full && this.o.db.prepare("SELECT 1 FROM media WHERE id = ?").get(mediaId(full)) == null) {
        this.enqueue(full);
        n++;
      }
    }
    return n;
  }

  /** Until when everything waits after a 429 (ms since epoch; 0 when not paused). */
  get pausedUntil(): number {
    return Number(getMeta(this.o.db, "media_paused_until") ?? 0);
  }

  /** How many 429s in a row: the next pause is backoffMs * 2^this. */
  private get level(): number {
    return Number(getMeta(this.o.db, "media_backoff_level") ?? 0);
  }

  /** The tries in the last hour, oldest first (old ones are pruned). */
  private triesInHour(): number[] {
    const since = this.o.now() - HOUR;
    this.o.db.prepare("DELETE FROM media_tries WHERE at <= ?").run(since);
    return (this.o.db.prepare("SELECT at FROM media_tries ORDER BY at ASC").all() as { at: number }[]).map((r) => r.at);
  }

  private next(): MediaRow | null {
    return (this.o.db.prepare("SELECT * FROM media WHERE status = 'queued' AND next_try_at <= ? ORDER BY next_try_at ASC, queued_at ASC LIMIT 1").get(this.o.now()) as MediaRow | undefined) ?? null;
  }

  private set(id: string, patch: Partial<MediaRow>) {
    const keys = Object.keys(patch);
    this.o.db.prepare(`UPDATE media SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
  }

  /** A failed try that is not a 429: try again later (the wait doubles), or give up after maxAttempts. */
  private failed(row: MediaRow, status: number | null, why: string): StepResult {
    const attempts = row.attempts + 1;
    if (attempts >= this.o.maxAttempts) {
      this.set(row.id, { status: "failed", attempts, last_status: status });
      this.o.log(`media: gave up on ${row.full_name} after ${attempts} tries (${why}); the site draws its card`);
      return "failed";
    }
    this.set(row.id, { attempts, last_status: status, next_try_at: this.o.now() + Math.min(this.o.maxBackoffMs, this.o.backoffMs * 2 ** (attempts - 1)) });
    return "retry";
  }

  /** At most one fetch: the most overdue queued repo, if the pause and the hourly cap allow it. */
  async step(): Promise<StepResult> {
    const now = this.o.now();
    if (this.pausedUntil > now) return "paused";
    if (this.triesInHour().length >= this.o.perHour) return "capped";
    const row = this.next();
    if (!row) return "idle";

    this.o.db.prepare("INSERT INTO media_tries (at) VALUES (?)").run(now);
    this.fetches++;
    let res: Response;
    try {
      res = await this.o.fetchImpl(`${OG_HOST}/pushd/${row.full_name}`, {
        headers: { "user-agent": "pushd-watcher", accept: "image/png,image/*" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return this.failed(row, null, (e as Error).message);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(this.o.maxBackoffMs, retryAfter > 0 ? retryAfter * 1000 : this.o.backoffMs * 2 ** this.level);
      const until = this.o.now() + wait;
      setMeta(this.o.db, "media_paused_until", String(until));
      setMeta(this.o.db, "media_backoff_level", String(this.level + 1));
      // a 429 is about the service, not the picture: the repo keeps its place and its tries
      this.set(row.id, { last_status: 429, next_try_at: until });
      await res.body?.cancel();
      this.o.log(`media: GitHub's picture service said 429; pausing ${Math.ceil(wait / 1000)} s`);
      return "rate-limited";
    }
    if (res.status === 404 || res.status === 410) {
      this.set(row.id, { status: "missing", last_status: res.status });
      await res.body?.cancel();
      return "missing";
    }
    if (!res.ok) {
      await res.body?.cancel();
      return this.failed(row, res.status, `status ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) {
      await res.body?.cancel();
      return this.failed(row, res.status, `not a picture (${type || "no type"})`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > this.o.maxBytes) return this.failed(row, res.status, `too big (${body.length} bytes)`);
    if (!looksLike(type, body)) return this.failed(row, res.status, "the bytes are not the picture type it says");

    mkdirSync(this.o.dir, { recursive: true });
    const file = `${row.id}.${ext}`;
    const tmp = join(this.o.dir, `.${file}.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(this.o.dir, file));
    this.set(row.id, { status: "done", last_status: res.status, file, content_type: type, bytes: body.length, fetched_at: new Date(this.o.now()).toISOString() });
    setMeta(this.o.db, "media_backoff_level", "0");
    this.o.log(`media: stored the preview of ${row.full_name} (${Math.round(body.length / 1024)} KB)`);
    return "fetched";
  }

  /** How long to wait after a step before the next one. */
  private waitAfter(r: StepResult): number {
    const now = this.o.now();
    if (r === "paused" || r === "rate-limited") return Math.max(1_000, this.pausedUntil - now);
    if (r === "capped") {
      const oldest = this.triesInHour()[0] ?? now;
      return Math.max(1_000, oldest + HOUR - now + 1_000);
    }
    if (r === "idle") {
      const due = this.o.db.prepare("SELECT min(next_try_at) AS t FROM media WHERE status = 'queued'").get() as { t: number | null };
      return due.t != null ? Math.max(this.o.minGapMs, due.t - now) : 60_000;
    }
    return this.o.minGapMs;
  }

  /** Works the queue until stop() (or `until`). A new repo in the queue wakes an idle wait. */
  async run(opts: { until?: number } = {}) {
    while (!this.stopped && (!opts.until || this.o.now() < opts.until)) {
      let r: StepResult;
      try {
        r = await this.step();
      } catch (e) {
        this.o.log(`media: ${(e as Error).message}`);
        r = "retry";
      }
      const wait = this.waitAfter(r);
      await this.sleep(opts.until ? Math.min(wait, Math.max(0, opts.until - this.o.now())) : wait);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => ((this.wake = null), resolve()), Math.max(0, ms));
      this.wake = () => (clearTimeout(t), (this.wake = null), resolve());
    });
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }
}

/** The file behind a stored picture, for the API; null when there is none (or the file went missing). */
export function mediaFile(db: DB, dir: string, id: string): { path: string; type: string; bytes: number } | null {
  if (!MEDIA_ID.test(id)) return null;
  const row = mediaDone(db, id);
  if (!row?.file || !row.content_type) return null;
  const path = join(dir, row.file);
  return existsSync(path) ? { path, type: row.content_type, bytes: row.bytes ?? 0 } : null;
}
