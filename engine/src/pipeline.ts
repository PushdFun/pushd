// From GitHub's answers to feed lines: turn events, repo lists and gists into candidates, then for each one (oldest
// first) dedup, filter, read the repo, score, summarize and store. The watcher and the replay both run this.
import {
  getItemByKey,
  getItemById,
  insertItem,
  logCost,
  prevActivity,
  prevPush,
  prevRepoCreated,
  recordEvent,
  seenEvent,
  setExtra,
  upsertRepo,
  type DB,
  type StoredItem,
} from "./db.ts";
import { filter } from "./filter.ts";
import type { GhContent, GhEvent, GhGist, GhRepo, GitHub } from "./github.ts";
import { score } from "./heat.ts";
import { summarize } from "./summary.ts";
import type { Candidate, Context, Kind, RepoInfo, Sub, WatchEntry } from "./types.ts";

const DAY = 86_400_000;
const KIND: Record<Sub, Kind> = { "new-repo": "repo", "made-public": "repo", push: "push", release: "release", gist: "gist" };

/** Events that only count as activity (for "first push after a long silence"), never as lines. */
export type Activity = { key: string; handle: string; type: string; repo: string | null; githubAt: string };

/** Events that can become lines; the rest are activity. */
export function fromEvents(entry: WatchEntry, events: GhEvent[]): { candidates: Candidate[]; activity: Activity[] } {
  const candidates: Candidate[] = [];
  const activity: Activity[] = [];
  for (const e of events) {
    // an event with no repo (GitHub sends a few, such as some member and org events) says nothing about code
    if (!e?.repo?.name || !e.type) continue;
    const [, repo = e.repo.name] = e.repo.name.split("/");
    const base = { key: e.id, handle: entry.handle, repo, fullName: e.repo.name, githubAt: e.created_at, actor: e.actor.login, url: `https://github.com/${e.repo.name}` };
    const p = e.payload ?? {};
    if (e.type === "CreateEvent" && p.ref_type === "repository") candidates.push({ ...base, sub: "new-repo" });
    else if (e.type === "CreateEvent" && p.ref_type === "branch" && p.ref && p.ref === p.master_branch)
      // GitHub often lists a new repo only as its first branch: the pipeline checks the repo's age
      candidates.push({ ...base, sub: "new-repo", ref: p.ref });
    else if (e.type === "PublicEvent") candidates.push({ ...base, sub: "made-public" });
    else if (e.type === "ReleaseEvent" && p.release && (p.action === "published" || p.action === "released" || !p.action) && !p.release.draft)
      candidates.push({
        ...base,
        sub: "release",
        githubAt: p.release.published_at ?? e.created_at,
        tag: p.release.tag_name,
        releaseName: p.release.name ?? undefined,
        prerelease: p.release.prerelease,
        url: p.release.html_url,
      });
    else if (e.type === "PushEvent")
      candidates.push({ ...base, sub: "push", ref: p.ref ?? undefined, before: p.before, commits: p.commits?.map((c) => c.message), url: p.head ? `https://github.com/${e.repo.name}/commit/${p.head}` : base.url });
    else activity.push({ key: e.id, handle: entry.handle, type: e.type, repo: e.repo.name, githubAt: e.created_at });
  }
  return { candidates, activity };
}

/** Repos in the account's list that the store has not seen: new ones, or old ones that just turned public. */
export function fromRepos(entry: WatchEntry, repos: GhRepo[], isKnown: (id: number) => boolean, since: string, seenAt: string): Candidate[] {
  const out: Candidate[] = [];
  for (const r of repos) {
    if (isKnown(r.id) || r.private) continue;
    const isNew = r.created_at >= since;
    out.push({
      key: `repo:${r.id}`,
      handle: entry.handle,
      sub: isNew ? "new-repo" : "made-public",
      repo: r.name,
      fullName: r.full_name,
      // a repo made public keeps its old creation date; GitHub's list does not say when it turned public, so the
      // time it was first seen public stands in (a PublicEvent, when GitHub lists one, gives the exact time)
      githubAt: isNew ? r.created_at : seenAt,
      actor: r.owner.login,
      url: r.html_url,
    });
  }
  return out;
}

