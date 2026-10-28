import { describe, expect, test } from "vitest";
import { cleanKeyword, matchesAll, readable } from "./rules";
import { callHeat, fmtSecs, isScoutId, NOT_ADVICE, sampleScouts, SCOUT_BY_CAMP, SCOUTS, VERDICT_LABEL } from "./scouts";

describe("the scouts on the site", () => {
  test("five, one per camp, no long dashes in anything they say", () => {
    expect(SCOUTS.map((s) => s.id)).toEqual(["claude", "gpt", "grok", "gemini", "deepseek"]);
    expect(Object.keys(SCOUT_BY_CAMP).sort()).toEqual(["ai", "chain", "launchpads", "oss", "wallets"]);
    expect(JSON.stringify(SCOUTS) + NOT_ADVICE + JSON.stringify(VERDICT_LABEL)).not.toMatch(/[–—]/);
    expect(isScoutId("gemini")).toBe(true);
    expect(isScoutId("toly")).toBe(false);
  });

  test("the line on every call says it is not advice", () => {
    expect(NOT_ADVICE).toMatch(/information, not advice/);
    expect(NOT_ADVICE).toMatch(/never a signal to trade/);
  });

  test("heat calls in the site's words, and times", () => {
    expect([0, 3, 4, 5, 6, 7, 8, 10].map(callHeat)).toEqual(["low", "low", "medium", "medium", "high", "high", "veryHigh", "veryHigh"]);
    expect(fmtSecs(null)).toBe("n/a");
    expect(fmtSecs(42)).toBe("42s");
    expect(fmtSecs(245)).toBe("4m 05s");
    expect(fmtSecs(7800)).toBe("2h 10m");
  });

  test("without an engine: the five with no calls, marked as a sample", () => {
    const v = sampleScouts();
    expect(v.sample).toBe(true);
    expect(v.scouts).toHaveLength(5);
    expect(v.scouts.every((r) => r.calls === 0 && r.hitRate === null && r.best === null && r.sample)).toBe(true);
  });
});

describe("a holder's rule in plain words", () => {
  test("the sentence the editor shows", () => {
    expect(readable({ builders: ["aeyakovenko", "garious"], camps: [], kinds: ["repo"], keywords: ["tokens", "payments"], heatFloor: 0 })).toBe(
      'Tell me about new repos from aeyakovenko or garious that mention "tokens" or "payments".',
    );
    expect(readable({ builders: [], camps: ["ai"], kinds: [], keywords: [], heatFloor: 8 })).toBe("Tell me about new lines from anyone in AI agent projects at heat 8 or more.");
  });

  test("keywords the engine can match, and a rule that would match everything", () => {
    expect(cleanKeyword("  Payments ")).toBe("payments");
    expect(cleanKeyword("c++")).toBe("c++");
    expect(cleanKeyword("<b>")).toBeNull();
    expect(cleanKeyword("x")).toBeNull();
    expect(matchesAll({ builders: [], camps: [], kinds: [], keywords: [], heatFloor: 0 })).toBe(true);
    expect(matchesAll({ builders: [], camps: [], kinds: [], keywords: [], heatFloor: 1 })).toBe(false);
  });
});
