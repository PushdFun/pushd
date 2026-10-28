// Extra facts for a line's own page: the repo's numbers (language, stars, forks, topics, license), the README's first
// lines, a push's latest commits, a release's notes, a gist's text, and the builder's other lines.
//
// Stored data first, always: the watcher's own cache already holds most repos (their repo lists and the repos it read),
// and the README of every line it kept. Only what is missing is fetched, and only in the background: a page never
// waits for GitHub. The rules, because GitHub allows 60 API requests an hour without a token (and the watcher needs
// them):
//   - API fetches (repo, commits, release notes): at most PUSHD_ENRICH_PER_HOUR an hour (6 without a token), and
//     none while the watcher's last reading of the rate limit shows fewer than `reserve` requests left.
//   - README and gist text come from GitHub's raw hosts, which are not part of the API limit; still at most 60 an hour.
//   - A 403 or 429 pauses everything (Retry-After or the rate reset when GitHub says; otherwise 15 minutes, doubling
//     with each one in a row, at most 6 hours).
//   - Kept for good: a commit list for a given commit never changes. A repo's facts 12 hours, a README or notes a day,
//     a 404 a day, any other failure half an hour.
import { getExtra, getMeta, queryItems, setExtra, setMeta, type DB, type StoredItem } from "./db.ts";
import { listedRepo } from "./insights.ts";
import { repoOfItem } from "./media.ts";
import type { CommitLine, FeedItem, ItemMore, RepoFacts } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const API = "https://api.github.com";

/** Long dashes read as a plain hyphen: PUSHD's pages never show them, whoever wrote the text. */
export const tidy = (s: string) => s.replace(/[–—]/g, "-");

/**
 * A README (or release notes, or a gist) as a few plain lines: no HTML, no pictures or badges, links as their words,
 * no code fences, at most `maxLines` lines and `maxChars` characters.
 */
