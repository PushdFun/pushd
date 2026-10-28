import { describe, expect, it } from "vitest";
import { buildBrief, campOf, dayWords, hottest } from "./brief";
import type { DayDetail } from "./day-types";
import { SAMPLE_ITEMS } from "./sample";
import type { FeedItem } from "./types";

// The daily brief's words: only what the counts say, no long dashes, no forbidden words, sample marked, short posts.

const DASH = /[–—]/;
const FORBIDDEN = [/\binstant/i, /\bfirst\b/i, /guarantee/i, /\bprofit/i, /telegram/i, /memecoin/i, /\btax\b/i, /robinhood/i, /\bbuy\b/i, /price/i];
const line = (p: Partial<FeedItem> & { id: string }): FeedItem => ({ handle: "toly", group: "chain", kind: "repo", repo: p.id, summary: "x", heat: "low", score: 2, githubAt: "2026-10-27T03:14:27Z", shownAt: null, url: null, mediaUrl: null, sample: false, ...p });

function day(p: Partial<DayDetail> = {}): DayDetail {
  return {
    day: "2026-10-27",
    asOf: "2026-10-28T12:00:00Z",
    events: [],
    truncated: false,
    totalEvents: 226,
    lines: [line({ id: "a", heat: "high", score: 7 }), line({ id: "b", heat: "low", score: 1, handle: "simonw" }), line({ id: "c", heat: "veryHigh", score: 9, kind: "release", version: "v2.0", githubAt: "2026-10-27T09:00:00Z" })],
    catches: 2,
    top: [
      { handle: "jstarry", group: "chain", events: 63, lines: 0 },
      { handle: "ggerganov", group: "ai", events: 57, lines: 0 },
    ],
    groups: [
      { group: "chain", events: 144, lines: 3, avg7: 18, accounts: 27, read: 6 },
      { group: "wallets", events: 0, lines: 0, avg7: 0, accounts: 27, read: 0 },
      { group: "launchpads", events: 0, lines: 0, avg7: 0, accounts: 15, read: 2 },
      { group: "ai", events: 68, lines: 0, avg7: 60, accounts: 23, read: 5 },
      { group: "oss", events: 14, lines: 0, avg7: 26.9, accounts: 16, read: 4 },
    ],
    hours: Array.from({ length: 24 }, (_, h) => (h === 17 ? 31 : h === 11 ? 32 : 1)),
    fresh: [],
    active: 9,
    sample: false,
    ...p,
  };
}

const clean = (s: string) => {
  expect(s).not.toMatch(DASH);
  for (const re of FORBIDDEN) expect(s).not.toMatch(re);
};
// a camp's own row on the page is data: it may name its camp (Robinhood Chain projects); the lede and the post never do
const cleanData = (s: string) => {
  expect(s).not.toMatch(DASH);
  for (const re of FORBIDDEN.filter((r) => r.source !== "robinhood")) expect(s).not.toMatch(re);
};

