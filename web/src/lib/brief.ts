import type { DayDetail } from "./day-types";
import { GROUPS, HEAT_RANK, KIND_VERB } from "./groups";
import type { FeedItem, GroupKey } from "./types";

// The daily brief's words, built from the day's stored numbers with fixed sentences. No model writes any of it, and it
// only says what the counts say. Pure and client-safe, so the page and its tests share it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "27 Oct" or "27 Oct 2026" */
export function dayWords(day: string, year = false): string {
  const d = new Date(day + "T00:00:00Z");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
}

export type CampVerdict = "busy" | "quiet" | "usual" | "unread";

export type Camp = {
  group: GroupKey;
  events: number;
  lines: number;
  avg7: number;
  /** what a usual day has by now: avg7, or its share of it on a day in progress */
  expected: number;
  verdict: CampVerdict;
  ratio: number | null;
  line: string;
};

/**
 * A group's day against its own average over the 7 days before. `frac`: how much of the day has passed (1 for a day that
 * is over); a day in progress is held against the same share of the usual day, its usual pace by this hour.
 */
export function campOf(g: DayDetail["groups"][number], frac = 1): Camp {
  const name = GROUPS[g.group].title;
  const expected = g.avg7 * Math.max(0.05, Math.min(1, frac));
  if (g.read === 0) return { ...g, expected, verdict: "unread", ratio: null, line: `${name}: not read yet. The watcher reaches every account in turn.` };
  const usual = frac < 1 ? "usual pace" : "usual day";
  if (g.avg7 === 0) {
    if (g.events === 0) return { ...g, expected, verdict: "quiet", ratio: null, line: `${name}: quiet, as in the week before.` };
    return { ...g, expected, verdict: "busy", ratio: null, line: `${name}: ${plural(g.events, "event")}, with none stored for the week before.` };
  }
  const ratio = g.events / expected;
  const avg = expected.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const by = frac < 1 ? " by this hour" : "";
  if (ratio >= 1.5) return { ...g, expected, verdict: "busy", ratio, line: `${name}: ${plural(g.events, "event")}, ${ratio.toFixed(1)}x its ${usual} of ${avg}${by}.` };
  if (ratio <= 0.6) return { ...g, expected, verdict: "quiet", ratio, line: `${name}: ${plural(g.events, "event")}, under its ${usual} of ${avg}${by}.` };
  return { ...g, expected, verdict: "usual", ratio, line: `${name}: ${plural(g.events, "event")}, about its ${usual} of ${avg}${by}.` };
}

/** The day's lines, hottest first (heat, then score, then the earlier one), one per repo. */
export function hottest(lines: FeedItem[], n = 5): FeedItem[] {
  const sorted = [...lines].sort((a, b) => HEAT_RANK[b.heat] - HEAT_RANK[a.heat] || (b.score ?? 0) - (a.score ?? 0) || a.githubAt.localeCompare(b.githubAt));
  // one place per repo: two pushes to the same repo are one story
  const seen = new Set<string>();
  return sorted.filter((it) => {
    const k = `${it.handle.toLowerCase()}/${it.repo.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, n);
}

export const lineWords = (it: FeedItem) => `${it.handle} ${KIND_VERB[it.kind]} ${it.repo}${it.version ? ` ${it.version}` : ""}`;

export type Brief = {
  headline: string;
  lede: string;
  top: FeedItem[];
  camps: Camp[];
  busiestHour: { hour: number; events: number } | null;
  post: string;
};

/**
 * The brief for one day. `url` is the page's own address, for the post. `today`: the day is not over yet, so the words
 * say "so far" and each camp is held against its usual pace by this hour.
 */
export function buildBrief(d: DayDetail, o: { url: string; today?: boolean }): Brief {
  // a day in progress: how much of it has passed, by the public view's moment
  const frac = o.today ? Math.max(0.05, (Date.parse(d.asOf) - Date.parse(d.day + "T00:00:00Z")) / 86_400_000) : 1;
  const date = dayWords(d.day);
  const lines = d.lines.length;
  const top = hottest(d.lines);
  const hot = top[0] ?? null;
  const camps = d.groups.map((g) => campOf(g, frac));
  const peak = d.hours.reduce((best, v, h) => (v > best.events ? { hour: h, events: v } : best), { hour: -1, events: 0 });
  const busiestHour = peak.events > 0 ? peak : null;
  const soFar = o.today ? " so far" : "";

  let headline: string;
  if (d.catches > 0) headline = `${date}: ${plural(d.catches, "hot catch", "hot catches")}, ${plural(lines, "feed line")}${soFar}.`;
  else if (lines > 0) headline = `${date}: ${plural(lines, "feed line")} from ${plural(d.active, "builder")}${soFar}.`;
  else if (d.totalEvents > 0) headline = `${date}: ${plural(d.totalEvents, "public event")}, no new lines${soFar}.`;
  else headline = `${date}: a quiet day${soFar}.`;

  const parts: string[] = [];
  if (d.sample) parts.push("Sample brief, from the sample lines.");
  if (d.totalEvents > 0) parts.push(`${plural(d.active, "watched project was", "watched projects were")} active, with ${plural(d.totalEvents, "public event")}${soFar}.`);
  const busiest = d.top[0];
  if (busiest && busiest.events > 0 && d.top.length > 1) parts.push(`${busiest.handle} was the busiest, with ${plural(busiest.events, "event")}.`);
  if (hot) parts.push(`The hottest line: ${lineWords(hot)}${hot.score != null ? `, heat ${hot.score}/10` : ""}.`);
  else parts.push(o.today ? "No line has made the feed yet today." : "No line made the feed that day.");
  if (d.fresh.length) parts.push(`${plural(d.fresh.length, "new repo")} appeared.`);
  const busyCamp = camps.filter((c) => c.verdict === "busy").sort((a, b) => b.events - a.events)[0];
  if (busyCamp && busyCamp.group !== "chain") parts.push(`The busiest camp: ${GROUPS[busyCamp.group].label}.`);

  const postLines = [
    `PUSHD brief, ${dayWords(d.day, true)}${d.sample ? " (sample)" : ""}`,
    d.totalEvents > 0 ? `${plural(d.totalEvents, "public event")} from ${plural(d.active, "watched project")}. ${plural(lines, "feed line")}, ${plural(d.catches, "hot catch", "hot catches")}.` : "A quiet day on the watchlist.",
    hot ? `Hottest: ${lineWords(hot)}${hot.score != null ? ` (heat ${hot.score}/10)` : ""}` : null,
    // a post others copy never names a chain: the Robinhood Chain camp is left out of it
    busyCamp && busyCamp.group !== "chain" ? `Busiest camp: ${GROUPS[busyCamp.group].label}` : null,
  ].filter((x): x is string => !!x);
  // a post stays under 280 characters with the link: the lines drop from the end until it fits
  let post = [...postLines, o.url].join("\n");
  while (post.length > 280 && postLines.length > 1) {
    postLines.pop();
    post = [...postLines, o.url].join("\n");
  }
  return { headline, lede: parts.join(" "), top, camps, busiestHour, post };
}
