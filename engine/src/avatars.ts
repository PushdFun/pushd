// The watched builders' GitHub pictures, for their pages and the leaderboards. Only accounts on the watchlist; each
// picture is fetched from GitHub's picture host (not the API, so it costs nothing against the rate limit) at most once a
// week, kept in data/media/avatars and served by the API at /v1/avatar/:handle. A cap per hour and a pause after a
// 403 or 429 keep it polite; without a picture the site draws the account's initial.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function looksLike(type: string, b: Buffer): boolean {
  if (type === "image/png") return b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/gif") return b.length > 6 && b.subarray(0, 4).toString("latin1") === "GIF8";
  if (type === "image/webp") return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export type AvatarOptions = {
  db: DB;
  /** where the pictures go (data/media/avatars) */
  dir: string;
  /** the watchlist's handles (a live list from src/registry.ts is followed as it changes) */
  handles: string[] | (() => string[]);
  /** anyone else whose picture may be fetched (a looked-up account): their GitHub spelling, or null */
  allow?: (handle: string) => string | null;
  perHour?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
};

type Row = { handle: string; status: number; file: string | null; content_type: string | null; fetched_at: number };

export class Avatars {
  private readonly fixed: Map<string, string> | null;
  private readonly tries: number[] = [];
  private pausedUntil = 0;
  private level = 0;
  private readonly inflight = new Map<string, Promise<{ path: string; type: string } | null>>();
  fetches = 0;

  constructor(private readonly o: AvatarOptions) {
    this.fixed = Array.isArray(o.handles) ? new Map(o.handles.map((h) => [h.toLowerCase(), h])) : null;
  }
  private now = () => (this.o.now ?? Date.now)();

  /** The GitHub spelling of a handle whose picture may be fetched; null for anyone else. */
  private canon(h: string): string | null {
    const fromList = this.fixed ? this.fixed.get(h) : (this.o.handles as () => string[])().find((x) => x.toLowerCase() === h);
    return fromList ?? this.o.allow?.(h) ?? null;
  }

  private row(h: string): Row | null {
    return (this.o.db.prepare("SELECT * FROM avatars WHERE handle = ?").get(h) as Row | undefined) ?? null;
  }

  private file(r: Row | null): { path: string; type: string } | null {
    if (!r?.file || !r.content_type) return null;
    const path = join(this.o.dir, r.file);
    return existsSync(path) ? { path, type: r.content_type } : null;
  }

  /** The stored picture, fetched first when it is missing or a week old and the caps allow it. */
  async get(handle: string): Promise<{ path: string; type: string } | null> {
    const h = handle.replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9-]{1,39}$/.test(h)) return null;
    const canon = this.canon(h);
    if (!canon) return null;
    const r = this.row(h);
    const have = this.file(r);
    const age = r ? this.now() - r.fetched_at : Infinity;
    if (have && age < 7 * DAY) return have;
    if (r && !have && r.status !== 200 && age < DAY) return null;
    if (this.pausedUntil > this.now()) return have;
    while (this.tries.length && this.tries[0] <= this.now() - HOUR) this.tries.shift();
    if (this.tries.length >= (this.o.perHour ?? 60)) return have;
    const running = this.inflight.get(h);
    if (running) return running;
    const p = this.fetchOne(h, canon, have).finally(() => this.inflight.delete(h));
    this.inflight.set(h, p);
    return p;
  }

  private async fetchOne(h: string, canon: string, have: { path: string; type: string } | null) {
    this.tries.push(this.now());
    this.fetches++;
    const save = (status: number, file: string | null, type: string | null) =>
      this.o.db
        .prepare("INSERT INTO avatars (handle, status, file, content_type, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET status = excluded.status, file = coalesce(excluded.file, avatars.file), content_type = coalesce(excluded.content_type, avatars.content_type), fetched_at = excluded.fetched_at")
        .run(h, status, file, type, this.now());
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(`https://avatars.githubusercontent.com/${canon}?s=160&v=4`, {
        headers: { "user-agent": "pushd-watcher", accept: "image/png,image/jpeg,image/*" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return have;
    }
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const ra = Number(res.headers.get("retry-after"));
      const wait = ra > 0 ? ra * 1000 : Math.min(6 * HOUR, 30 * 60_000 * 2 ** this.level++);
      this.pausedUntil = this.now() + wait;
      this.o.log?.(`avatars: GitHub said ${res.status}; pausing ${Math.ceil(wait / 1000)} s`);
      return have;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !TYPES[type]) {
      await res.body?.cancel().catch(() => undefined);
      save(res.status === 200 ? 415 : res.status, null, null);
      return have;
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 1024 * 1024 || !looksLike(type, body)) {
      save(422, null, null);
      return have;
    }
    this.level = 0;
    mkdirSync(this.o.dir, { recursive: true });
    const file = `${h}.${TYPES[type]}`;
    const tmp = join(this.o.dir, `.${file}.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(this.o.dir, file));
    save(200, file, type);
    return { path: join(this.o.dir, file), type };
  }
}
