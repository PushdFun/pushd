// One day at a time, for the replay and the daily brief: which days had activity, and everything on one day (every
// own event of the watched accounts, the feed lines, the new repos, by group and by hour). Same rules as
// src/insights.ts: an org counts code activity only, repo-list entries are not events, and nothing seen after the
// cutoff (the public delay) is shown. Nothing here asks GitHub for anything.
import { getItemById, type DB, type StoredItem } from "./db.ts";
import { counts, dayKeys, GROUP_KEYS, repoCard, repoLists, WHAT } from "./insights.ts";
import { whoOf } from "./registry.ts";
import type { FeedItem, GroupKey, RepoCard, WatchEntry } from "./types.ts";

const DAY = 86_400_000;

export type DaySummary = { day: string; events: number; lines: number; catches: number };

export type DayEvent = { handle: string; name?: string; group: GroupKey; type: string; what: string; repo: string | null; at: string };

export type DayDetail = {
  day: string;
  /** the public view's moment */
  asOf: string;
  /** every own event that day, oldest first (at most 2000) */
  events: DayEvent[];
  /** more events happened than are listed */
  truncated: boolean;
  totalEvents: number;
  /** the feed lines that happened that day, oldest first */
  lines: FeedItem[];
  catches: number;
  /** the busiest accounts that day */
  top: { handle: string; name?: string; group: GroupKey; events: number; lines: number }[];
  /** each group that day, and its average over the 7 days before */
  groups: { group: GroupKey; events: number; lines: number; avg7: number; accounts: number; read: number }[];
  /** events by hour of the day (UTC) */
  hours: number[];
  /** repos the watched accounts created that day, as their stored repo lists show */
  fresh: (RepoCard & { handle: string; group: GroupKey })[];
  /** how many accounts were active that day */
  active: number;
  sample: boolean;
};

type Row = { handle: string; type: string; repo: string | null; github_at: string };

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (d: string) => DAY_RE.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

export class Days {
  constructor(private readonly o: { db: DB; accounts: WatchEntry[]; known?: WatchEntry[]; toItem: (s: StoredItem) => FeedItem }) {}
  private get who(): Map<string, WatchEntry> {
    return whoOf(this.o.known ?? this.o.accounts);
  }

  /** Own events between two moments, seen before the cutoff, oldest first. */
  private events(from: string, to: string, cutoff: string): Row[] {
    const rows = this.o.db
      .prepare("SELECT handle, type, repo, github_at FROM events WHERE github_at >= ? AND github_at < ? AND github_at <= ? AND seen_at <= ? AND type <> 'RepoList' ORDER BY github_at ASC")
      .all(from, to, cutoff, cutoff) as Row[];
    return rows.filter((e) => {
      const a = this.who.get(e.handle.toLowerCase());
      return a ? counts(e, a.type) : false;
    });
  }

  private lineIds(from: string, to: string, cutoff: string): string[] {
    return (this.o.db.prepare("SELECT id FROM items WHERE github_at >= ? AND github_at < ? AND shown_at <= ? AND hidden = 0 ORDER BY github_at ASC, seq ASC").all(from, to, cutoff) as { id: string }[]).map((r) => r.id);
  }

  /** The last 84 days that had any activity or a line, newest first. */
  list(cutoff: string): DaySummary[] {
    const keys = dayKeys(Date.parse(cutoff), 84);
    const from = keys[0] + "T00:00:00Z";
    const to = new Date(Date.parse(keys[keys.length - 1] + "T00:00:00Z") + DAY).toISOString();
    const per = new Map<string, DaySummary>(keys.map((d) => [d, { day: d, events: 0, lines: 0, catches: 0 }]));
    for (const e of this.events(from, to, cutoff)) {
      const d = per.get(e.github_at.slice(0, 10));
      if (d) d.events++;
    }
    const lines = this.o.db.prepare("SELECT github_at, heat_rank FROM items WHERE github_at >= ? AND github_at < ? AND shown_at <= ? AND hidden = 0").all(from, to, cutoff) as { github_at: string; heat_rank: number }[];
    for (const l of lines) {
      const d = per.get(l.github_at.slice(0, 10));
      if (!d) continue;
      d.lines++;
      if (l.heat_rank >= 3) d.catches++;
    }
    return [...per.values()].filter((d) => d.events > 0 || d.lines > 0).reverse();
  }