export function fromGists(entry: WatchEntry, gists: GhGist[], isKnown: (key: string) => boolean): Candidate[] {
  return gists
    .filter((g) => g.public && !isKnown(`gist:${g.id}`))
    .map((g) => {
      const files = Object.keys(g.files);
      return {
        key: `gist:${g.id}`,
        handle: entry.handle,
        sub: "gist" as const,
        repo: files[0] ?? g.id,
        fullName: g.id,
        githubAt: g.created_at,
        actor: g.owner?.login ?? entry.handle,
        url: g.html_url,
        gistFiles: files,
        gistDescription: g.description,
        gistRawUrl: files[0] ? g.files[files[0]].raw_url : undefined,
      };
    });
}

export const repoInfo = (r: GhRepo): RepoInfo => ({
  name: r.name,
  fullName: r.full_name,
  description: r.description,
  topics: r.topics ?? [],
  createdAt: r.created_at,
  pushedAt: r.pushed_at,
  stars: r.stargazers_count,
  size: r.size,
  fork: r.fork,
  archived: r.archived,
  defaultBranch: r.default_branch,
  language: r.language,
  readme: null,
  files: null,
});

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";

/** The line's address on the site: the repo's name when it is free, otherwise with the account in front. */
function itemId(db: DB, c: Candidate): string {
  const base =
    c.sub === "release" ? slug(`${c.repo}-${c.tag ?? ""}`) : c.sub === "push" ? slug(`${c.repo}-push-${c.key.slice(-6)}`) : c.sub === "gist" ? slug(`gist-${c.fullName.slice(0, 8)}`) : slug(c.repo);
  for (const id of [base, slug(`${c.handle}-${base}`)]) if (!getItemById(db, id)) return id;
  for (let i = 2; ; i++) if (!getItemById(db, `${base}-${i}`)) return `${base}-${i}`;
}

/** One line per thing: a new repo is one line however many ways GitHub tells about it. */
export function itemKey(c: Candidate): string {
  switch (c.sub) {
    case "new-repo":
    case "made-public":
      return `repo:${c.fullName.toLowerCase()}`;
    case "release":
      return `release:${c.fullName.toLowerCase()}:${c.tag}`;
    case "push":
      return `push:${c.key}`;
    case "gist":
      return `gist:${c.fullName}`;
  }
}

export type PipelineOptions = {
  db: DB;
  gh: GitHub;
  openRouterKey?: string | null;
  openRouterModel?: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** read each kept push's head commit (one request each): on with a token, off without */
  readCommits?: boolean;
  /** called with every new line once it is stored (the watcher queues the repo's preview picture here) */
  onItem?: (item: StoredItem) => void;
};

export type Outcome = { key: string; candidate: Candidate; verdict: string; item: StoredItem | null };

export class Pipeline {
  /** repos read during this run, by full name (lowercase) */
  readonly repos = new Map<string, RepoInfo>();
  constructor(private readonly o: PipelineOptions) {}

  private now = () => (this.o.now ?? Date.now)();

  /** Remembers a repo list: what the account owns, for "new" and "first new repo in N months". */
  rememberRepos(handle: string, list: GhRepo[]) {
    const at = new Date(this.now()).toISOString();
    for (const r of list) {
      upsertRepo(this.o.db, { id: r.id, handle, name: r.name, full_name: r.full_name, created_at: r.created_at, pushed_at: r.pushed_at, fork: r.fork, default_branch: r.default_branch }, at);
      const prev = this.repos.get(r.full_name.toLowerCase());
      this.repos.set(r.full_name.toLowerCase(), { ...repoInfo(r), readme: prev?.readme ?? null, files: prev?.files ?? null });
    }
  }

  /** The repo's facts: from this run's lists, or one request for it. */
  async repo(fullName: string): Promise<RepoInfo | null> {
    const k = fullName.toLowerCase();
    const have = this.repos.get(k);
    if (have) return have;
    const r = await this.o.gh.get<GhRepo>(`/repos/${fullName}`);
    if (!r.data) return null;
    const info = repoInfo(r.data);
    this.repos.set(k, info);
    return info;
  }

  /** README's first lines (raw host, free) and the top-level files (one request). */
  async readRepo(info: RepoInfo): Promise<RepoInfo> {
    if (info.readme == null) {
      for (const name of ["README.md", "readme.md", "README", "README.markdown", "README.rst", "README.txt"]) {
        const text = await this.o.gh.raw(`https://raw.githubusercontent.com/${info.fullName}/HEAD/${name}`, 8_192);
        if (text != null) {
          info.readme = text.split(/\r?\n/).slice(0, 60).join("\n");
          break;
        }
      }
      if (info.readme == null) info.readme = "";
      // kept for the line's page (src/enrich.ts), so it never has to be fetched again
      setExtra(this.o.db, `readme:${info.fullName.toLowerCase()}`, info.readme ? 200 : 404, info.readme || null, this.now());
    }
    if (info.files == null) {
      const r = await this.o.gh.get<GhContent[]>(`/repos/${info.fullName}/contents`);
      info.files = Array.isArray(r.data) ? r.data.map((f) => f.name) : [];
    }
    return info;
  }

