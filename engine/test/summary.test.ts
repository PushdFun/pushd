import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptModelLine, cleanLine, fallbackSummary, MAX_LEN, openRouterLine, readmeFirstSentence, summarize } from "../src/summary.ts";
import { cand, repo } from "./helpers.ts";

const DASH = /[‒-―−]/;
const plain = (s: string) => {
  assert.ok(s.length <= MAX_LEN && s.length < 120, `too long: ${s}`);
  assert.doesNotMatch(s, DASH, `dash in: ${s}`);
  assert.doesNotMatch(s, /\n/);
};

test("the description, cleaned: no markdown, no dashes, a capital and a full stop", () => {
  const s = fallbackSummary({ candidate: cand(), repo: repo({ description: "DTS-02: 65C02 Ed25519 breadboard signer spec with pin-level simulation" }) });
  assert.equal(s, "DTS-02: 65C02 Ed25519 breadboard signer spec with pin-level simulation.");
  assert.equal(cleanLine("a **tiny** wallet — fits in `one` file"), "A tiny wallet, fits in one file.");
  assert.equal(cleanLine("bunker coin"), "Bunker coin.");
  assert.equal(cleanLine("Fast – and small 🚀"), "Fast, and small.");
  plain(cleanLine("word ".repeat(60)));
  assert.match(cleanLine("word ".repeat(60)), /\.\.\.$/);
});

test("no description: the README's first real sentence, past titles, badges and pictures", () => {
  const readme = "# thing\n\n[![ci](https://x/badge.svg)](https://x)\n<p align=\"center\"><img src=\"logo.png\"></p>\n\nA command line tool that prints gm. It also prints gn.\n\n## Install";
  assert.equal(readmeFirstSentence(readme, "thing"), "A command line tool that prints gm.");
  assert.equal(fallbackSummary({ candidate: cand(), repo: repo({ readme }) }), "A command line tool that prints gm.");
  assert.equal(readmeFirstSentence("# thing\n\n```sh\nnpm i\n```\n", "thing"), null);
});

test("nothing to go on: it says plainly what kind of thing it is, and invents nothing", () => {
  assert.equal(fallbackSummary({ candidate: cand(), repo: repo({ language: "Rust", readme: "", files: [] }) }), "A new Rust repo with no description or README yet.");
  assert.equal(fallbackSummary({ candidate: cand(), repo: repo({ readme: "", files: ["src", "Cargo.toml"] }) }), "A new repo with no description yet, 2 files and folders at the top.");
  assert.equal(fallbackSummary({ candidate: cand({ sub: "made-public" }), repo: repo({ readme: "" }) }), "A repo just made public with no description or README yet.");
  assert.equal(fallbackSummary({ candidate: cand({ sub: "gist", repo: "launch.txt", gistFiles: ["launch.txt"], gistFirstLine: "soon" }), repo: null }), 'A public gist with one line: "soon".');
  assert.equal(fallbackSummary({ candidate: cand({ sub: "release", tag: "v2.0", repo: "tiny-wallet" }), repo: repo({ readme: "" }) }), "Release v2.0 of tiny-wallet.");
  assert.equal(fallbackSummary({ candidate: cand({ sub: "push", ref: "refs/heads/main", commits: ["Add the signer"] }), repo: repo({ readme: "" }) }), 'New commits, the latest says: "Add the signer".');
});

test("every fallback line is plain and short", () => {
  const long = "x".repeat(300);
  for (const r of [repo({ description: long }), repo({ readme: `Hello — ${long}` }), repo({ description: "–" })]) plain(fallbackSummary({ candidate: cand(), repo: r }));
});

test("no key, no model call: the fallback writes it and nothing is spent", async () => {
  let called = 0;
  const s = await summarize({ candidate: cand(), repo: repo({ description: "A thing." }) }, { fetchImpl: (async () => (called++, new Response("{}"))) as typeof fetch });
  assert.deepEqual(s, { text: "A thing.", source: "fallback" });
  assert.equal(called, 0);
});

test("with a key: one call, its cost logged, and a line that adds a number is refused", async () => {
  const costs: number[] = [];
  const bodies: unknown[] = [];
  const answer = (content: string) =>
    (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.00004 } }));
    }) as typeof fetch;
  const input = { candidate: cand(), repo: repo({ description: "A hardware signer for the 65C02" }) };
  const ok = await openRouterLine(input, { key: "k", fetchImpl: answer("A hardware signer for the old 65C02 chip"), onCost: (c) => costs.push(c.usd) });
  assert.equal(ok, "A hardware signer for the old 65C02 chip.");
  assert.deepEqual(costs, [0.00004]);
  const body = bodies[0] as { max_tokens: number; model: string };
  assert.ok(body.max_tokens <= 300);
  assert.ok(body.model);
  // the model made up "10x": refused, the fallback takes over
  const s = await summarize(input, { key: "k", fetchImpl: answer("A signer that is 10x faster"), onCost: (c) => costs.push(c.usd) });
  assert.deepEqual(s, { text: "A hardware signer for the 65C02.", source: "fallback" });
  assert.equal(acceptModelLine("Visit https://x.y", "x"), null);
  assert.equal(acceptModelLine("A tool — fast", "x"), "A tool, fast.");
});
