import { describe, expect, it } from "vitest";
import { toJsonFeed, toRss, titleOf } from "./feeds";
import { builderPost, busiestWeekday, currentStreak, itemPost, longestStreak, peakHour, shipsAt } from "./profile";
import { SAMPLE_ITEMS } from "./sample";
import { dayKeysTo, sampleBuilders, samplePulse, sampleProfile, searchSample } from "./sample-insights";
import type { DayCount, Feed } from "./types";

const DASH = /[–—]/;
const days = (events: number[]): DayCount[] => dayKeysTo("2026-10-28T12:00:00Z", events.length).map((day, i) => ({ day, events: events[i], items: 0 }));

describe("streaks and habits", () => {
  it("counts the run up to today, or up to yesterday when today is still empty", () => {
    expect(currentStreak(days([1, 0, 2, 3, 1]))).toBe(3);
    expect(currentStreak(days([1, 2, 3, 0]))).toBe(3);
    expect(currentStreak(days([1, 0, 0]))).toBe(0);
    expect(longestStreak(days([1, 1, 1, 0, 1, 1]))).toBe(3);
    expect(longestStreak(days([0, 0]))).toBe(0);
  });
  it("finds the busiest hour and weekday, or none", () => {
    const h = Array.from({ length: 24 }, () => 0);
    expect(peakHour(h)).toBeNull();
    h[17] = 9;
    h[3] = 2;
    expect(peakHour(h)).toBe(17);
    expect(shipsAt(17)).toBe("17:00 to 18:00 UTC");
    expect(shipsAt(23)).toBe("23:00 to 00:00 UTC");
    expect(busiestWeekday(days([0, 0, 5]))).toBe("Wed");
    expect(busiestWeekday(days([0, 0]))).toBeNull();
  });
});

describe("copy as post", () => {
  it("an item post: who, what, the line, the heat, the link; under 280; sample marked; no dashes or price talk", () => {
    for (const it of SAMPLE_ITEMS) {
      const t = itemPost(it);
      expect(t.length).toBeLessThanOrEqual(280);
      expect(t).toContain(`/feed/${it.id}`);
      expect(t).toContain("(sample)");
      expect(t).not.toMatch(DASH);
      expect(t).not.toMatch(/\bbuy\b|\$PUSHD|pump\.fun|profit|guarantee|instant/i);
    }
    const long = { ...SAMPLE_ITEMS[0], sample: false, summary: "x — ".repeat(200) };
    expect(itemPost(long).length).toBeLessThanOrEqual(280);
    expect(itemPost(long)).not.toMatch(DASH);
    expect(itemPost(long)).not.toContain("(sample)");
  });
  it("a builder post names the week and the link", () => {
    const b = sampleBuilders().find((x) => x.handle === "toly")!;
    const t = builderPost(b, "2026-10-27T14:23:00Z");
    expect(t).toMatch(/^toly \(Anatoly Yakovenko\) on GitHub this week: 1 public event\./);
    expect(t).toContain("/builders/toly");
    expect(t).toContain("(sample)");
    expect(t).not.toMatch(DASH);
  });
});

describe("the public feeds", () => {
  const feed: Feed = { items: SAMPLE_ITEMS, asOf: "2026-10-27T14:23:00Z", source: "sample" };
  it("RSS: one item per line, escaped, sample marked", () => {
    const x = toRss(feed);
    expect(x.startsWith('<?xml version="1.0"')).toBe(true);
    expect((x.match(/<item>/g) ?? []).length).toBe(SAMPLE_ITEMS.length);
    expect(x).toContain("&quot;gm&quot;");
    expect(x).toContain("(sample)");
    expect(x).not.toMatch(DASH);
  });
  it("JSON Feed 1.1 with PUSHD's own fields", () => {
    const j = toJsonFeed(feed, 3);
    expect(j.version).toBe("https://jsonfeed.org/version/1.1");
    expect(j.items).toHaveLength(3);
    expect(j.items[0]._pushd.sample).toBe(true);
    expect(titleOf({ ...SAMPLE_ITEMS[5], sample: false })).toBe("@nullbyte released tiny-wallet v2.0");
  });
});

describe("sample insights", () => {
  it("are built from the sample lines only and marked sample", () => {
    const p = samplePulse();
    expect(p.sample).toBe(true);
    expect(p.totals.lines).toBe(SAMPLE_ITEMS.length);
    expect(p.hours).toHaveLength(24);
    expect(p.hours.reduce((n, h) => n + h.total, 0)).toBeLessThanOrEqual(SAMPLE_ITEMS.length);
    expect(p.days).toHaveLength(84);
    expect(sampleBuilders().every((b) => b.sample)).toBe(true);
    // bunker_coin is never in the sample
    expect(JSON.stringify(p)).not.toContain("bunker");
  });
  it("a sample builder's page, with or without the @; none for strangers", () => {
    expect(sampleProfile("kaiwren")?.handle).toBe("@kaiwren");
    expect(sampleProfile("@kaiwren")?.lines.map((l) => l.id)).toEqual(["frog-oracle"]);
    expect(sampleProfile("nobody")).toBeNull();
  });
  it("search: every word must match", () => {
    expect(searchSample("frog").items.map((i) => i.id)).toEqual(["frog-oracle"]);
    expect(searchSample("tiny v2.0").items.map((i) => i.id)).toEqual(["tiny-wallet"]);
    expect(searchSample("toly").builders.map((b) => b.handle)).toEqual(["toly"]);
    expect(searchSample("   ")).toEqual({ items: [], builders: [] });
  });
});