describe("the daily brief", () => {
  it("leads with the catches and the lines, and says the counts as they are", () => {
    const b = buildBrief(day(), { url: "https://pushd.fun/brief/2026-10-27" });
    expect(b.headline).toBe("27 Oct: 2 hot catches, 3 feed lines.");
    expect(b.lede).toContain("9 watched projects were active, with 226 public events.");
    expect(b.lede).toContain("jstarry was the busiest, with 63 events.");
    expect(b.lede).toContain("The hottest line: toly released c v2.0, heat 9/10.");
    // the busiest camp here is the Robinhood Chain camp: the lede and the post leave a chain's name out
    expect(b.lede).not.toContain("The busiest camp");
    expect(b.busiestHour).toEqual({ hour: 11, events: 32 });
    for (const s of [b.headline, b.lede, b.post]) clean(s);
    for (const c of b.camps) cleanData(c.line);
  });

  it("puts the top lines hottest first, at most five", () => {
    const many = Array.from({ length: 8 }, (_, i) => line({ id: `l${i}`, score: i, heat: i > 5 ? "high" : "low" }));
    expect(hottest(many).map((l) => l.id)).toEqual(["l7", "l6", "l5", "l4", "l3"]);
    expect(buildBrief(day(), { url: "u" }).top.map((l) => l.id)).toEqual(["c", "a", "b"]);
    // two pushes to the same repo take one place, the hotter one
    const twice = [line({ id: "p1", kind: "push", repo: "arena", score: 2 }), line({ id: "p2", kind: "push", repo: "arena", score: 3 }), line({ id: "q", repo: "other", score: 1 })];
    expect(hottest(twice).map((l) => l.id)).toEqual(["p2", "q"]);
  });

  it("weighs each camp against its own week, and says when a camp is not read yet", () => {
    const camps = buildBrief(day(), { url: "u" }).camps;
    expect(camps.map((c) => c.verdict)).toEqual(["busy", "unread", "quiet", "usual", "quiet"]);
    expect(camps[0].line).toBe("Robinhood Chain projects: 144 events, 8.0x its usual day of 18.");
    expect(camps[1].line).toContain("not read yet");
    expect(campOf({ group: "ai", events: 5, lines: 0, avg7: 0, accounts: 3, read: 3 }).verdict).toBe("busy");
  });

  it("holds a day in progress against the usual pace by this hour", () => {
    // 06:00, a quarter of the day: chain's usual 18 a day is 4.5 by now
    const b = buildBrief(day({ day: "2026-10-28", asOf: "2026-10-28T06:00:00Z" }), { url: "u", today: true });
    expect(b.camps[0].line).toBe("Robinhood Chain projects: 144 events, 32.0x its usual pace of 4.5 by this hour.");
    expect(b.headline).toBe("28 Oct: 2 hot catches, 3 feed lines so far.");
    const quiet = buildBrief(day({ day: "2026-10-28", asOf: "2026-10-28T06:00:00Z", lines: [], catches: 0 }), { url: "u", today: true });
    expect(quiet.lede).toContain("No line has made the feed yet today.");
    for (const c of b.camps) cleanData(c.line);
  });

  it("falls back to plain words on quieter days, and says so far for today", () => {
    expect(buildBrief(day({ catches: 0 }), { url: "u" }).headline).toBe("27 Oct: 3 feed lines from 9 builders.");
    expect(buildBrief(day({ catches: 0, lines: [] }), { url: "u" }).headline).toBe("27 Oct: 226 public events, no new lines.");
    expect(buildBrief(day({ catches: 0, lines: [], totalEvents: 0, active: 0, top: [] }), { url: "u", today: true }).headline).toBe("27 Oct: a quiet day so far.");
    expect(buildBrief(day({ catches: 0, lines: [] }), { url: "u" }).lede).toContain("No line made the feed that day.");
  });

  it("writes a short post with the page link, under 280 characters, marked when sample", () => {
    const url = "https://pushd.fun/brief/2026-10-27";
    const b = buildBrief(day(), { url });
    expect(b.post.length).toBeLessThanOrEqual(280);
    expect(b.post.split("\n")[0]).toBe("PUSHD brief, 27 Oct 2026");
    expect(b.post.endsWith(url)).toBe(true);
    const long = buildBrief(day({ lines: [line({ id: "x".repeat(200), heat: "veryHigh", score: 9 })] }), { url });
    expect(long.post.length).toBeLessThanOrEqual(280);
    expect(long.post.endsWith(url)).toBe(true);
    const sample = buildBrief(day({ sample: true, lines: SAMPLE_ITEMS }), { url });
    expect(sample.post).toContain("(sample)");
    expect(sample.lede.startsWith("Sample brief")).toBe(true);
    clean(sample.lede);
    clean(sample.post);
  });

  it("names the day plainly", () => {
    expect(dayWords("2026-10-27")).toBe("27 Oct");
    expect(dayWords("2026-01-05", true)).toBe("5 Jan 2026");
  });
});