  /** The account's activity before this moment, with how far back the store's knowledge reaches. */
  private context(entry: WatchEntry, c: Candidate, repo: RepoInfo | null, historySince: string | null): Context {
    const prevAct = prevActivity(this.o.db, entry.handle, c.githubAt) ?? (historySince && historySince < c.githubAt ? historySince : null);
    let repoForCtx = repo;
    if (repo && c.sub === "push") {
      // the repo's previous push: as the store saw it, or the date of the branch's head before this push. GitHub's
      // pushed_at is already this push or later, so it says nothing; with no evidence of a quiet spell, the repo
      // counts as busy (pushed just now)
      const known = prevPush(this.o.db, c.fullName, c.githubAt);
      repoForCtx = { ...repo, pushedAt: known ?? c.beforeAt ?? c.githubAt };
    }
    return { entry, repo: repoForCtx, prevActivityAt: prevAct, prevRepoCreatedAt: prevRepoCreated(this.o.db, entry.handle, c.githubAt, c.fullName) };
  }

  /** Records activity events (no line, but they count for silences). */
  recordActivity(a: Activity[]) {
    const seenAt = new Date(this.now()).toISOString();
    for (const x of a) recordEvent(this.o.db, { key: x.key, handle: x.handle, type: x.type, repo: x.repo, githubAt: x.githubAt, seenAt, verdict: "activity" });
  }

