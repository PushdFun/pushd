// Look up anyone: a page for any GitHub account or repo, built on demand from public data, and a search that finds
// anything on GitHub (the watched first). It spends its own share of the hourly GitHub allowance (src/plan.ts: the
// "lookup" part), so it can never starve the watcher, and every answer is kept for a while (gh_lookup):
//   - an account's page: 3 requests (the profile, its public events, its repos), kept 30 minutes with a token and 6
//     hours without; a repo's page: 3 requests (the repo, its commits, its releases) and the README from the raw host
//     (free), kept as long; a search: 2 calls to the search API (its own per-minute limit), kept 10 minutes; a 404 a day.
//   - each visitor may cause at most PUSHD_LOOKUP_PER_MIN fresh builds a minute and PUSHD_LOOKUP_PER_HOUR an hour;
//     kept answers are free.
//   - when the share, GitHub's limit or the visitor's allowance is used up, a kept answer is served as stale; with
//     nothing kept the answer is 503 "busy, try in a minute" with the seconds to wait.
// "Ask a scout to read it" runs the existing deep read (src/scouts/scouts.ts) on the scout of the owner's camp, else
// DeepSeek: holders get PUSHD_LOOKUP_HOLDER_READS free reads a day, everyone else shares PUSHD_LOOKUP_PUBLIC_READS a
// day (at most 2 per visitor); all model spend stays under the scouts' own caps.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { spentBy, type DB } from "./db.ts";
import { factsFrom, plainText, tidy } from "./enrich.ts";
import type { GhEvent, GitHub } from "./github.ts";
import { CATEGORIES, category, counts, dayKeys, WHAT } from "./insights.ts";
import { shareRoom } from "./plan.ts";
import { CAMP_LABEL, denied, type RankConfig } from "./rank/config.ts";
import type { Ranker } from "./rank/ranker.ts";
import type { Registry } from "./registry.ts";
import { SCOUT_BY_ID, scoutFor } from "./scouts/roster.ts";
import type { Scouts } from "./scouts/scouts.ts";
import type { ActivityLine, CommitLine, GhRelease, GhRepoPage, GhUser, GhUserPage, LookupResult, ReadAllowance, RepoCard, ScoutRead, SearchResult } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Env = Record<string, string | undefined>;
const num = (v: string | undefined, d: number, min = 0, max = 1_000_000) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : d;
};

export type LookupConfig = {
  pageTtlMs: number;
  searchTtlMs: number;
  notFoundTtlMs: number;
  visitorPerMin: number;
  visitorPerHour: number;
  /** search API calls a minute for lookups (the ranking has the rest) */
  searchPerMin: number;
  holderReadsPerDay: number;
  publicReadsPerDay: number;
  visitorReadsPerDay: number;
  trustProxy: boolean;
};

export function lookupConfigFromEnv(env: Env = process.env, authenticated = false): LookupConfig {
  return {
    pageTtlMs: num(env.PUSHD_LOOKUP_TTL_MIN, authenticated ? 30 : 360, 1, 10_080) * MIN,
    searchTtlMs: num(env.PUSHD_LOOKUP_SEARCH_TTL_MIN, 10, 1, 1440) * MIN,
    notFoundTtlMs: DAY,
    visitorPerMin: num(env.PUSHD_LOOKUP_PER_MIN, 8, 1, 1000),
    visitorPerHour: num(env.PUSHD_LOOKUP_PER_HOUR, 60, 1, 100_000),
    searchPerMin: num(env.PUSHD_LOOKUP_SEARCH_PER_MIN, authenticated ? 10 : 3, 1, 30),
    holderReadsPerDay: num(env.PUSHD_LOOKUP_HOLDER_READS, 3, 0, 1000),
    publicReadsPerDay: num(env.PUSHD_LOOKUP_PUBLIC_READS, 10, 0, 10_000),
    visitorReadsPerDay: num(env.PUSHD_LOOKUP_VISITOR_READS, 2, 0, 1000),
    trustProxy: env.PUSHD_AGENT_TRUST_PROXY?.trim() === "1",
  };
}

