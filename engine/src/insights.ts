// What PUSHD has seen, added up: each watched account's public activity (every event the watcher read, kept as a
// line or not), the feed lines, the catches, and the repo lists GitHub already sent. Nothing here asks GitHub for
// anything: it only reads the store. Everything takes a cutoff (the public delay), so the public view never shows
// activity before the holders' live view does.
//
// Orgs: GitHub lists everything that happens in an org's repos, by anyone (strangers' stars, issues and pull
// requests too). So for an org only code activity counts: pushes, new branches and tags, releases, new repos.
import { HEAT_RANK, queryItems, type DB, type StoredItem } from "./db.ts";
import { whoOf } from "./registry.ts";
import type { ActivityLine, BuilderProfile, BuilderStats, DayCount, FeedItem, GroupKey, Pulse, RepoCard, WatchEntry } from "./types.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const GROUP_KEYS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];

/** How each event type reads in a sentence: "toly pushed to aeyakovenko/percolator". */
export const WHAT: Record<string, string> = {
  push: "pushed to",
  "new-repo": "created",
  "made-public": "made public",
  release: "released",
  ReleaseEvent: "released",
  PublicEvent: "made public",
  CreateEvent: "created a branch or tag in",
  DeleteEvent: "deleted a branch in",
  PullRequestEvent: "worked on a pull request in",
  PullRequestReviewEvent: "reviewed a pull request in",
  PullRequestReviewCommentEvent: "reviewed code in",
  IssuesEvent: "worked on an issue in",
  IssueCommentEvent: "commented in",
  CommitCommentEvent: "commented on a commit in",
  WatchEvent: "starred",
  ForkEvent: "forked",
  Gist: "posted a gist",
  MemberEvent: "added a member to",
  GollumEvent: "edited the wiki of",
};

/** The kinds of activity, for a profile's mix. */
export function category(type: string): string {
  if (["push", "new-repo", "made-public", "release", "ReleaseEvent", "PublicEvent", "CreateEvent", "DeleteEvent"].includes(type)) return "code";
  if (type.startsWith("PullRequest")) return "pull requests";
  if (type === "IssuesEvent" || type === "IssueCommentEvent" || type === "CommitCommentEvent") return "issues";
  if (type === "WatchEvent" || type === "ForkEvent") return "stars and forks";
  if (type === "Gist") return "gists";
  return "other";
}
export const CATEGORIES = ["code", "pull requests", "issues", "stars and forks", "gists", "other"];

/** Does this event count as the account's own activity? Orgs: code only (see the top of the file). */
export const counts = (e: { type: string }, type: "user" | "org") => e.type !== "RepoList" && (type === "user" || category(e.type) === "code");

type EventRow = { handle: string; type: string; repo: string | null; github_at: string };

const dayOf = (iso: string) => iso.slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

/** The last n UTC days ending with the day of `end`, oldest first. */
export function dayKeys(end: number, n: number): string[] {
  const last = Date.parse(dayOf(iso(end)) + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => dayOf(iso(last - (n - 1 - i) * DAY)));
}

// ---- a small memo: the same answer for a few seconds, so a busy page does not add the store up again ----

const memos = new Map<string, { at: number; v: unknown }>();
function memo<T>(key: string, ttlMs: number, now: number, fn: () => T): T {
  const hit = memos.get(key);
  if (hit && now - hit.at < ttlMs) return hit.v as T;
  const v = fn();
  memos.set(key, { at: now, v });
  if (memos.size > 500) for (const k of [...memos.keys()].slice(0, 250)) memos.delete(k);
  return v;
}
/** Forget every memo (the tests write to the store between reads). */
export const forgetMemos = () => memos.clear();

// ---- repo lists GitHub already sent (the watcher's conditional-request cache) ----

type ListRepo = {
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count?: number;
  topics?: string[];
  created_at: string;
  pushed_at: string | null;
  html_url: string;
  fork: boolean;
  private?: boolean;
  archived?: boolean;
  license?: { spdx_id?: string | null; name?: string | null } | null;
  homepage?: string | null;
  open_issues_count?: number;
};