  /**
   * Runs one candidate through: dedup, the cheap filter, the repo read, the full filter, the score, the summary.
   * `historySince`: how far back the store's knowledge of the account reaches. `backfillBefore`: candidates from
   * before this moment happened before the watcher looked; they are kept as backfill lines, or skipped when
   * `skipBefore` is later than them.
   */
  async run(entry: WatchEntry, c: Candidate, o: { historySince: string | null; backfillBefore?: string; skipBefore?: string; eventType?: string }): Promise<Outcome> {
    const db = this.o.db;
    const seenAt = new Date(this.now()).toISOString();
    const done = (verdict: string, item: StoredItem | null = null): Outcome => {
      recordEvent(db, { key: c.key, handle: entry.handle, type: o.eventType ?? c.sub, repo: c.sub === "gist" ? null : c.fullName, githubAt: c.githubAt, seenAt, verdict, itemId: item?.id ?? null });
      return { key: c.key, candidate: c, verdict, item };
    };
    if (seenEvent(db, c.key)) return { key: c.key, candidate: c, verdict: "seen before", item: null };

    try {
      if (o.skipBefore && c.githubAt < o.skipBefore) return done("before the watcher started");
      // whose repo: a user's push to someone else's repo is a contribution, not their own news
      const owner = c.sub === "gist" ? entry.handle : c.fullName.split("/")[0];
      const own = owner.toLowerCase() === entry.handle.toLowerCase();
      if (c.sub === "push" && !own) return done(`contribution to ${c.fullName}`);
      // the cheap checks first (bots, tool branches, org pushes, pre-releases), before any request is spent
      const cheap = filter(c, this.context(entry, c, null, o.historySince));
      if (!cheap.keep) return done(`dropped: ${cheap.reason}`);

      // a push to a repo this account already pushed to in the last 30 days, and that is not one of its newest repos:
      // everyday work, decided without spending a request on the repo
      if (c.sub === "push" && !this.repos.has(c.fullName.toLowerCase())) {
        const pp = prevPush(db, c.fullName, c.githubAt);
        if (pp && Date.parse(c.githubAt) - Date.parse(pp) < 30 * DAY) return done(`dropped: routine push to ${c.fullName}`);
      }

      let repo: RepoInfo | null = null;
      if (c.sub !== "gist") {
        repo = await this.repo(c.fullName);
        if (!repo && c.sub !== "release") return done("repo not readable (deleted or private)");
      }

      // a first branch counts as a new repo only when the repo is that new
      if (c.sub === "new-repo" && c.ref) {
        if (!repo || Date.parse(c.githubAt) - Date.parse(repo.createdAt) > DAY) return done("first branch of an older repo");
      }
      if (c.sub === "new-repo" && repo) c.githubAt = repo.createdAt < c.githubAt ? repo.createdAt : c.githubAt;
      if (c.sub === "push" && repo) {
        c.defaultBranch = c.ref ? c.ref.replace(/^refs\/heads\//, "") === repo.defaultBranch : undefined;
        // pushes in a repo's first week belong to the new repo's line
        if (Date.parse(c.githubAt) - Date.parse(repo.createdAt) < 7 * DAY) return done("part of a new repo");
        // an old repo with no earlier push in the store: one request for the date of the head before this push
        if (c.defaultBranch !== false && !prevPush(db, c.fullName, c.githubAt) && c.before && !/^0+$/.test(c.before) && Date.parse(c.githubAt) - Date.parse(repo.createdAt) >= 90 * DAY) {
          const r = await this.o.gh.get<{ commit: { committer?: { date?: string }; author?: { date?: string } } }>(`/repos/${c.fullName}/commits/${c.before}`);
          c.beforeAt = r.data?.commit.committer?.date ?? r.data?.commit.author?.date ?? null;
        }
      }
      const key = itemKey(c);
      if (getItemByKey(db, key)) return done("already a line");
      // one push line per repo a day: the next pushes to it within a day are the same story, not new lines
      if (c.sub === "push") {
        const dayBefore = new Date(Date.parse(c.githubAt) - DAY).toISOString();
        const near = db.prepare("SELECT 1 FROM items WHERE kind = 'push' AND lower(handle) = lower(?) AND lower(repo) = lower(?) AND github_at >= ? AND github_at <= ? LIMIT 1").get(entry.handle, c.repo, dayBefore, c.githubAt);
        if (near) return done(`another push to ${c.fullName} within a day`);
      }

      const ctx = this.context(entry, c, repo, o.historySince);
      const first = filter(c, ctx);
      if (!first.keep) return done(`dropped: ${first.reason}`);

      // worth a closer look: the README, the files, and for pushes the head commit
      if (repo) ctx.repo = { ...(await this.readRepo(repo)), pushedAt: ctx.repo?.pushedAt ?? repo.pushedAt };
      if (c.sub === "push" && this.o.readCommits && !c.commits?.length && c.url.includes("/commit/")) {
        const sha = c.url.split("/commit/")[1];
        const r = await this.o.gh.get<{ commit: { message: string } }>(`/repos/${c.fullName}/commits/${sha}`);
        if (r.data) c.commits = [r.data.commit.message];
      }
      if (c.sub === "gist" && c.gistFiles?.length) c.gistFirstLine = await this.gistFirstLine(c);
      const second = filter(c, ctx);
      if (!second.keep) return done(`dropped: ${second.reason}`);

      const s = score(c, ctx);
      const sum = await summarize(
        { candidate: c, repo: ctx.repo },
        { key: this.o.openRouterKey ?? undefined, model: this.o.openRouterModel, onCost: (x) => (logCost(db, x), this.o.log?.(`summary cost: $${x.usd.toFixed(6)} (${x.model}, ${x.inputTokens}+${x.outputTokens} tokens)`)), ref: c.key },
      );
      const shownAt = new Date(this.now()).toISOString();
      const item: StoredItem = {
        id: itemId(db, c),
        key,
        handle: entry.handle,
        group: entry.group,
        kind: KIND[c.sub],
        repo: c.repo,
        ...(c.sub === "release" && c.tag ? { version: c.tag } : {}),
        summary: sum.text,
        summarySource: sum.source,
        heat: s.heat,
        score: s.score,
        signals: s.signals,
        githubAt: c.githubAt,
        seenAt,
        shownAt,
        url: c.url,
        backfill: !!o.backfillBefore && c.githubAt < o.backfillBefore,
      };
      if (!insertItem(db, item)) return done("already a line");
      this.o.onItem?.(item);
      return done(`kept: ${s.heat} ${s.score}/10`, item);
    } catch (e) {
      return done(`error: ${(e as Error).message}`);
    }
  }

  private async gistFirstLine(c: Candidate): Promise<string | null> {
    if (!c.gistRawUrl) return null;
    const text = await this.o.gh.raw(c.gistRawUrl, 2_048);
    if (text == null) return null;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.length === 1 ? lines[0].trim() : null;
  }
}