export const LOOKUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS gh_lookup (k TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lookup_reads (at INTEGER NOT NULL, day TEXT NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lookup_reads_day ON lookup_reads(day, kind, who);
`;

export class LookupError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryInSec: number | null = null,
  ) {
    super(message);
  }
}

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** What was typed: a username, owner/name (or a GitHub link to either), or free words. */
export function parseQuery(q: string): { kind: "user"; login: string } | { kind: "repo"; owner: string; name: string } | { kind: "words"; text: string } {
  const t = q.trim().replace(/^@/, "");
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})(?:\/([A-Za-z0-9._-]{1,100}))?\/?(?:[?#].*)?$/i.exec(t);
  if (url) return url[2] ? { kind: "repo", owner: url[1], name: url[2].replace(/\.git$/, "") } : { kind: "user", login: url[1] };
  const repo = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  if (repo && LOGIN_RE.test(repo[1])) return { kind: "repo", owner: repo[1], name: repo[2] };
  if (LOGIN_RE.test(t) && !t.endsWith("-")) return { kind: "user", login: t };
  return { kind: "words", text: t.slice(0, 80) };
}

export type LookupDeps = {
  db: DB;
  /** the lookup's own client: booked to the "lookup" share, never waits */
  gh: GitHub;
  registry: Registry;
  ranker: Ranker | null;
  scouts: Scouts | null;
  rank: Pick<RankConfig, "deny">;
  /** the feed's own search, behind the public delay */
  searchWatch: (q: string) => SearchResult;
  config: LookupConfig;
  now?: () => number;
  log?: (m: string) => void;
};

type GhUserApi = { login: string; type: string; name: string | null; bio: string | null; company: string | null; blog: string | null; followers: number; following: number; public_repos: number; created_at: string; html_url: string };
type GhRepoApi = {
  full_name: string;
  name: string;
  owner: { login: string; type: string };
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count?: number;
  topics?: string[];
  license?: { spdx_id?: string | null; name?: string | null } | null;
  homepage?: string | null;
  created_at: string;
  pushed_at: string | null;
  archived?: boolean;
  fork: boolean;
  default_branch: string;
  parent?: { full_name: string };
  subscribers_count?: number;
  html_url: string;
  private?: boolean;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class Lookup {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly d: LookupDeps) {
    d.db.exec(LOOKUP_SCHEMA);
  }

  private now = () => (this.d.now ?? Date.now)();
  private get auth() {
    return this.d.gh.authenticated;
  }

  /** The visitor behind a request: the site's forwarded address when the site (loopback) or a trusted proxy sent it. */
  visitor(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "";
    const loop = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const fwd = req.headers["x-forwarded-for"];
    const f = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    return sha(`pushd-lookup:${(loop || this.d.config.trustProxy) && f ? f : peer}`);
  }

  // ---- the cache ----

  private kept(k: string): { status: number; body: string | null; at: number } | null {
    const r = this.d.db.prepare("SELECT status, body, fetched_at FROM gh_lookup WHERE k = ?").get(k) as { status: number; body: string | null; fetched_at: number } | undefined;
    return r ? { status: r.status, body: r.body, at: r.fetched_at } : null;
  }

  private keep(k: string, status: number, body: string | null) {
    this.d.db.prepare("INSERT INTO gh_lookup (k, status, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at").run(k, status, body, this.now());
  }

  // ---- the allowances ----

  /** Seconds until a fresh build may be tried, or 0 when it may go now (and the visitor's allowance is taken). */
  private take(visitor: string, cost: number, search = false): number {
    const now = this.now();
    if (search) {
      if (spentBy(this.d.db, "lookup", now - MIN, "search") + cost > this.d.config.searchPerMin) return 60;
      const sr = this.d.gh.searchRate;
      if (sr && sr.remaining < cost && sr.resetAt > now) return Math.ceil((sr.resetAt - now) / 1000) + 1;
    } else {
      if (!shareRoom(this.d.db, "lookup", this.auth, cost, now)) return 60 * (60 - new Date(now).getUTCMinutes()) || 60;
      const r = this.d.gh.rate;
      const reserve = this.auth ? 500 : 15;
      if (r && r.remaining - cost < reserve && r.resetAt > now) return Math.ceil((r.resetAt - now) / 1000) + 1;
    }
    const list = (this.hits.get(visitor) ?? []).filter((t) => t > now - HOUR);
    if (list.filter((t) => t > now - MIN).length >= this.d.config.visitorPerMin) return 60;
    if (list.length >= this.d.config.visitorPerHour) return Math.ceil((list[0] + HOUR - now) / 1000);
    list.push(now);
    this.hits.set(visitor, list);
    if (this.hits.size > 5000) for (const k of [...this.hits.keys()].slice(0, 2500)) this.hits.delete(k);
    return 0;
  }

  private busy(wait: number): never {
    throw new LookupError(503, "GitHub is busy for lookups right now. Try again in a minute.", Math.max(5, Math.min(3600, wait)));
  }

  // ---- an account ----

  async user(loginInput: string, visitor: string): Promise<{ redirect: string } | { page: GhUserPage }> {
    const login = loginInput.replace(/^@/, "");
    if (!LOGIN_RE.test(login)) throw new LookupError(400, "That is not a GitHub username.");
    if (denied(this.d.rank, login, { privateOnly: true })) throw new LookupError(404, "No such GitHub account.");
    const known = this.d.registry.get(login);
    if (known) return { redirect: `/builders/${known.handle}` };
    const k = `user:${login.toLowerCase()}`;
    const have = this.kept(k);
    const fresh = have && this.now() - have.at < (have.status === 404 ? this.d.config.notFoundTtlMs : this.d.config.pageTtlMs);
    if (have && fresh) return this.userOut(have);
    const wait = this.take(visitor, 3);
    if (wait) {
      if (have && have.status === 200) return this.userOut(have, true);
      this.busy(wait);
    }
    const u = await this.d.gh.get<GhUserApi>(`/users/${login}`, { conditional: false });
    if (u.status === 404) {
      this.keep(k, 404, null);
      throw new LookupError(404, "No such GitHub account.");
    }
    if (!u.data) {
      if (have && have.status === 200) return this.userOut(have, true);
      this.busy(u.retryInSec ?? 60);
    }
    const user = u.data!;
    const isOrg = user.type === "Organization";
    const [ev, rl] = await Promise.all([
      this.d.gh.get<GhEvent[]>(isOrg ? `/orgs/${user.login}/events?per_page=100` : `/users/${user.login}/events/public?per_page=100`, { conditional: false }),
      this.d.gh.get<GhRepoApi[]>(`/users/${user.login}/repos?sort=pushed&per_page=100&type=owner`, { conditional: false }),
    ]);
    const page = this.buildUser(user, Array.isArray(ev.data) ? ev.data : [], Array.isArray(rl.data) ? rl.data : []);
    this.keep(k, 200, JSON.stringify(page));
    return this.userOut({ status: 200, body: JSON.stringify(page), at: this.now() });
  }

  private userOut(have: { status: number; body: string | null; at: number }, stale = false): { page: GhUserPage } {
    if (have.status === 404 || !have.body) throw new LookupError(404, "No such GitHub account.");
    const page = JSON.parse(have.body) as GhUserPage;
    const isStale = stale || this.now() - have.at >= this.d.config.pageTtlMs;
    // the live parts: its place in the ranking and how many holders watch it
    return { page: { ...page, stale: isStale, rank: this.d.ranker?.rowOf(page.user.login) ?? null, watchers: this.watchers(page.user.login) } };
  }

  private watchers(login: string): number {
    try {
      return (this.d.db.prepare("SELECT count(*) AS n FROM holder_watch WHERE login_lc = ?").get(login.toLowerCase()) as { n: number }).n;
    } catch {
      return 0;
    }
  }

  buildUser(u: GhUserApi, events: GhEvent[], repos: GhRepoApi[]): GhUserPage {
    const now = this.now();
    const type: "user" | "org" = u.type === "Organization" ? "org" : "user";
    const keys = dayKeys(now, 84);
    const own = events.map((e) => ({ type: e.type === "CreateEvent" && e.payload.ref_type === "repository" ? "new-repo" : e.type === "PushEvent" ? "push" : e.type, repo: e.repo?.name ?? null, at: e.created_at })).filter((e) => counts({ type: e.type }, type));
    const per = new Map<string, number>();
    for (const e of own) per.set(e.at.slice(0, 10), (per.get(e.at.slice(0, 10)) ?? 0) + 1);
    const hours = Array.from({ length: 24 }, () => 0);
    const mix = new Map<string, number>();
    for (const e of own) {
      if (now - Date.parse(e.at) > 30 * DAY) continue;
      hours[new Date(e.at).getUTCHours()]++;
      mix.set(category(e.type), (mix.get(category(e.type)) ?? 0) + 1);
    }
    const recent: ActivityLine[] = own.slice(0, 16).map((e) => ({ type: e.type, what: WHAT[e.type] ?? "was active in", repo: e.repo, at: e.at, url: e.repo ? `https://github.com/${e.repo}` : null }));
    const readAt = new Date(now).toISOString();
    const card = (r: GhRepoApi): RepoCard => ({ name: r.name, fullName: r.full_name, description: r.description ? tidy(r.description) : null, language: r.language, stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, topics: r.topics ?? [], createdAt: r.created_at, pushedAt: r.pushed_at, url: r.html_url, readAt });
    const mine = repos.filter((r) => !r.fork && !r.private);
    const langs = new Map<string, number>();
    for (const r of mine) if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
    const user: GhUser = {
      login: u.login,
      name: u.name ? tidy(u.name) : null,
      type,
      bio: u.bio ? tidy(u.bio).slice(0, 300) : null,
      company: u.company ? tidy(u.company) : null,
      blog: u.blog && /^https?:\/\//.test(u.blog) ? u.blog : u.blog ? `https://${u.blog}` : null,
      followers: u.followers ?? null,
      following: u.following ?? null,
      publicRepos: u.public_repos ?? null,
      createdAt: u.created_at ?? null,
      url: u.html_url,
    };
    return {
      user,
      days: keys.map((d) => ({ day: d, events: per.get(d) ?? 0, items: 0 })),
      hours,
      mix: CATEGORIES.map((label) => ({ label, count: mix.get(label) ?? 0 })).filter((m) => m.count > 0),
      recent,
      repos: [...mine].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 6).map(card),
      fresh: [...mine].sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "")).slice(0, 6).map(card),
      languages: [...langs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, repos: n })),
      readAt,
      stale: false,
      rank: null,
      watchers: 0,
    };
  }

  /** The basics of an account (holders adding it): from a kept page, else one request. Null when there is no such account. */
  async account(loginInput: string, visitor: string): Promise<{ login: string; type: "user" | "org"; name: string | null; followers: number | null } | null> {
    const login = loginInput.replace(/^@/, "");
    if (!LOGIN_RE.test(login) || denied(this.d.rank, login, { privateOnly: true })) return null;
    const have = this.kept(`user:${login.toLowerCase()}`) ?? this.kept(`basic:${login.toLowerCase()}`);
    if (have?.status === 404) return null;
    if (have?.body) {
      const j = JSON.parse(have.body) as GhUserPage | GhUser;
      const u = "user" in j ? j.user : j;
      return { login: u.login, type: u.type, name: u.name, followers: u.followers };
    }
    const wait = this.take(visitor, 1);
    if (wait) this.busy(wait);
    const u = await this.d.gh.get<GhUserApi>(`/users/${login}`, { conditional: false });
    if (u.status === 404) {
      this.keep(`basic:${login.toLowerCase()}`, 404, null);
      return null;
    }
    if (!u.data) this.busy(u.retryInSec ?? 60);
    const basic: GhUser = { login: u.data!.login, name: u.data!.name, type: u.data!.type === "Organization" ? "org" : "user", bio: null, company: null, blog: null, followers: u.data!.followers, following: null, publicRepos: u.data!.public_repos, createdAt: u.data!.created_at, url: u.data!.html_url };
    this.keep(`basic:${login.toLowerCase()}`, 200, JSON.stringify(basic));
    return { login: basic.login, type: basic.type, name: basic.name, followers: basic.followers };
  }

  /** May this login's picture be fetched (a looked-up account)? Its GitHub spelling when so. */
  lookedUp(login: string): string | null {
    const r = this.d.db.prepare("SELECT body FROM gh_lookup WHERE k IN (?, ?) AND status = 200").get(`user:${login.toLowerCase()}`, `basic:${login.toLowerCase()}`) as { body: string } | undefined;
    if (!r) return null;
    try {
      const j = JSON.parse(r.body) as GhUserPage | GhUser;
      return "user" in j ? j.user.login : j.login;
    } catch {
      return null;
    }
  }

  // ---- a repo ----

  private routeOf(owner: string): { scout: GhRepoPage["scout"]; why: string; group: GhRepoPage["owner"]["group"] } {
    const e = this.d.registry.get(owner);
    if (e) {
      const s = scoutFor(e.group);
      return { scout: s.id, why: `${e.handle} is in the ${CAMP_LABEL[e.group]} camp, which ${s.name} reads.`, group: e.group };
    }
    const ds = SCOUT_BY_ID.get("deepseek")!;
    return { scout: ds.id, why: `${owner} is not in a camp, so the read goes to ${ds.name}, the open source scout.`, group: null };
  }

  private keptRead(full: string): ScoutRead | null {
    try {
      const r = this.d.db.prepare("SELECT body FROM scout_reads WHERE full_name = ?").get(full.toLowerCase()) as { body: string } | undefined;
      return r ? (JSON.parse(r.body) as ScoutRead) : null;
    } catch {
      return null;
    }
  }

  private day = () => new Date(this.now()).toISOString().slice(0, 10);
  private readsBy(who: string | null, kind: "holder" | "public"): number {
    const q = who ? this.d.db.prepare("SELECT count(*) AS n FROM lookup_reads WHERE day = ? AND kind = ? AND who = ?").get(this.day(), kind, who) : this.d.db.prepare("SELECT count(*) AS n FROM lookup_reads WHERE day = ? AND kind = ?").get(this.day(), kind);
    return (q as { n: number }).n;
  }

  allowance(holder: string | null): ReadAllowance {
    const c = this.d.config;
    const mode = this.d.scouts?.mode ?? "off";
    const open = this.d.scouts ? this.d.scouts.deepReadOpen() : { ok: false as const, why: "The scouts are not running here." };
    const holderLeft = holder ? Math.max(0, c.holderReadsPerDay - this.readsBy(holder.toLowerCase(), "holder")) : null;
    const publicLeft = Math.max(0, c.publicReadsPerDay - this.readsBy(null, "public"));
    let why: string | null = open.ok ? null : open.why;
    if (!why && holder && holderLeft === 0) why = "Your free reads for today are used. They come back after midnight UTC.";
    if (!why && !holder && publicLeft === 0) why = "Today's shared reads are used. Holders get their own free reads.";
    return { open: !why, why, mode, holderPerDay: c.holderReadsPerDay, holderLeft, publicPerDay: c.publicReadsPerDay, publicLeft };
  }

  async repo(ownerIn: string, nameIn: string, visitor: string, holder: string | null): Promise<{ page: GhRepoPage }> {
    if (!LOGIN_RE.test(ownerIn) || !REPO_RE.test(nameIn)) throw new LookupError(400, "That is not owner/name.");
    if (denied(this.d.rank, ownerIn, { privateOnly: true })) throw new LookupError(404, "No such public repo.");
    const k = `repo:${ownerIn.toLowerCase()}/${nameIn.toLowerCase()}`;
    const have = this.kept(k);
    const fresh = have && this.now() - have.at < (have.status === 404 ? this.d.config.notFoundTtlMs : this.d.config.pageTtlMs);
    if (!(have && fresh)) {
      const wait = this.take(visitor, 3);
      if (wait) {
        if (!have || have.status !== 200) this.busy(wait);
        return this.repoOut(have, holder, true);
      }
      const r = await this.d.gh.get<GhRepoApi>(`/repos/${ownerIn}/${nameIn}`, { conditional: false });
      if (r.status === 404 || r.data?.private) {
        this.keep(k, 404, null);
        throw new LookupError(404, "No such public repo.");
      }
      if (!r.data) {
        if (have?.status === 200) return this.repoOut(have, holder, true);
        this.busy(r.retryInSec ?? 60);
      }
      const repo = r.data!;
      const [cm, rel, readme] = await Promise.all([
        this.d.gh.get<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } | null } }[]>(`/repos/${repo.full_name}/commits?per_page=10`, { conditional: false }),
        this.d.gh.get<{ tag_name: string; name: string | null; published_at: string | null; html_url: string; prerelease: boolean; draft: boolean }[]>(`/repos/${repo.full_name}/releases?per_page=6`, { conditional: false }),
        this.readme(repo.full_name, repo.default_branch),
      ]);
      const readAt = new Date(this.now()).toISOString();
      const commits: CommitLine[] = (Array.isArray(cm.data) ? cm.data : []).slice(0, 10).map((c) => ({ sha: c.sha, message: tidy(c.commit.message.split("\n")[0].slice(0, 140)), author: c.commit.author?.name ?? null, at: c.commit.author?.date ?? null, url: c.html_url }));
      const releases: GhRelease[] = (Array.isArray(rel.data) ? rel.data : []).filter((x) => !x.draft).slice(0, 6).map((x) => ({ tag: x.tag_name, name: x.name ? tidy(x.name) : null, at: x.published_at, url: x.html_url, prerelease: x.prerelease }));
      const body = {
        repo: { ...factsFrom(repo, readAt), url: repo.html_url, defaultBranch: repo.default_branch, fork: repo.fork, parent: repo.parent?.full_name ?? null, watchers: repo.subscribers_count ?? null },
        readme,
        commits,
        releases,
        readAt,
        ownerType: repo.owner.type === "Organization" ? "org" : "user",
        ownerLogin: repo.owner.login,
      };
      this.keep(k, 200, JSON.stringify(body));
      return this.repoOut({ status: 200, body: JSON.stringify(body), at: this.now() }, holder);
    }
    return this.repoOut(have, holder);
  }

  private async readme(full: string, branch: string): Promise<string | null> {
    for (const f of ["README.md", "readme.md", "README", "README.rst"]) {
      const t = await this.d.gh.raw(`https://raw.githubusercontent.com/${full}/${encodeURIComponent(branch || "HEAD")}/${f}`, 12_000);
      if (t != null) return plainText(t, 18, 1600) || null;
    }
    return null;
  }

  private repoOut(have: { status: number; body: string | null; at: number } | null, holder: string | null, stale = false): { page: GhRepoPage } {
    if (!have || have.status === 404 || !have.body) throw new LookupError(404, "No such public repo.");
    const b = JSON.parse(have.body) as Omit<GhRepoPage, "owner" | "scout" | "scoutWhy" | "read" | "allowance" | "stale"> & { ownerType: "user" | "org"; ownerLogin: string };
    const route = this.routeOf(b.ownerLogin);
    const { ownerType, ownerLogin, ...rest } = b;
    return {
      page: {
        ...rest,
        stale: stale || this.now() - have.at >= this.d.config.pageTtlMs,
        owner: { login: ownerLogin, type: ownerType, onWatchlist: !!this.d.registry.get(ownerLogin), inTop: this.d.registry.inTop(ownerLogin), group: route.group },
        scout: route.scout,
        scoutWhy: route.why,
        read: this.keptRead(b.repo.fullName),
        allowance: this.allowance(holder),
      },
    };
  }

  /** A scout reads the repo (the deep read), within the day's allowances and the scouts' caps. */
  async read(owner: string, name: string, visitor: string, holder: string | null): Promise<{ read: ScoutRead; allowance: ReadAllowance }> {
    if (!LOGIN_RE.test(owner) || !REPO_RE.test(name)) throw new LookupError(400, "That is not owner/name.");
    if (denied(this.d.rank, owner, { privateOnly: true })) throw new LookupError(404, "No such public repo.");
    const full = `${owner}/${name}`;
    const kept = this.keptRead(full);
    const keptAt = kept ? Date.parse(kept.readAt) : 0;
    if (kept && this.now() - keptAt < 6 * HOUR) return { read: { ...kept, cached: true }, allowance: this.allowance(holder) };
    const a = this.allowance(holder);
    if (!a.open) throw new LookupError(a.mode === "model" ? 429 : 503, a.why ?? "Reads are closed right now.");
    if (!holder && this.readsBy(visitor, "public") >= this.d.config.visitorReadsPerDay) throw new LookupError(429, `At most ${this.d.config.visitorReadsPerDay} shared reads a day each. Holders get their own.`);
    const wait = this.take(visitor, 2);
    if (wait) this.busy(wait);
    const r = (await this.d.scouts!.readOnDemand(full, { gh: this.d.gh, route: this.routeOf(owner).scout })) as ScoutRead;
    if (!r.cached) this.d.db.prepare("INSERT INTO lookup_reads (at, day, who, kind, repo) VALUES (?, ?, ?, ?, ?)").run(this.now(), this.day(), holder ? holder.toLowerCase() : visitor, holder ? "holder" : "public", full.toLowerCase());
    return { read: r, allowance: this.allowance(holder) };
  }

  // ---- search ----

  async search(qIn: string, visitor: string, cutoffSearch?: (q: string) => SearchResult): Promise<LookupResult> {
    const q = qIn.trim().slice(0, 80);
    const parsed = parseQuery(q);
    const direct =
      parsed.kind === "user"
        ? { kind: "user" as const, href: this.d.registry.get(parsed.login) ? `/builders/${this.d.registry.get(parsed.login)!.handle}` : `/gh/${parsed.login}`, label: `@${parsed.login}` }
        : parsed.kind === "repo"
          ? { kind: "repo" as const, href: `/gh/${parsed.owner}/${parsed.name}`, label: `${parsed.owner}/${parsed.name}` }
          : null;
    const watch = q ? (cutoffSearch ?? this.d.searchWatch)(parsed.kind === "repo" ? `${parsed.name}` : q) : { items: [], builders: [] };
    const out: LookupResult = { q, direct: direct && !denied(this.d.rank, direct.label.replace(/^@/, "").split("/")[0], { privateOnly: true }) ? direct : null, watch, github: { users: [], repos: [], busy: false, retryInSec: null } };
    if (q.length < 2) return out;
    const k = `search:${q.toLowerCase()}`;
    const have = this.kept(k);
    let body: { users: LookupResult["github"]["users"]; repos: LookupResult["github"]["repos"] } | null;
    if (have?.body && this.now() - have.at < this.d.config.searchTtlMs) body = JSON.parse(have.body);
    else {
      const wait = this.take(visitor, 2, true);
      if (wait) {
        if (have?.body) body = JSON.parse(have.body);
        else return { ...out, github: { users: [], repos: [], busy: true, retryInSec: wait } };
      } else {
        const text = parsed.kind === "repo" ? `${parsed.name} user:${parsed.owner}` : q;
        const [u, r] = await Promise.all([
          this.d.gh.get<{ items?: { login: string; type: string }[] }>(`/search/users?q=${encodeURIComponent(parsed.kind === "repo" ? parsed.owner : q)}&per_page=6`, { conditional: false }),
          this.d.gh.get<{ items?: { full_name: string; description: string | null; stargazers_count: number; language: string | null; pushed_at: string | null; fork: boolean }[] }>(`/search/repositories?q=${encodeURIComponent(text)}&sort=stars&per_page=8`, { conditional: false }),
        ]);
        if (!u.data && !r.data) {
          if (have?.body) body = JSON.parse(have.body);
          else return { ...out, github: { users: [], repos: [], busy: true, retryInSec: u.retryInSec ?? r.retryInSec ?? 60 } };
        } else {
          body = {
            users: (u.data?.items ?? []).map((x) => ({ login: x.login, type: x.type === "Organization" ? ("org" as const) : ("user" as const) })),
            repos: (r.data?.items ?? []).map((x) => ({ fullName: x.full_name, description: x.description ? tidy(x.description).slice(0, 160) : null, stars: x.stargazers_count ?? 0, language: x.language, pushedAt: x.pushed_at })),
          };
          this.keep(k, 200, JSON.stringify(body));
        }
      }
    }
    // the watched are listed above; GitHub's list only holds the rest, and never the private list
    const watched = new Set(watch.builders.map((b) => b.handle.toLowerCase()));
    const hide = (login: string) => denied(this.d.rank, login, { privateOnly: true }) || watched.has(login.toLowerCase()) || !!this.d.registry.get(login);
    return { ...out, github: { users: (body?.users ?? []).filter((x) => !hide(x.login)), repos: (body?.repos ?? []).filter((x) => !hide(x.fullName.split("/")[0])), busy: false, retryInSec: null } };
  }
}
