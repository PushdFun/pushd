import "server-only";
import { connection } from "next/server";
import { engineUrl, siteMediaUrl } from "./data";
import type { DayDetail, DaySummary } from "./day-types";
import { GROUP_ORDER, isCatch } from "./groups";
import { SAMPLE_AS_OF, SAMPLE_ITEMS, SAMPLE_WATCHLIST } from "./sample";
import type { FeedItem } from "./types";

// One day at a time, for the replay and the daily brief. With PUSHD_ENGINE_URL set the engine answers (src/days.ts,
// the public view); without it, the sample lines of 27 Oct 2026 make up the only day, marked sample. An engine that is
// set but silent gives nothing (null): a sample day must never pass for a real one.
//   GET /v1/days        { days: DaySummary[] }   newest first
//   GET /v1/day/:date   DayDetail

const TIMEOUT_MS = 12_000;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SAMPLE_DAY = SAMPLE_AS_OF.slice(0, 10);

async function engine<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(engineUrl() + path, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const WHAT: Record<FeedItem["kind"], string> = { repo: "created", push: "pushed to", release: "released", gist: "posted a gist" };

/** The sample day: the sample lines, each one counted as one event. */
export function sampleDay(): DayDetail {
  const lines = [...SAMPLE_ITEMS].sort((a, b) => a.githubAt.localeCompare(b.githubAt)).map((it) => ({ ...it, mediaUrl: null }));
  const hours = Array.from({ length: 24 }, () => 0);
  for (const l of lines) hours[new Date(l.githubAt).getUTCHours()]++;
  const handles = [...new Set(lines.map((l) => l.handle))];
  return {
    day: SAMPLE_DAY,
    asOf: SAMPLE_AS_OF,
    events: lines.map((l) => ({ handle: l.handle, ...(l.name ? { name: l.name } : {}), group: l.group, type: l.kind, what: WHAT[l.kind], repo: l.repo, at: l.githubAt })),
    truncated: false,
    totalEvents: lines.length,
    lines,
    catches: lines.filter((l) => isCatch(l.heat)).length,
    top: handles
      .map((h) => {
        const mine = lines.filter((l) => l.handle === h);
        return { handle: h, ...(mine[0].name ? { name: mine[0].name } : {}), group: mine[0].group, events: mine.length, lines: mine.length };
      })
      .sort((a, b) => b.events - a.events),
    groups: GROUP_ORDER.map((g) => {
      const n = lines.filter((l) => l.group === g).length;
      const accounts = SAMPLE_WATCHLIST.find((w) => w.group === g)?.count ?? 0;
      return { group: g, events: n, lines: n, avg7: 0, accounts, read: SAMPLE_WATCHLIST.find((w) => w.group === g)?.members.length ?? 0 };
    }),
    hours,
    fresh: [],
    active: handles.length,
    sample: true,
  };
}

/** The days with activity, newest first. null when the engine is set but silent. */
export async function getDays(): Promise<{ days: DaySummary[]; sample: boolean } | null> {
  await connection();
  if (!engineUrl()) {
    const d = sampleDay();
    return { days: [{ day: d.day, events: d.totalEvents, lines: d.lines.length, catches: d.catches }], sample: true };
  }
  const r = await engine<{ days: DaySummary[] }>("/v1/days");
  return r ? { days: r.days, sample: false } : null;
}

/** One day. null when the engine is silent, or (with no engine) for any day but the sample day. */
export async function getDay(day: string): Promise<DayDetail | null> {
  await connection();
  if (!DAY_RE.test(day)) return null;
  if (!engineUrl()) return day === SAMPLE_DAY ? sampleDay() : null;
  const d = await engine<DayDetail>(`/v1/day/${day}`);
  return d ? { ...d, lines: d.lines.map((l) => ({ ...l, mediaUrl: siteMediaUrl(l.mediaUrl) })) } : null;
}

/** The day before and after this one among the days with activity (older, newer). */
export function neighbours(days: DaySummary[], day: string): { older: string | null; newer: string | null } {
  const sorted = days.map((d) => d.day).sort();
  const older = sorted.filter((d) => d < day).pop() ?? null;
  const newer = sorted.find((d) => d > day) ?? null;
  return { older, newer };
}