  /** Everything on one day (UTC). */
  day(day: string, cutoff: string): DayDetail {
    const start = Date.parse(day + "T00:00:00Z");
    const from = new Date(start).toISOString();
    const to = new Date(start + DAY).toISOString();
    const rows = this.events(from, to, cutoff);
    const items = this.lineIds(from, to, cutoff)
      .map((id) => getItemById(this.o.db, id))
      .filter((x): x is NonNullable<typeof x> => !!x);
    const groupOf = (h: string): GroupKey => this.who.get(h.toLowerCase())?.group ?? "oss";

    const hours = Array.from({ length: 24 }, () => 0);
    const perHandle = new Map<string, { events: number; lines: number }>();
    const perGroup = new Map<GroupKey, { events: number; lines: number }>(GROUP_KEYS.map((g) => [g, { events: 0, lines: 0 }]));
    for (const e of rows) {
      hours[new Date(e.github_at).getUTCHours()]++;
      const h = perHandle.get(e.handle) ?? { events: 0, lines: 0 };
      h.events++;
      perHandle.set(e.handle, h);
      perGroup.get(groupOf(e.handle))!.events++;
    }
    for (const it of items) {
      const h = perHandle.get(it.handle) ?? { events: 0, lines: 0 };
      h.lines++;
      perHandle.set(it.handle, h);
      perGroup.get(it.group)!.lines++;
    }

    // each group's average day over the 7 days before
    const prev = this.events(new Date(start - 7 * DAY).toISOString(), from, cutoff);
    const prevPer = new Map<GroupKey, number>(GROUP_KEYS.map((g) => [g, 0]));
    for (const e of prev) prevPer.set(groupOf(e.handle), (prevPer.get(groupOf(e.handle)) ?? 0) + 1);

    const nameOf = (h: string) => {
      const a = this.who.get(h.toLowerCase());
      return a?.name ? { name: a.name } : {};
    };
    const events: DayEvent[] = rows.slice(0, 2000).map((e) => ({
      handle: e.handle,
      ...nameOf(e.handle),
      group: groupOf(e.handle),
      type: e.type,
      what: WHAT[e.type] ?? "was active in",
      repo: e.repo,
      at: e.github_at,
    }));

    const fresh: DayDetail["fresh"] = [];
    for (const [h, list] of repoLists(this.o.db)) {
      const a = this.who.get(h);
      if (!a || list.readAt > cutoff) continue;
      for (const r of list.repos) if (!r.fork && r.created_at >= from && r.created_at < to && r.created_at <= cutoff) fresh.push({ ...repoCard(r, list.readAt), handle: a.handle, group: a.group });
    }
    fresh.sort((x, y) => x.createdAt.localeCompare(y.createdAt));

    const read = new Set((this.o.db.prepare("SELECT lower(handle) AS h FROM accounts WHERE polls > 0").all() as { h: string }[]).map((r) => r.h));
    return {
      day,
      asOf: cutoff,
      events,
      truncated: rows.length > 2000,
      totalEvents: rows.length,
      lines: items.map(this.o.toItem),
      catches: items.filter((i) => i.heat === "high" || i.heat === "veryHigh").length,
      top: [...perHandle]
        .sort((x, y) => y[1].events - x[1].events || y[1].lines - x[1].lines)
        .slice(0, 6)
        .map(([handle, v]) => ({ handle, ...nameOf(handle), group: groupOf(handle), events: v.events, lines: v.lines })),
      groups: GROUP_KEYS.map((g) => ({
        group: g,
        events: perGroup.get(g)!.events,
        lines: perGroup.get(g)!.lines,
        avg7: Math.round(((prevPer.get(g) ?? 0) / 7) * 10) / 10,
        accounts: this.o.accounts.filter((a) => a.group === g).length,
        read: this.o.accounts.filter((a) => a.group === g && read.has(a.handle.toLowerCase())).length,
      })),
      hours,
      fresh: fresh.slice(0, 12),
      active: new Set([...rows.map((r) => r.handle.toLowerCase()), ...items.map((i) => i.handle.toLowerCase())]).size,
      sample: false,
    };
  }
}
