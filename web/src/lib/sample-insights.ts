import { SAMPLE_AS_OF, SAMPLE_ITEMS, SAMPLE_WATCHLIST } from "./sample";
import type { BuilderProfile, BuilderStats, DayCount, FeedItem, GroupKey, ItemMore, Pulse, SearchResult } from "./types";

// The insight shapes (pulse, builders, a builder's page) worked out from the sample lines alone, for the site with no
// engine. Nothing is made up beyond the sample itself: every number is a count of sample lines, and everything is
// marked sample. The only real person is toly, and only his real repo is counted for him.

const DAY = 86_400_000;
const GROUPS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];
const dayOf = (iso: string) => iso.slice(0, 10);

export function dayKeysTo(endIso: string, n: number): string[] {
  const last = Date.parse(dayOf(endIso) + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => dayOf(new Date(last - (n - 1 - i) * DAY).toISOString()));
}

const members = () => SAMPLE_WATCHLIST.flatMap((g) => g.members);
const linesOf = (handle: string) => SAMPLE_ITEMS.filter((it) => it.handle === handle);
const byScore = (a: FeedItem, b: FeedItem) => (b.score ?? 0) - (a.score ?? 0);

function stats(handle: string): BuilderStats | null {
  const bare = (h: string) => h.replace(/^@/, "").toLowerCase();
  const m = members().find((b) => bare(b.handle) === bare(handle));
  if (!m) return null;
  const lines = linesOf(m.handle);
  const keys = dayKeysTo(SAMPLE_AS_OF, 14);
  const last = [...lines].sort((a, b) => b.githubAt.localeCompare(a.githubAt))[0];
  return {
    handle: m.handle,
    ...(m.name ? { name: m.name } : {}),
    ...(m.org ? { org: m.org } : {}),
    group: m.group,
    type: "user",
    followers: null,
    read: true,
    lastReadAt: SAMPLE_AS_OF,
    lastActiveAt: last?.githubAt ?? null,
    lastWhat: last ? { repo: "created", push: "pushed to", release: "released", gist: "posted a gist" }[last.kind] : null,
    lastRepo: last ? last.repo : null,
    events7d: lines.length,
    events30d: lines.length,
    items: lines.length,
    catches: lines.filter((l) => l.heat === "high" || l.heat === "veryHigh").length,
    spark: keys.map((k) => lines.filter((l) => dayOf(l.githubAt) === k).length),
    sample: true,
  };
}

export function sampleBuilders(): BuilderStats[] {
  return members()
    .map((m) => stats(m.handle))
    .filter((b): b is BuilderStats => !!b);
}

export function sampleProfile(handle: string): BuilderProfile | null {
  const s = stats(handle);
  if (!s) return null;
  const lines = linesOf(s.handle);
  const keys = dayKeysTo(SAMPLE_AS_OF, 84);
  const hours = Array.from({ length: 24 }, () => 0);
  for (const l of lines) hours[new Date(l.githubAt).getUTCHours()]++;
  return {
    ...s,
    source: null,
    days: keys.map((d): DayCount => ({ day: d, events: lines.filter((l) => dayOf(l.githubAt) === d).length, items: lines.filter((l) => dayOf(l.githubAt) === d).length })),
    hours,
    mix: [{ label: "code", count: lines.length }],
    recent: lines.map((l) => ({ type: l.kind, what: s.lastWhat ?? "was active in", repo: l.repo, at: l.githubAt, url: l.url })),
    lines,
    hottest: [...lines].sort(byScore).slice(0, 3),
    repos: [],
    languages: [],
    touched: lines.map((l) => ({ repo: l.repo, count: 1 })),
  };
}

export function samplePulse(): Pulse {
  const builders = sampleBuilders();
  const end = Date.parse(SAMPLE_AS_OF);
  const hourStart = Math.floor(end / 3_600_000) * 3_600_000;
  const hours = Array.from({ length: 24 }, (_, i) => ({
    at: new Date(hourStart - (23 - i) * 3_600_000).toISOString(),
    total: 0,
    groups: Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<GroupKey, number>,
  }));
  for (const it of SAMPLE_ITEMS) {
    const t = Date.parse(it.githubAt);
    const i = 23 - Math.floor((hourStart - Math.floor(t / 3_600_000) * 3_600_000) / 3_600_000);
    if (hours[i]) {
      hours[i].total++;
      hours[i].groups[it.group]++;
    }
  }
  const keys = dayKeysTo(SAMPLE_AS_OF, 84);
  const days = keys.map((d) => {
    const n = SAMPLE_ITEMS.filter((l) => dayOf(l.githubAt) === d).length;
    return { day: d, events: n, items: n };
  });
  const catches = SAMPLE_ITEMS.filter((l) => l.heat === "high" || l.heat === "veryHigh");
  return {
    asOf: SAMPLE_AS_OF,
    totals: {
      accounts: SAMPLE_WATCHLIST.reduce((n, g) => n + g.count, 0),
      accountsRead: builders.length,
      events: SAMPLE_ITEMS.length,
      events24h: SAMPLE_ITEMS.length,
      lines: SAMPLE_ITEMS.length,
      lines24h: SAMPLE_ITEMS.length,
      catches: catches.length,
      catches7d: catches.length,
      active24h: builders.length,
      lastLineAt: [...SAMPLE_ITEMS].sort((a, b) => b.githubAt.localeCompare(a.githubAt))[0].githubAt,
      lastReadAt: SAMPLE_AS_OF,
    },
    hours,
    days,
    groups: GROUPS.map((g) => {
      const mine = builders.filter((b) => b.group === g);
      return { group: g, accounts: SAMPLE_WATCHLIST.find((w) => w.group === g)?.count ?? 0, events7d: mine.reduce((n, b) => n + b.events7d, 0), lines: mine.reduce((n, b) => n + b.items, 0), active24h: mine.length };
    }),
    active: builders
      .filter((b) => b.lastActiveAt)
      .sort((a, b) => b.lastActiveAt!.localeCompare(a.lastActiveAt!))
      .map((b) => ({ handle: b.handle, ...(b.name ? { name: b.name } : {}), group: b.group, at: b.lastActiveAt!, what: b.lastWhat ?? "was active in", repo: b.lastRepo })),
    leaders: [...builders].sort((a, b) => b.events7d - a.events7d || b.catches - a.catches),
    hottest: [...SAMPLE_ITEMS].sort(byScore).slice(0, 6),
    busiestDays: [{ day: dayOf(SAMPLE_AS_OF), events: SAMPLE_ITEMS.length, items: SAMPLE_ITEMS.length, top: null }],
    languages: [],
    topics: [],
    fresh: [],
    sample: true,
  };
}

export function sampleMore(it: FeedItem): ItemMore {
  return { repo: null, text: null, commits: null, change: null, related: linesOf(it.handle).filter((l) => l.id !== it.id).slice(0, 4), pending: [] };
}

/** Search the sample: every word must match a line's repo, handle, summary or version, or a builder's names. */
export function searchSample(q: string): SearchResult {
  const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean);
  if (!words.length) return { items: [], builders: [] };
  const hay = (s: (string | undefined)[]) => s.filter(Boolean).join(" ").toLowerCase();
  return {
    items: SAMPLE_ITEMS.filter((it) => words.every((w) => hay([it.repo, it.handle, it.summary, it.version, it.name]).includes(w))),
    builders: members().filter((b) => words.every((w) => hay([b.handle, b.name, b.org]).includes(w))),
  };
}