const LIST_URL = /^https:\/\/api\.github\.com\/users\/([^/]+)\/repos\?/;

/** Every watched account's stored repo list, by handle (lower case). Read again only when the cache changed. */
export function repoLists(db: DB): Map<string, { readAt: string; repos: ListRepo[] }> {
  const sig = db.prepare("SELECT count(*) AS n, max(fetched_at) AS t FROM http_cache WHERE url LIKE 'https://api.github.com/users/%/repos?%'").get() as { n: number; t: string | null };
  return memo(`lists:${sig.n}:${sig.t}`, 3_600_000, Date.now(), () => {
    const out = new Map<string, { readAt: string; repos: ListRepo[] }>();
    const rows = db.prepare("SELECT url, body, fetched_at FROM http_cache WHERE url LIKE 'https://api.github.com/users/%/repos?%'").all() as { url: string; body: string; fetched_at: string }[];
    for (const r of rows) {
      const m = LIST_URL.exec(r.url);
      if (!m) continue;
      try {
        const repos = JSON.parse(r.body) as ListRepo[];
        if (Array.isArray(repos)) out.set(m[1].toLowerCase(), { readAt: r.fetched_at, repos: repos.filter((x) => x && !x.private) });
      } catch {
        /* a body that is not JSON is skipped */
      }
    }
    return out;
  });
}

/** Long dashes read as a plain hyphen, whoever wrote the text (the site never shows them). */
const plainDashes = (s: string) => s.replace(/[\u2013\u2014]/g, "-");

export const repoCard = (r: ListRepo, readAt: string | null): RepoCard => ({
  name: r.name,
  fullName: r.full_name,
  description: r.description ? plainDashes(r.description) : null,
  language: r.language,
  stars: r.stargazers_count ?? 0,
  forks: r.forks_count ?? 0,
  topics: r.topics ?? [],
  createdAt: r.created_at,
  pushedAt: r.pushed_at,
  url: r.html_url,
  readAt,
});

/** A repo as the stored lists have it, by full name. */
export function listedRepo(db: DB, fullName: string): { repo: ListRepo; readAt: string } | null {
  const owner = fullName.split("/")[0]?.toLowerCase();
  const list = repoLists(db).get(owner);
  const repo = list?.repos.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase());
  return repo && list ? { repo, readAt: list.readAt } : null;
}

// ---- the store, added up ----

export type InsightOptions = {
  db: DB;
  /** the watched list now (the Top N) */
  accounts: WatchEntry[];
  /** everyone known by name (the watched, the ones that were, the old list); defaults to `accounts` */
  known?: WatchEntry[];
  /** the site's shape for a stored line (name, org and picture filled in) */
  toItem: (it: StoredItem) => FeedItem;
  now?: () => number;
};

const TOP_TYPES_SQL = "type <> 'RepoList'";

export class Insights {
  constructor(private readonly o: InsightOptions) {}
  private get who(): Map<string, WatchEntry> {
    return whoOf(this.o.known ?? this.o.accounts);
  }
  private now = () => (this.o.now ?? Date.now)();
  entry = (handle: string) => this.who.get(handle.replace(/^@/, "").toLowerCase()) ?? null;

  /** The account's own activity since a moment, seen before the cutoff, newest first. */
  private events(sinceIso: string, cutoff: string, handle?: string): EventRow[] {
    const rows = handle
      ? (this.o.db.prepare(`SELECT handle, type, repo, github_at FROM events WHERE handle = ? AND github_at >= ? AND seen_at <= ? AND ${TOP_TYPES_SQL} ORDER BY github_at DESC`).all(handle, sinceIso, cutoff) as EventRow[])
      : (this.o.db.prepare(`SELECT handle, type, repo, github_at FROM events WHERE github_at >= ? AND seen_at <= ? AND ${TOP_TYPES_SQL} ORDER BY github_at DESC`).all(sinceIso, cutoff) as EventRow[]);
    return rows.filter((e) => {
      const a = this.who.get(e.handle.toLowerCase());
      return a ? counts(e, a.type) : false;
    });
  }