export function plainText(md: string, maxLines = 16, maxChars = 1400): string {
  let s = md.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/!\[[^\]]*\]\[[^\]]*\]/g, "");
  s = s.replace(/<img\b[^>]*>/gi, "").replace(/<\/?[a-z][^>]*>/gi, "");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  s = s.replace(/^\s*```.*$/gm, "").replace(/\*\*|__/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const out: string[] = [];
  let blank = true;
  for (const raw of s.split("\n")) {
    const line = tidy(raw.replace(/\s+$/, ""));
    if (!line.trim()) {
      if (!blank) out.push("");
      blank = true;
      continue;
    }
    // a line of nothing but separators (---, ===, ***) adds nothing
    if (/^\s*[-=*_|:\s]{3,}$/.test(line)) continue;
    out.push(line);
    blank = false;
    if (out.length >= maxLines) break;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  let text = out.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, "") + " ...";
  return text;
}

type GhRepoFull = {
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count?: number;
  open_issues_count?: number;
  topics?: string[];
  license?: { spdx_id?: string | null; name?: string | null } | null;
  homepage?: string | null;
  created_at: string;
  pushed_at: string | null;
  archived?: boolean;
};

export function factsFrom(r: GhRepoFull, readAt: string | null): RepoFacts {
  const lic = r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : r.license?.name ?? null;
  return {
    fullName: r.full_name,
    description: r.description ? tidy(r.description) : null,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? null,
    topics: r.topics ?? [],
    license: lic ?? null,
    homepage: r.homepage && /^https?:\/\//.test(r.homepage) ? r.homepage : null,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    archived: !!r.archived,
    readAt,
  };
}

type Want = { k: string; url: string; api: boolean; kind: "repo" | "readme" | "commits" | "release" | "gist"; label: string };

export type EnrichOptions = {
  db: DB;
  token?: string | null;
  /** API fetches an hour at most */
  perHour?: number;
  /** raw-host fetches (README, gist) an hour at most */
  rawPerHour?: number;
  /** never use the API while the watcher has this few requests left */
  reserve?: number;
  /** off: only stored data, nothing fetched */
  enabled?: boolean;
  /** pause between two fetches */
  gapMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
};

const TTL: Record<Want["kind"], number> = { repo: 12 * HOUR, readme: DAY, commits: Infinity, release: DAY, gist: DAY };

export class Enricher {
  private readonly o: Required<Omit<EnrichOptions, "token" | "log">> & { token: string | null; log: (m: string) => void };
  private readonly queue = new Map<string, Want>();
  private running: Promise<void> | null = null;
  /** fetches made (for the logs and the tests) */
  fetches = 0;

  constructor(o: EnrichOptions) {
    const token = o.token?.trim() || null;
    this.o = {
      db: o.db,
      token,
      perHour: o.perHour ?? (token ? 300 : 6),
      rawPerHour: o.rawPerHour ?? 60,
      reserve: o.reserve ?? (token ? 200 : 15),
      enabled: o.enabled ?? true,
      gapMs: o.gapMs ?? 1_500,
      fetchImpl: o.fetchImpl ?? fetch,
      now: o.now ?? Date.now,
      log: o.log ?? (() => {}),
    };
  }

  private now = () => this.o.now();

  /** Is the stored answer for `k` still good? */
  fresh(k: string, kind: Want["kind"]): boolean {
    const ex = getExtra(this.o.db, k);
    if (!ex) return false;
    const age = this.now() - ex.fetchedAt;
    if (ex.status === 200) return age < TTL[kind];
    if (ex.status === 404) return age < DAY;
    return age < 30 * MIN;
  }

  get pausedUntil(): number {
    return Number(getMeta(this.o.db, "enrich_paused_until") ?? 0);
  }

  private tries(api: boolean): number {
    this.o.db.prepare("DELETE FROM gh_extra_tries WHERE at <= ?").run(this.now() - HOUR);
    return (this.o.db.prepare("SELECT count(*) AS n FROM gh_extra_tries WHERE api = ?").get(api ? 1 : 0) as { n: number }).n;
  }

  /** Does the watcher's last reading of the rate limit leave room for one more API request? */
  private watcherRoom(): boolean {
    const w = getMeta(this.o.db, "watcher");
    if (!w) return true;
    try {
      const rate = (JSON.parse(w) as { rate?: { remaining: number; resetAt: number } | null }).rate;
      if (!rate) return true;
      if (rate.resetAt <= this.now()) return true;
      return rate.remaining > this.o.reserve;
    } catch {
      return true;
    }
  }

  /** Could a fetch of this kind start now? */
  allowed(api: boolean): boolean {
    if (!this.o.enabled || this.pausedUntil > this.now()) return false;
    if (api) return this.tries(true) < this.o.perHour && this.watcherRoom();
    return this.tries(false) < this.o.rawPerHour;
  }

  /** Asks for something to be fetched. True when it is on its way (queued now, or already). */
  want(w: Want): boolean {
    if (this.queue.has(w.k)) return true;
    if (this.fresh(w.k, w.kind) || !this.allowed(w.api)) return false;
    this.queue.set(w.k, w);
    this.running ??= this.drain().finally(() => (this.running = null));
    return true;
  }

  /** Waits for the queue to empty (the tests use it). */
  async idle() {
    while (this.running) await this.running;
  }

  private pause(res: Response | null) {
    const level = Number(getMeta(this.o.db, "enrich_backoff_level") ?? 0);
    const retryAfter = Number(res?.headers.get("retry-after"));
    const reset = Number(res?.headers.get("x-ratelimit-reset")) * 1000;
    const remaining = res?.headers.get("x-ratelimit-remaining");
    const wait = retryAfter > 0 ? retryAfter * 1000 : remaining === "0" && reset > this.now() ? reset - this.now() + 2_000 : Math.min(6 * HOUR, 15 * MIN * 2 ** level);
    setMeta(this.o.db, "enrich_paused_until", String(this.now() + Math.min(wait, 6 * HOUR)));
    setMeta(this.o.db, "enrich_backoff_level", String(level + 1));
    this.o.log(`enrich: GitHub said ${res?.status}; pausing ${Math.ceil(wait / 1000)} s`);
  }

  private async drain() {
    while (this.queue.size) {
      const [k, w] = this.queue.entries().next().value as [string, Want];
      this.queue.delete(k);
      if (this.fresh(k, w.kind)) continue;
      if (!this.allowed(w.api)) {
        // the budget ran out while it waited: drop the rest, the next page view asks again
        this.queue.clear();
        break;
      }
      await this.fetchOne(w);
      if (this.queue.size) await new Promise((r) => setTimeout(r, this.o.gapMs));
    }
  }

  private async fetchOne(w: Want) {
    const urls = w.kind === "readme" ? ["README.md", "readme.md", "README"].map((f) => `${w.url}/${f}`) : [w.url];
    for (const url of urls) {
      this.o.db.prepare("INSERT INTO gh_extra_tries (at, api) VALUES (?, ?)").run(this.now(), w.api ? 1 : 0);
      this.fetches++;
      let res: Response;
      try {
        const headers: Record<string, string> = { "user-agent": "pushd-watcher" };
        if (w.api) {
          headers.accept = "application/vnd.github+json";
          headers["x-github-api-version"] = "2022-11-28";
          if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
        }
        res = await this.o.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      } catch {
        setExtra(this.o.db, w.k, 0, null, this.now());
        return;
      }
      if (res.status === 403 || res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        this.pause(res);
        this.queue.clear();
        return;
      }
      if (res.status === 404 && urls.length > 1 && url !== urls[urls.length - 1]) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        setExtra(this.o.db, w.k, res.status, null, this.now());
        return;
      }
      const text = (await res.text()).slice(0, 400_000);
      // the README and gist text keep their first lines; the API answers are kept as JSON
      const body = w.kind === "readme" || w.kind === "gist" ? text.split(/\r?\n/).slice(0, 80).join("\n") : text;
      setExtra(this.o.db, w.k, 200, body, this.now());
      setMeta(this.o.db, "enrich_backoff_level", "0");
      return;
    }
  }

  // ---- what an item's page gets ----

  /** The repo's stored facts: what this module fetched, the repo the watcher read, or the account's repo list. */
  private storedFacts(full: string): RepoFacts | null {
    const lc = full.toLowerCase();
    const ex = getExtra(this.o.db, `repo:${lc}`);
    if (ex?.status === 200 && ex.body) {
      try {
        return factsFrom(JSON.parse(ex.body) as GhRepoFull, new Date(ex.fetchedAt).toISOString());
      } catch {
        /* fall through */
      }
    }
    const c = this.o.db.prepare("SELECT body, fetched_at FROM http_cache WHERE lower(url) = ?").get(`${API}/repos/${lc}`) as { body: string; fetched_at: string } | undefined;
    if (c) {
      try {
        return factsFrom(JSON.parse(c.body) as GhRepoFull, c.fetched_at);
      } catch {
        /* fall through */
      }
    }
    const l = listedRepo(this.o.db, full);
    return l ? factsFrom(l.repo, l.readAt) : null;
  }

  private storedText(k: string): { body: string; readAt: string } | null {
    const ex = getExtra(this.o.db, k);
    if (ex?.status !== 200 || !ex.body) return null;
    return { body: ex.body, readAt: new Date(ex.fetchedAt).toISOString() };
  }

  /**
   * Everything stored about a line, and the missing parts asked for in the background. `cutoff`: the delay the
   * request runs at (the builder's other lines follow it).
   */
  more(it: StoredItem, cutoff: string, toItem: (s: StoredItem) => FeedItem): ItemMore {
    const db = this.o.db;
    const pending: string[] = [];
    const full = repoOfItem(it);
    const lc = full?.toLowerCase();
    let repo: RepoFacts | null = null;
    let text: ItemMore["text"] = null;
    let commits: CommitLine[] | null = null;
    let change: ItemMore["change"] = null;

    if (full && lc) {
      repo = this.storedFacts(full);
      if (!repo && this.want({ k: `repo:${lc}`, url: `${API}/repos/${full}`, api: true, kind: "repo", label: "repo facts" })) pending.push("repo facts");

      if (it.kind === "release" && it.version) {
        const k = `release:${lc}@${it.version}`;
        const notes = this.storedText(k);
        if (notes) {
          try {
            const body = (JSON.parse(notes.body) as { body?: string | null }).body ?? "";
            if (body.trim()) text = { kind: "notes", body: plainText(body), readAt: notes.readAt };
          } catch {
            /* not JSON: no notes */
          }
        } else if (this.want({ k, url: `${API}/repos/${full}/releases/tags/${encodeURIComponent(it.version)}`, api: true, kind: "release", label: "release notes" })) pending.push("release notes");
      }
      if (!text) {
        const k = `readme:${lc}`;
        const readme = this.storedText(k);
        if (readme) {
          const body = plainText(readme.body);
          if (body) text = { kind: "readme", body, readAt: readme.readAt };
        } else if (this.want({ k, url: `https://raw.githubusercontent.com/${full}/HEAD`, api: false, kind: "readme", label: "README" })) pending.push("README");
      }

      const sha = it.kind === "push" ? it.url?.match(/\/commit\/([0-9a-f]{7,40})$/)?.[1] : undefined;
      if (sha) {
        const k = `commits:${lc}@${sha}`;
        const list = this.storedText(k);
        if (list) {
          try {
            const arr = JSON.parse(list.body) as { sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } | null } }[];
            commits = arr.slice(0, 8).map((c) => ({
              sha: c.sha,
              message: tidy(c.commit.message.split("\n")[0].slice(0, 140)),
              author: c.commit.author?.name ?? null,
              at: c.commit.author?.date ?? null,
              url: c.html_url,
            }));
          } catch {
            commits = null;
          }
        } else if (this.want({ k, url: `${API}/repos/${full}/commits?sha=${sha}&per_page=8`, api: true, kind: "commits", label: "commits" })) pending.push("commits");
        // the head commit the watcher read, when it did: its size
        const head = db.prepare("SELECT body FROM http_cache WHERE lower(url) = ?").get(`${API}/repos/${lc}/commits/${sha}`) as { body: string } | undefined;
        if (head) {
          try {
            const h = JSON.parse(head.body) as { stats?: { additions: number; deletions: number }; files?: unknown[] };
            if (h.stats) change = { additions: h.stats.additions, deletions: h.stats.deletions, files: h.files?.length ?? 0 };
          } catch {
            /* no size */
          }
        }
      }
    } else if (it.kind === "gist" && it.url) {
      const id = it.url.match(/gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]{6,40})/)?.[1];
      if (id) {
        const k = `gist:${id}`;
        const g = this.storedText(k);
        if (g) {
          const body = plainText(g.body, 14, 900);
          if (body) text = { kind: "gist", body, readAt: g.readAt };
        } else if (this.want({ k, url: `https://gist.githubusercontent.com/${it.handle}/${id}/raw`, api: false, kind: "gist", label: "gist text" })) pending.push("gist text");
      }
    }

    // the builder's other lines, one per repo (a busy repo would fill the row with the same name)
    const seenRepos = new Set([it.repo.toLowerCase()]);
    const related = queryItems(db, { shownBefore: cutoff, handle: it.handle, limit: 60 })
      .filter((x) => x.id !== it.id && !seenRepos.has(x.repo.toLowerCase()) && (seenRepos.add(x.repo.toLowerCase()), true))
      .slice(0, 4)
      .map(toItem);
    return { repo, text, commits, change, related, pending };
  }
}
