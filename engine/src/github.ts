// A small GitHub REST client: conditional requests (ETag, so an unchanged answer is a 304 and is read from the
// cache), the rate limit read from every answer's headers, and a back-off when it runs low or GitHub says wait.
// Token from PUSHD_GITHUB_TOKEN when set; without it, GitHub allows 60 requests an hour, and the watcher slows down.
import { bookSpend, cached, setMeta, storeCache, type DB } from "./db.ts";

export const API = "https://api.github.com";

export type Rate = { limit: number; remaining: number; resetAt: number; used: number };

export type GhResponse<T> = {
  status: number;
  data: T | null;
  fromCache: boolean;
  pollInterval: number | null;
  /** a 403/429, a spent budget or a share used up: seconds until it is worth asking again (no-wait requests only) */
  retryInSec?: number;
};

/** Which part of PUSHD spent a request (src/plan.ts shares the hourly allowance out between them). */
export type Part = "watch" | "extra" | "lookup" | "enrich" | "rank" | "search" | "scout" | "other";

export type ClientOptions = {
  db: DB;
  token?: string | null;
  /** requests to keep in hand: never spend the last few */
  reserve?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** waits are injectable so tests do not wait */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** the part of PUSHD these requests are booked to (the gh_spend table); default "other" */
  part?: Part;
  /** false: never sleep for the budget or a back-off; answer at once with retryInSec (interactive lookups) */
  wait?: boolean;
  /** where the spend is booked when the cache lives in another store (the extras store books to the main one) */
  spendDb?: DB;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GitHub {
  readonly token: string | null;
  rate: Rate | null = null;
  requests = 0;
  notModified = 0;
  private readonly o: Required<Omit<ClientOptions, "token" | "spendDb">> & { spendDb: DB };
  /** the readings of the search API's own limits (search, and code search), kept apart from the core one */
  searchRate: Rate | null = null;
  codeRate: Rate | null = null;

  constructor(o: ClientOptions) {
    this.token = o.token?.trim() || null;
    this.o = {
      db: o.db,
      reserve: o.reserve ?? (this.token ? 50 : 3),
      fetchImpl: o.fetchImpl ?? fetch,
      log: o.log ?? (() => {}),
      sleep: o.sleep ?? realSleep,
      now: o.now ?? Date.now,
      part: o.part ?? "other",
      wait: o.wait ?? true,
      spendDb: o.spendDb ?? o.db,
    };
  }

  get part(): Part {
    return this.o.part;
  }

  get authenticated() {
    return !!this.token;
  }

  /** Milliseconds to wait before the next request so the budget lasts until GitHub's reset. */
  spacingMs(floorMs: number): number {
    const r = this.rate;
    if (!r) return floorMs;
    const left = r.remaining - this.o.reserve;
    const untilReset = Math.max(0, r.resetAt - this.o.now());
    if (left <= 0) return untilReset + 2_000;
    return Math.max(floorMs, Math.ceil(untilReset / left));
  }

  private async waitForBudget() {
    const r = this.rate;
    if (!r) return;
    if (r.remaining <= this.o.reserve && r.resetAt > this.o.now()) {
      const ms = r.resetAt - this.o.now() + 2_000;
      this.o.log(`rate limit: ${r.remaining} left, waiting ${Math.ceil(ms / 1000)} s for the reset`);
      await this.o.sleep(ms);
    }
  }

  private readRate(h: Headers): "core" | "search" | "code" | null {
    const limit = Number(h.get("x-ratelimit-limit"));
    const remaining = Number(h.get("x-ratelimit-remaining"));
    const reset = Number(h.get("x-ratelimit-reset"));
    const used = Number(h.get("x-ratelimit-used"));
    if (!Number.isFinite(limit) || !h.has("x-ratelimit-remaining")) return null;
    const r = { limit, remaining, resetAt: reset * 1000, used };
    const res = h.get("x-ratelimit-resource") ?? "core";
    if (res === "search") {
      this.searchRate = r;
      return "search";
    }
    if (res === "code_search") {
      this.codeRate = r;
      return "code";
    }
    if (res !== "core") return null;
    this.rate = r;
    // every client's latest reading of the core limit, so the parts in other processes see the same budget
    try {
      setMeta(this.o.spendDb, "gh_rate", JSON.stringify({ ...r, at: this.o.now() }));
    } catch {
      /* a read-only store: the reading stays in this process */
    }
    return "core";
  }

  /** Books one request to this client's part (304s are free on GitHub's side and booked as such). */
  private book(resource: "core" | "search" | "code", free: boolean) {
    try {
      bookSpend(this.o.spendDb, this.o.part, resource === "code" ? "search" : resource, free, this.o.now());
    } catch {
      /* never fail a request over the books */
    }
  }

  /** GET an API path with a conditional request. 304 answers come back as the cached body. */
  async get<T>(path: string, opts: { conditional?: boolean; wait?: boolean } = {}): Promise<GhResponse<T>> {
    const url = path.startsWith("http") ? path : API + path;
    const conditional = opts.conditional ?? true;
    const wait = opts.wait ?? this.o.wait;
    const isCode = url.startsWith(API + "/search/code");
    const isSearch = url.startsWith(API + "/search/");
    const kindRate = () => (isCode ? this.codeRate : isSearch ? this.searchRate : this.rate);
    for (let attempt = 0; ; attempt++) {
      if (!wait) {
        const r = kindRate();
        if (r && r.remaining <= (isSearch ? 0 : this.o.reserve) && r.resetAt > this.o.now())
          return { status: 429, data: null, fromCache: false, pollInterval: null, retryInSec: Math.ceil((r.resetAt - this.o.now()) / 1000) + 1 };
      } else if (isSearch) {
        const r = kindRate();
        if (r && r.remaining <= 0 && r.resetAt > this.o.now()) await this.o.sleep(r.resetAt - this.o.now() + 1_000);
      } else await this.waitForBudget();
      const prev = conditional ? cached(this.o.db, url) : null;
      const headers: Record<string, string> = {
        accept: isCode ? "application/vnd.github.text-match+json" : "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pushd-watcher",
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (prev?.etag) headers["if-none-match"] = prev.etag;
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (attempt >= 3) throw e;
        await this.o.sleep(2 ** attempt * 2_000);
        continue;
      }
      this.requests++;
      const resource = this.readRate(res.headers) ?? (isCode ? "code" : isSearch ? "search" : "core");
      this.book(resource, res.status === 304);
      const poll = Number(res.headers.get("x-poll-interval")) || null;
      if (res.status === 304 && prev) {
        this.notModified++;
        return { status: 304, data: JSON.parse(prev.body) as T, fromCache: true, pollInterval: poll };
      }
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const rr = resource === "code" ? this.codeRate : resource === "search" ? this.searchRate : this.rate;
        const resetMs = rr && rr.remaining === 0 ? rr.resetAt - this.o.now() : 0;
        const pause = retryAfter > 0 ? retryAfter * 1000 : resetMs > 0 ? resetMs + 2_000 : 2 ** attempt * 60_000;
        await res.body?.cancel().catch(() => undefined);
        if (!wait) return { status: res.status, data: null, fromCache: false, pollInterval: poll, retryInSec: Math.ceil(Math.min(pause, 3_600_000) / 1000) };
        if (attempt >= 3) return { status: res.status, data: null, fromCache: false, pollInterval: poll };
        this.o.log(`GitHub said ${res.status} for ${path}; backing off ${Math.ceil(pause / 1000)} s`);
        await this.o.sleep(Math.min(pause, 3_600_000));
        // the wait covered it; the next answer tells the new budget
        if (resource === "code") this.codeRate = null;
        else if (resource === "search") this.searchRate = null;
        else this.rate = null;
        continue;
      }
      if (res.status >= 500 && attempt < 3 && wait) {
        await this.o.sleep(2 ** attempt * 5_000);
        continue;
      }
      if (!res.ok) return { status: res.status, data: null, fromCache: false, pollInterval: poll };
      const body = await res.text();
      if (conditional) storeCache(this.o.db, url, res.headers.get("etag"), body);
      return { status: res.status, data: JSON.parse(body) as T, fromCache: false, pollInterval: poll };
    }
  }

  /** Raw files (README, gist text) come from GitHub's raw hosts, which do not count against the API limit. */
  async raw(url: string, maxBytes = 16_384): Promise<string | null> {
    try {
      const res = await this.o.fetchImpl(url, { headers: { "user-agent": "pushd-watcher" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      // read no more than the limit (and a little for a character cut in half), however big the file is
      if (!res.body) return (await res.text()).slice(0, maxBytes);
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (size < maxBytes + 4) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
      }
      await reader.cancel().catch(() => undefined);
      return Buffer.concat(parts).toString("utf8").slice(0, maxBytes);
    } catch {
      return null;
    }
  }
}

// ---- GitHub's shapes, as far as PUSHD reads them ----

export type GhEvent = {
  id: string;
  type: string;
  actor: { login: string };
  repo: { id: number; name: string };
  created_at: string;
  payload: {
    ref?: string | null;
    ref_type?: "repository" | "branch" | "tag";
    master_branch?: string;
    description?: string | null;
    head?: string;
    before?: string;
    commits?: { message: string; author?: { name?: string } }[];
    release?: { tag_name: string; name: string | null; prerelease: boolean; draft: boolean; html_url: string; published_at?: string | null; created_at?: string };
    action?: string;
  };
};

export type GhRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  topics?: string[];
  created_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  size: number;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  language: string | null;
  html_url: string;
  private?: boolean;
};

export type GhGist = {
  id: string;
  html_url: string;
  description: string | null;
  public: boolean;
  created_at: string;
  files: Record<string, { filename: string; raw_url: string; size: number; language: string | null }>;
  owner?: { login: string };
};

export type GhContent = { name: string; type: string };
