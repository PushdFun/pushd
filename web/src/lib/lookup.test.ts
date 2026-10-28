import { describe, expect, it } from "vitest";
import { everyText, itemHref, movementText, movementWords, parseQuery, partsByPoints, rawText, repoFromUrl, validLogin, validRepo } from "./lookup";
import { sampleTop } from "./sample-top";
import type { ScorePart } from "./types";

describe("parseQuery", () => {
  it("reads a username, with or without @", () => {
    expect(parseQuery("toly")).toEqual({ kind: "user", login: "toly", href: "/gh/toly" });
    expect(parseQuery("  @aeyakovenko ")).toMatchObject({ kind: "user", login: "aeyakovenko" });
  });
  it("reads owner/name and GitHub links", () => {
    expect(parseQuery("paradigmxyz/reth")).toEqual({ kind: "repo", owner: "paradigmxyz", repo: "reth", href: "/gh/paradigmxyz/reth" });
    expect(parseQuery("https://github.com/foundry-rs/foundry")).toMatchObject({ kind: "repo", owner: "foundry-rs", repo: "foundry" });
    expect(parseQuery("github.com/vbuterin")).toMatchObject({ kind: "user", login: "vbuterin" });
    expect(parseQuery("https://github.com/ggml-org/llama.cpp.git")).toMatchObject({ kind: "repo", repo: "llama.cpp" });
  });
  it("leaves free words as words", () => {
    expect(parseQuery("zk rollup prover")).toEqual({ kind: "words", words: "zk rollup prover" });
    expect(parseQuery("-bad-")).toMatchObject({ kind: "words" });
    expect(parseQuery("   ")).toEqual({ kind: "empty" });
  });
  it("checks GitHub's naming rules", () => {
    expect(validLogin("a")).toBe(true);
    expect(validLogin("a-b")).toBe(true);
    expect(validLogin("a--b")).toBe(false);
    expect(validLogin("-ab")).toBe(false);
    expect(validLogin("x".repeat(40))).toBe(false);
    expect(validRepo("llama.cpp")).toBe(true);
    expect(validRepo("..")).toBe(false);
    expect(validRepo("a/b")).toBe(false);
  });
});

describe("links for lines", () => {
  it("sends a holder's added account to its repo page, everything else to its own page", () => {
    expect(itemHref({ id: "x", url: "https://github.com/a/b/commit/123" })).toBe("/feed/x");
    expect(itemHref({ id: "x", extra: true, url: "https://github.com/a/b/commit/123" })).toBe("/gh/a/b");
    expect(itemHref({ id: "x", extra: true, url: "https://gist.github.com/a/123" })).toBe("https://gist.github.com/a/123");
    expect(repoFromUrl("https://github.com/a/b")).toEqual({ owner: "a", repo: "b" });
    expect(repoFromUrl(null)).toBeNull();
  });
});

describe("the Top 100's labels", () => {
  it("says how a row moved", () => {
    expect(movementText("up", 3)).toBe("+3");
    expect(movementText("down", -2)).toBe("-2");
    expect(movementText("new", 0)).toBe("new");
    expect(movementText("same", 0)).toBe("=");
    expect(movementWords("up", 1)).toBe("up 1 place");
    expect(movementWords("down", 4)).toBe("down 4 places");
  });
  it("says how often, in plain words", () => {
    expect(everyText(2)).toBe("every 2 min");
    expect(everyText(90)).toBe("every 1.5 h");
    expect(everyText(60 * 72)).toBe("every 3 days");
    expect(everyText(null)).toBe("not read");
  });
  it("orders a score's parts by points and prints the raw windows in order", () => {
    const parts: ScorePart[] = [
      { key: "a", label: "a", raw: { "30d": 9, "24h": 1, "7d": 4 }, norm: 0.2, weight: 1, points: 2 },
      { key: "b", label: "b", raw: {}, norm: 0.9, weight: 3, points: 20 },
    ];
    expect(partsByPoints(parts).map((p) => p.key)).toEqual(["b", "a"]);
    expect(rawText(parts[0].raw)).toBe("24h 1 . 7d 4 . 30d 9");
  });
  it("keeps the sample marked and free of real people", () => {
    const t = sampleTop();
    expect(t.sample).toBe(true);
    expect(t.rows.every((r) => r.sample && r.handle.startsWith("@"))).toBe(true);
    expect(t.rows.map((r) => r.rank)).toEqual(t.rows.map((_, i) => i + 1));
  });
});
