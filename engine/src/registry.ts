// The live lists every part of the engine reads: who is watched now (the Top N, in rank order) and every project PUSHD
// knows by name (the Top N and every project that was ever in it). The accounts of the old hand-made list are not
// projects with a token: they are known only until the ranking has a list (their lines then leave the public view, and
// anyone can still look them up as any GitHub account). The arrays are changed in place when the ranking moves, so a part that was handed them always
// reads the current list; whoOf() gives a lookup map that follows them.
import { hideOutside, type DB } from "./db.ts";
import { ensureRankSchema, tokenOf, type PoolRow } from "./rank/store.ts";
import type { WatchEntry } from "./types.ts";

const VERSION = Symbol("pushd.version");
type Versioned = WatchEntry[] & { [VERSION]?: number };

const maps = new WeakMap<object, { v: number; m: Map<string, WatchEntry> }>();

/** A lookup by lower-case handle that follows the array as the registry changes it. */
export function whoOf(arr: WatchEntry[]): Map<string, WatchEntry> {
  const v = (arr as Versioned)[VERSION] ?? 0;
  let c = maps.get(arr);
  if (!c || c.v !== v || (v === 0 && c.m.size !== arr.length)) {
    c = { v, m: new Map(arr.map((a) => [a.handle.toLowerCase(), a])) };
    maps.set(arr, c);
  }
  return c.m;
}

function replace(arr: WatchEntry[], next: WatchEntry[]) {
  arr.splice(0, arr.length, ...next);
  (arr as Versioned)[VERSION] = ((arr as Versioned)[VERSION] ?? 0) + 1;
}

/** A pool row as a watch entry: the project's name, its token as what it is known for, its camp. */
export function entryOf(r: PoolRow): WatchEntry {
  const sym = r.symbol ? `$${r.symbol.replace(/^\$/, "")}` : null;
  const days = r.pair_created_at ? Math.floor((Date.now() - r.pair_created_at) / 86_400_000) : null;
  const via = (JSON.parse(r.sources) as string[]).find((s) => s.startsWith("github via"))?.replace("github via ", "") ?? "its token listing";
  return {
    handle: r.display,
    name: r.name?.trim().replace(/[\u2013\u2014]/g, "-") || r.display,
    org: sym ?? r.name ?? r.display,
    group: r.camp,
    type: r.type === "user" ? "user" : "org",
    ...(r.followers != null ? { followers: r.followers } : {}),
    source: `Token ${sym ?? r.name ?? "?"}${r.chain ? ` (${r.chain})` : ""}${days != null ? `, trading for ${days} days` : ""}; its GitHub link comes from ${via}.`,
    ...(tokenOf(r) ? { token: tokenOf(r)! } : {}),
  };
}

export class Registry {
  /** the Top N now, in rank order */
  readonly top: WatchEntry[] = [];
  /** everyone known by name */
  readonly known: WatchEntry[] = [];
  /** the time of the last ranking pass the lists come from */
  lastPass: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DB,
    /** the old hand-made list: names for the lines it made */
    private readonly legacy: WatchEntry[] = [],
    /** accounts whose lines stay in view outside the pool: the scouts' own account (src/agents/scoutbuilds.ts) */
    private readonly pinned: string[] = [],
  ) {
    ensureRankSchema(db);
    this.refresh();
  }

  /** Reads the ranking's state; true when the Top N changed. */
  refresh(): boolean {
    const rows = this.db
      .prepare("SELECT p.*, s.in_top AS in_top, s.rank AS srank FROM pool p JOIN rank_state s ON s.login = p.login WHERE s.in_top = 1 OR s.entered_at IS NOT NULL ORDER BY s.in_top DESC, s.rank ASC")
      .all() as (PoolRow & { in_top: number; srank: number | null })[];
    const top = rows.filter((r) => r.in_top === 1).map(entryOf);
    const ever = rows.map(entryOf);
    const changed = top.map((t) => t.handle).join(",") !== this.top.map((t) => t.handle).join(",") || (top.length ? ever.length : ever.length + this.legacy.length) !== this.known.length;
    if (changed || !this.known.length) {
      replace(this.top, top);
      const seen = new Set(ever.map((e) => e.handle.toLowerCase()));
      replace(this.known, top.length ? ever : [...ever, ...this.legacy.filter((l) => !seen.has(l.handle.toLowerCase()))]);
    } else {
      // names, tokens and followers may change without the order changing
      const fresh = whoOf(ever);
      for (const e of this.top) Object.assign(e, fresh.get(e.handle.toLowerCase()) ?? {});
    }
    this.lastPass = (this.db.prepare("SELECT max(at) AS t FROM rank_passes").get() as { t: number | null }).t;
    // the public feed shows token projects only: lines of accounts outside the pool (the old hand-made list) go out of
    // view, once the ranking has a list to show instead
    if (top.length) {
      const pool = new Set((this.db.prepare("SELECT login FROM pool").all() as { login: string }[]).map((r) => r.login));
      const pins = new Set(this.pinned.map((p) => p.toLowerCase()));
      hideOutside(this.db, (h) => pool.has(h.toLowerCase()) || pins.has(h.toLowerCase()));
    }
    return changed;
  }

  get(handle: string): WatchEntry | null {
    return whoOf(this.known).get(handle.replace(/^@/, "").toLowerCase()) ?? null;
  }

  inTop(handle: string): boolean {
    return whoOf(this.top).has(handle.replace(/^@/, "").toLowerCase());
  }

  /** Reads the ranking again every `everyMs`; returns a stop function. */
  follow(everyMs = 60_000, onChange?: () => void): () => void {
    this.timer = setInterval(() => {
      try {
        if (this.refresh()) onChange?.();
      } catch {
        /* the next look tries again */
      }
    }, everyMs);
    this.timer.unref?.();
    return () => this.timer && clearInterval(this.timer);
  }
}
