import { test } from "node:test";
import assert from "node:assert/strict";
import { heatOf, score, sizePoints } from "../src/heat.ts";
import { cand, ctx, repo, toly } from "./helpers.ts";

const labels = (s: { signals: { label: string }[] }) => s.signals.map((x) => x.label);

test("the bands match the site's legend", () => {
  assert.deepEqual([0, 3, 4, 5, 6, 7, 8, 10].map(heatOf), ["low", "low", "medium", "medium", "high", "high", "veryHigh", "veryHigh"]);
});

test("toly's dts02-6502-signer lands high or very high", () => {
  const r = repo({
    name: "dts02-6502-signer",
    fullName: "aeyakovenko/dts02-6502-signer",
    description: "DTS-02: 65C02 Ed25519 breadboard signer spec with pin-level simulation",
    createdAt: "2026-10-27T03:14:27Z",
  });
  const s = score(cand({ repo: "dts02-6502-signer", fullName: r.fullName }), ctx({ repo: r, prevRepoCreatedAt: "2026-03-05T13:43:40Z" }));
  assert.ok(s.heat === "high" || s.heat === "veryHigh", `${s.heat} ${s.score}`);
  assert.ok(labels(s).includes("new repo"));
  assert.ok(labels(s).some((l) => l.startsWith("first new repo in")));
  // every signal is {label, points}, as the site shows it, and the points add up to the score
  for (const x of s.signals) assert.deepEqual(Object.keys(x).sort(), ["label", "points"]);
  assert.equal(s.score, Math.min(10, s.signals.reduce((n, x) => n + x.points, 0)));
});

test("routine work stays low", () => {
  const s = score(cand({ sub: "push", repo: "percolator", ref: "refs/heads/master", defaultBranch: true }), ctx({ repo: repo({ name: "percolator", createdAt: "2025-10-19T18:16:33Z" }), prevActivityAt: "2026-10-27T03:00:00Z" }));
  assert.equal(s.heat, "low", JSON.stringify(s));
  // a big account does not lift routine pushes
  assert.ok(!labels(s).some((l) => /following/.test(l)));
  const minor = score(cand({ sub: "release", repo: "agave", tag: "v3.1.0" }), ctx({ entry: { ...toly, followers: 50_000 }, repo: repo({ name: "agave", createdAt: "2024-01-01T00:00:00Z" }), prevActivityAt: "2026-10-26T00:00:00Z" }));
  assert.equal(minor.heat, "low", JSON.stringify(minor));
});

test("a joke repo with a fun name and a hot word runs very hot", () => {
  const r = repo({ name: "frog-coin", description: "A coin that only frogs can hold, as a joke 🐸", readme: "# frog-coin\n\nJust for fun. ![frog](frog.png)", files: ["README.md", "frog.png"] });
  const s = score(cand({ repo: "frog-coin" }), ctx({ repo: r }));
  assert.equal(s.heat, "veryHigh");
  for (const l of ['word "coin" in the name', "fun name", "joke README", "images in the repo", "emoji in the description"]) assert.ok(labels(s).includes(l), l);
  assert.ok(s.score <= 10);
});

test("words in the text count, but everyday tech words do not", () => {
  const meme = score(cand({ repo: "lab" }), ctx({ repo: repo({ description: "a meme generator" }) }));
  assert.ok(labels(meme).includes('word "meme" in the text'));
  const api = score(cand({ repo: "auth-service" }), ctx({ repo: repo({ description: "Rotates an API token every hour" }) }));
  assert.ok(!labels(api).some((l) => l.includes("token")));
});

test("gm, gists, major releases, repos made public and silences have their signals", () => {
  assert.ok(labels(score(cand({ repo: "gm-cli" }), ctx())).includes('word "gm" in the name'));
  const gist = score(cand({ sub: "gist", repo: "launch.txt", gistFiles: ["launch.txt"], gistFirstLine: "soon" }), ctx());
  assert.ok(labels(gist).includes("public gist"));
  assert.ok(labels(gist).includes('word "launch" in the name'));
  assert.ok(["high", "veryHigh"].includes(gist.heat));
  assert.ok(labels(score(cand({ sub: "release", tag: "v2.0.0" }), ctx())).includes("major release v2.0.0"));
  assert.ok(labels(score(cand({ sub: "made-public" }), ctx())).includes("repo made public"));
  const quiet = score(cand({ sub: "push", githubAt: "2026-10-27T00:00:00Z" }), ctx({ prevActivityAt: "2026-06-01T00:00:00Z", repo: repo({ createdAt: "2024-01-01T00:00:00Z", pushedAt: "2026-05-01T00:00:00Z" }) }));
  assert.ok(labels(quiet).some((l) => l.startsWith("first push in")), JSON.stringify(quiet));
});

test("account size: by followers, only on something new", () => {
  assert.equal(sizePoints(50_000)?.points, 3);
  assert.equal(sizePoints(4_000)?.points, 2);
  assert.equal(sizePoints(1_800)?.points, 1);
  assert.equal(sizePoints(200), null);
  assert.equal(sizePoints(undefined), null);
  const big = score(cand(), ctx({ entry: { ...toly, followers: 228_000 } }));
  assert.ok(labels(big).includes("account with a big following"));
});