  /** The account's latest own activity seen before the cutoff, at any time. */
  private last(a: WatchEntry, cutoff: string): EventRow | null {
    const codeOnly = a.type === "org" ? " AND type IN ('push','new-repo','made-public','release','ReleaseEvent','PublicEvent','CreateEvent','DeleteEvent')" : "";
    return (
      (this.o.db.prepare(`SELECT handle, type, repo, github_at FROM events WHERE handle = ? AND seen_at <= ? AND ${TOP_TYPES_SQL}${codeOnly} AND github_at <= ? ORDER BY github_at DESC LIMIT 1`).get(a.handle, cutoff, cutoff) as EventRow | undefined) ?? null
    );
  }

  /** Every watched account with what PUSHD has seen of it. */
  builders(cutoff: string, list: WatchEntry[] = this.o.accounts): BuilderStats[] {
    const sig = list === this.o.accounts ? `top:${list.length}:${list[0]?.handle ?? ""}:${list[list.length - 1]?.handle ?? ""}` : list.map((a) => a.handle).join(",");
    return memo(`builders:${cutoff.slice(0, 16)}:${sig}`, 30_000, this.now(), () => {
      const db = this.o.db;
      const end = Date.parse(cutoff);
      const days14 = dayKeys(end, 14);
      const since30 = iso(end - 30 * DAY);
      const since7 = iso(end - 7 * DAY);
      const ev = this.events(since30, cutoff);
      const lines = new Map((db.prepare("SELECT lower(handle) AS h, count(*) AS n FROM items WHERE shown_at <= ? AND hidden = 0 GROUP BY lower(handle)").all(cutoff) as { h: string; n: number }[]).map((r) => [r.h, r.n]));
      const catches = new Map((db.prepare("SELECT lower(handle) AS h, count(*) AS n FROM catches WHERE shown_at <= ? GROUP BY lower(handle)").all(cutoff) as { h: string; n: number }[]).map((r) => [r.h, r.n]));
      const read = new Map((db.prepare("SELECT lower(handle) AS h, last_poll_at AS t FROM accounts WHERE polls > 0").all() as { h: string; t: string | null }[]).map((r) => [r.h, r.t]));
      return list.map((a): BuilderStats => {
        const h = a.handle.toLowerCase();
        const mine = ev.filter((e) => e.handle.toLowerCase() === h);
        const per = new Map<string, number>();
        for (const e of mine) per.set(dayOf(e.github_at), (per.get(dayOf(e.github_at)) ?? 0) + 1);
        const last = this.last(a, cutoff);
        return {
          handle: a.handle,
          ...(a.token ? { token: a.token } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.org && a.org !== a.name ? { org: a.org } : {}),
          group: a.group,
          type: a.type,
          followers: a.followers ?? null,
          read: read.has(h),
          lastReadAt: read.get(h) ?? null,
          lastActiveAt: last?.github_at ?? null,
          lastWhat: last ? (WHAT[last.type] ?? "was active in") : null,
          lastRepo: last?.repo ?? null,
          events7d: mine.filter((e) => e.github_at >= since7).length,
          events30d: mine.length,
          items: lines.get(h) ?? 0,
          catches: catches.get(h) ?? 0,
          spark: days14.map((d) => per.get(d) ?? 0),
          sample: false,
        };
      });
    });
  }

