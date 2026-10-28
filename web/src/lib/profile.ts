import { agoWords, bare, hourLabel, weekday } from "./format";
import { HEAT_LABEL, KIND_VERB } from "./groups";
import { SITE } from "./site";
import type { BuilderStats, DayCount, FeedItem } from "./types";

// Plain numbers and plain sentences for a builder's page, an item's page and their "copy as post" text. Pure, so the
// tests can hold them to the site's rules (no long dashes, no price talk, sample marked).

/** Days in a row with activity, counting back from the last day (or the day before, if the last is still empty). */
export function currentStreak(days: DayCount[]): number {
  let i = days.length - 1;
  if (i >= 0 && days[i].events === 0) i--;
  let n = 0;
  for (; i >= 0 && days[i].events > 0; i--) n++;
  return n;
}

/** The longest run of days in a row with activity. */
export function longestStreak(days: DayCount[]): number {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.events > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** The hour of the day (UTC) with the most activity; null when there is none. */
export function peakHour(hours: number[]): number | null {
  const max = Math.max(0, ...hours);
  return max > 0 ? hours.indexOf(max) : null;
}

/** The weekday with the most activity over the days; null when there is none. */
export function busiestWeekday(days: DayCount[]): string | null {
  const by = new Map<string, number>();
  for (const d of days) if (d.events) by.set(weekday(d.day), (by.get(weekday(d.day)) ?? 0) + d.events);
  const best = [...by].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** "usually ships around 17:00 UTC" */
export const shipsAt = (h: number | null) => (h == null ? "no pattern yet" : `${hourLabel(h)} to ${hourLabel((h + 1) % 24)} UTC`);

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 3).replace(/\s+\S*$/, "") + "...");
const noDash = (s: string) => s.replace(/[–—]/g, "-");

/** A short post for X about one line: who, what, the plain line, the heat, the link. Text only. */
export function itemPost(it: FeedItem): string {
  const what = `${it.handle} ${KIND_VERB[it.kind]} ${it.repo}${it.version ? ` ${it.version}` : ""}`;
  const url = `${SITE.url}/feed/${it.id}`;
  const head = `${what} on GitHub.`;
  const heat = `Heat: ${HEAT_LABEL[it.heat]}.`;
  const tail = `${heat}${it.sample ? " (sample)" : ""}\n\n${url}`;
  const room = 280 - head.length - tail.length - 4;
  return noDash(`${head}\n\n${clip(it.summary, Math.max(20, room))}\n${tail}`);
}

/** A short post for X about a builder's week. Text only. */
export function builderPost(b: BuilderStats, asOf: string): string {
  const url = `${SITE.url}/builders/${bare(b.handle)}`;
  const who = b.name && b.name !== b.handle ? `${b.handle} (${b.name})` : b.handle;
  const last = b.lastActiveAt ? ` Last seen: ${b.lastWhat ?? "active in"} ${b.lastRepo ?? ""}, ${agoWords(b.lastActiveAt, asOf)}.`.replace(" ,", ",") : "";
  const lines = b.items ? ` ${b.items} line${b.items === 1 ? "" : "s"} on PUSHD so far.` : "";
  return noDash(`${who} on GitHub this week: ${b.events7d} public event${b.events7d === 1 ? "" : "s"}.${last}${lines}${b.sample ? " (sample)" : ""}\n\n${url}`);
}