  /** One account's page. null when the handle is not on the watchlist. */
  profile(handle: string, cutoff: string): BuilderProfile | null {
    const a = this.entry(handle);
    if (!a) return null;
    const stats = this.builders(cutoff).find((b) => b.handle === a.handle) ?? this.builders(cutoff, [a])[0];
    const db = this.o.db;
    const end = Date.parse(cutoff);
    const keys = dayKeys(end, 84);
    const ev = this.events(keys[0] + "T00:00:00Z", cutoff, a.handle);
    const since30 = iso(end - 30 * DAY);
    const lines = queryItems(db, { shownBefore: cutoff, handle: a.handle, limit: 200 });
    const perDay = new Map<string, number>();
    for (const e of ev) perDay.set(dayOf(e.github_at), (perDay.get(dayOf(e.github_at)) ?? 0) + 1);
    const linesPerDay = new Map<string, number>();
    for (const l of lines) linesPerDay.set(dayOf(l.githubAt), (linesPerDay.get(dayOf(l.githubAt)) ?? 0) + 1);
    const hours = Array.from({ length: 24 }, () => 0);
    const mix = new Map<string, number>();
    const touched = new Map<string, number>();
    for (const e of ev) {
      if (e.github_at < since30) continue;
      if (e.repo) touched.set(e.repo, (touched.get(e.repo) ?? 0) + 1);
      hours[new Date(e.github_at).getUTCHours()]++;
      mix.set(category(e.type), (mix.get(category(e.type)) ?? 0) + 1);
    }
    const recentRows = db
      .prepare(`SELECT handle, type, repo, github_at FROM events WHERE handle = ? AND seen_at <= ? AND github_at <= ? AND ${TOP_TYPES_SQL} ORDER BY github_at DESC LIMIT 80`)
      .all(a.handle, cutoff, cutoff) as EventRow[];
    const recent: ActivityLine[] = recentRows
      .filter((e) => counts(e, a.type))
      .slice(0, 16)
      .map((e) => ({ type: e.type, what: WHAT[e.type] ?? "was active in", repo: e.repo, at: e.github_at, url: e.repo ? `https://github.com/${e.repo}` : null }));
    const list = repoLists(db).get(a.handle.toLowerCase());
    const own = (list?.repos ?? []).filter((r) => !r.fork);
    const repos = [...own].sort((x, y) => (y.pushed_at ?? y.created_at).localeCompare(x.pushed_at ?? x.created_at)).slice(0, 6).map((r) => repoCard(r, list?.readAt ?? null));
    const langs = new Map<string, number>();
    for (const r of own) if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
    const items = lines.map(this.o.toItem);
    return {
      ...stats,
      source: a.source ?? null,
      days: keys.map((d) => ({ day: d, events: perDay.get(d) ?? 0, items: linesPerDay.get(d) ?? 0 })),
      hours,
      mix: CATEGORIES.map((label) => ({ label, count: mix.get(label) ?? 0 })).filter((m) => m.count > 0),
      recent,
      lines: items.slice(0, 20),
      hottest: [...items].sort((x, y) => (y.score ?? 0) - (x.score ?? 0) || HEAT_RANK[y.heat] - HEAT_RANK[x.heat]).filter((i) => (i.score ?? 0) > 0).slice(0, 3),
      repos,
      languages: [...langs].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, repos]) => ({ name, repos })),
      touched: [...touched].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([repo, count]) => ({ repo, count })),
    };
  }

  /** The whole watchlist at a glance: activity by hour and day, the groups, leaderboards, languages, fresh repos. */
  pulse(cutoff: string): Pulse {
    return memo(`pulse:${cutoff.slice(0, 16)}`, 30_000, this.now(), () => {
      const db = this.o.db;
      const end = Date.parse(cutoff);
      const keys = dayKeys(end, 84);
      const ev = this.events(keys[0] + "T00:00:00Z", cutoff);
      const builders = this.builders(cutoff);
      const since24 = iso(end - DAY);
      const since7 = iso(end - 7 * DAY);
      const groupOf = (h: string) => this.who.get(h.toLowerCase())?.group ?? "oss";

      // the last 24 hours, by group
      const hourStart = Math.floor(end / HOUR) * HOUR;
      const hours = Array.from({ length: 24 }, (_, i) => ({ at: iso(hourStart - (23 - i) * HOUR), total: 0, groups: Object.fromEntries(GROUP_KEYS.map((g) => [g, 0])) as Record<GroupKey, number> }));
      for (const e of ev) {
        const t = Date.parse(e.github_at);
        if (t < hourStart - 23 * HOUR || t > end) continue;
        const slot = hours[23 - Math.floor((hourStart - Math.floor(t / HOUR) * HOUR) / HOUR)];
        if (!slot) continue;
        slot.total++;
        slot.groups[groupOf(e.handle)]++;
      }

      const lines = queryItems(db, { shownBefore: cutoff, limit: 500 });
      const perDay = new Map<string, { events: number; items: number; who: Map<string, number> }>();
      const day = (d: string) => perDay.get(d) ?? (perDay.set(d, { events: 0, items: 0, who: new Map() }), perDay.get(d)!);
      for (const e of ev) {
        const d = day(dayOf(e.github_at));
        d.events++;
        d.who.set(e.handle, (d.who.get(e.handle) ?? 0) + 1);
      }
      for (const l of lines) if (l.githubAt >= keys[0]) day(dayOf(l.githubAt)).items++;
      const days: DayCount[] = keys.map((k) => ({ day: k, events: perDay.get(k)?.events ?? 0, items: perDay.get(k)?.items ?? 0 }));
      const busiestDays = [...perDay.entries()]
        .filter(([, v]) => v.events > 0)
        .sort((x, y) => y[1].events - x[1].events)
        .slice(0, 5)
        .map(([d, v]) => ({ day: d, events: v.events, items: v.items, top: [...v.who].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null }));

      const active24 = new Set(ev.filter((e) => e.github_at >= since24).map((e) => e.handle.toLowerCase()));
      const groups = GROUP_KEYS.map((g) => {
        const members = builders.filter((b) => b.group === g);
        return {
          group: g,
          accounts: members.length,
          events7d: members.reduce((n, b) => n + b.events7d, 0),
          lines: members.reduce((n, b) => n + b.items, 0),
          active24h: members.filter((b) => active24.has(b.handle.toLowerCase())).length,
        };
      });

      const active = builders
        .filter((b) => b.lastActiveAt)
        .sort((x, y) => y.lastActiveAt!.localeCompare(x.lastActiveAt!))
        .slice(0, 10)
        .map((b) => ({ handle: b.handle, ...(b.name ? { name: b.name } : {}), group: b.group, at: b.lastActiveAt!, what: b.lastWhat ?? "was active in", repo: b.lastRepo }));
      const leaders = builders
        .filter((b) => b.events7d > 0 || b.items > 0)
        .sort((x, y) => y.events7d - x.events7d || y.items - x.items)
        .slice(0, 10);

      const since30 = iso(end - 30 * DAY);
      const hottest = lines
        .filter((l) => l.githubAt >= since30 && l.score > 0)
        .sort((x, y) => y.score - x.score || HEAT_RANK[y.heat] - HEAT_RANK[x.heat] || y.githubAt.localeCompare(x.githubAt))
        .slice(0, 6)
        .map(this.o.toItem);

      // languages and topics of the repos the watched accounts pushed to in the last 30 days, and the fresh repos
      const firstSeen = new Map((db.prepare("SELECT lower(full_name) AS f, first_seen_at AS t FROM repos").all() as { f: string; t: string }[]).map((r) => [r.f, r.t]));
      const langs = new Map<string, number>();
      const topics = new Map<string, number>();
      const fresh: Pulse["fresh"] = [];
      const since14 = iso(end - 14 * DAY);
      for (const [h, list] of repoLists(db)) {
        const a = this.who.get(h);
        if (!a) continue;
        for (const r of list.repos) {
          if (r.fork) continue;
          if ((r.pushed_at ?? r.created_at) >= since30) {
            if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
            for (const t of r.topics ?? []) topics.set(t, (topics.get(t) ?? 0) + 1);
          }
          const seen = firstSeen.get(r.full_name.toLowerCase());
          if (r.created_at >= since14 && r.created_at <= cutoff && (!seen || seen <= cutoff) && list.readAt <= cutoff)
            fresh.push({ ...repoCard(r, list.readAt), handle: a.handle, group: a.group });
        }
      }
      fresh.sort((x, y) => y.createdAt.localeCompare(x.createdAt));

      const totals = db
        .prepare(
          `SELECT (SELECT count(*) FROM events WHERE seen_at <= @c AND ${TOP_TYPES_SQL}) AS events,
                  (SELECT count(*) FROM items WHERE shown_at <= @c AND hidden = 0) AS lines,
                  (SELECT count(*) FROM items WHERE shown_at <= @c AND github_at >= @d AND hidden = 0) AS lines24h,
                  (SELECT count(*) FROM catches WHERE shown_at <= @c AND id NOT IN (SELECT id FROM items WHERE hidden = 1)) AS catches,
                  (SELECT count(*) FROM catches WHERE shown_at <= @c AND shown_at >= @w AND id NOT IN (SELECT id FROM items WHERE hidden = 1)) AS catches7d,
                  (SELECT max(shown_at) FROM items WHERE shown_at <= @c AND hidden = 0) AS lastLineAt,
                  (SELECT max(last_poll_at) FROM accounts) AS lastReadAt`,
        )
        .get({ c: cutoff, d: since24, w: since7 }) as { events: number; lines: number; lines24h: number; catches: number; catches7d: number; lastLineAt: string | null; lastReadAt: string | null };

      return {
        asOf: cutoff,
        totals: {
          accounts: this.o.accounts.length,
          accountsRead: builders.filter((b) => b.read).length,
          events: totals.events,
          events24h: ev.filter((e) => e.github_at >= since24).length,
          lines: totals.lines,
          lines24h: totals.lines24h,
          catches: totals.catches,
          catches7d: totals.catches7d,
          active24h: active24.size,
          lastLineAt: totals.lastLineAt,
          lastReadAt: totals.lastReadAt,
        },
        hours,
        days,
        groups,
        active,
        leaders,
        hottest,
        busiestDays,
        languages: [...langs].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, repos]) => ({ name, repos })),
        topics: [...topics].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([name, repos]) => ({ name, repos })),
        fresh: fresh.slice(0, 8),
        sample: false,
      };
    });
  }

  /** Lines and accounts that match a few words. */
  search(q: string, cutoff: string, limit = 20): { items: FeedItem[]; builders: { handle: string; name?: string; org?: string; group: GroupKey; sample: boolean }[] } {
    const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean).slice(0, 5);
    if (!words.length) return { items: [], builders: [] };
    const esc = (w: string) => `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const where = words.map((_, i) => `(lower(repo) LIKE @w${i} ESCAPE '\\' OR lower(handle) LIKE @w${i} ESCAPE '\\' OR lower(summary) LIKE @w${i} ESCAPE '\\' OR lower(coalesce(version, '')) LIKE @w${i} ESCAPE '\\')`).join(" AND ");
    const args: Record<string, unknown> = { c: cutoff, limit: Math.max(1, Math.min(50, limit)) };
    words.forEach((w, i) => (args[`w${i}`] = esc(w)));
    const ids = this.o.db.prepare(`SELECT id FROM items WHERE shown_at <= @c AND hidden = 0 AND ${where} ORDER BY github_at DESC LIMIT @limit`).all(args) as { id: string }[];
    const set = new Set(ids.map((r) => r.id));
    const items = queryItems(this.o.db, { shownBefore: cutoff, limit: 500 }).filter((i) => set.has(i.id)).map(this.o.toItem);
    const builders = this.o.accounts
      .filter((a) => words.every((w) => [a.handle, a.name, a.org].join(" ").toLowerCase().includes(w)))
      .slice(0, 12)
      .map((a) => ({ handle: a.handle, ...(a.name ? { name: a.name } : {}), ...(a.org && a.org !== a.name ? { org: a.org } : {}), group: a.group, sample: false, ...(a.token ? { token: a.token } : {}) }));
    return { items, builders };
  }
}
