// The insight endpoints and their parts: activity added up (orgs count code only, the public delay holds), a
// builder's page, the pulse, search; the extra facts for an item's page (stored first, fetched in the background under
// a budget, a pause after a 403/429); the builders' pictures (watchlist only, cached, paused after a 429).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApi } from "../src/api.ts";
import { Avatars } from "../src/avatars.ts";
import { getExtra, insertItem, openDb, recordEvent, setMeta, storeCache, toFeedItem, upsertRepo, type DB, type StoredItem } from "../src/db.ts";
import { Enricher, plainText, tidy } from "../src/enrich.ts";
import { category, counts, dayKeys, forgetMemos, Insights } from "../src/insights.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const karpathy: WatchEntry = { handle: "karpathy", name: "Andrej Karpathy", org: "nanoGPT", group: "ai", type: "user", followers: 228000, source: "t" };
const accounts = [toly, someOrg, karpathy];
const cutoff = at(5);

function line(p: Partial<StoredItem> & { id: string }): StoredItem {
  return {
    key: `k:${p.id}`,
    handle: "aeyakovenko",
    group: "chain",
    kind: "repo",
    repo: p.id,
    summary: "A thing.",
    summarySource: "fallback",
    heat: "low",
    score: 2,
    signals: [{ label: "new repo", points: 2 }],
    githubAt: at(60),
    seenAt: at(59),
    shownAt: at(59),
    url: `https://github.com/aeyakovenko/${p.id}`,
    backfill: false,
    ...p,
  };
}

let dir: string, db: DB;
const ev = (key: string, handle: string, type: string, repo: string | null, minAgo: number, seenMinAgo = minAgo) =>
  recordEvent(db, { key, handle, type, repo, githubAt: at(minAgo), seenAt: at(seenMinAgo), verdict: "activity" });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pushd-insights-"));
  db = openDb(join(dir, "t.sqlite"));
  // toly: pushes and a star in the last day, one older push; one event seen only a minute ago (inside the delay)
  ev("e1", "aeyakovenko", "push", "aeyakovenko/percolator", 90);
  ev("e2", "aeyakovenko", "WatchEvent", "someone/cool", 120);
  ev("e3", "aeyakovenko", "IssueCommentEvent", "aeyakovenko/percolator", 60 * 30);
  ev("e4", "aeyakovenko", "push", "aeyakovenko/percolator", 3, 1);
  ev("e5", "aeyakovenko", "RepoList", "aeyakovenko/dts02-6502-signer", 600);
  // an org: a stranger's star and issue do not count, its push does
  ev("o1", "solana-labs", "WatchEvent", "solana-labs/spl", 30);
  ev("o2", "solana-labs", "IssuesEvent", "solana-labs/spl", 40);
  ev("o3", "solana-labs", "push", "solana-labs/spl", 50);
  insertItem(db, line({ id: "dts02-6502-signer", heat: "high", score: 7, githubAt: at(600), seenAt: at(598), shownAt: at(598) }));
  insertItem(db, line({ id: "too-fresh", heat: "veryHigh", score: 9, githubAt: at(2), seenAt: at(1), shownAt: at(1) }));
  insertItem(db, line({ id: "nanochat-v2", handle: "karpathy", group: "ai", kind: "release", repo: "nanochat", version: "v2.0", score: 5, heat: "medium", url: "https://github.com/karpathy/nanochat/releases/tag/v2.0" }));
  // the watcher's stored repo list for toly, and a repo it read on its own
  storeCache(
    db,
    "https://api.github.com/users/aeyakovenko/repos?sort=created&direction=desc&per_page=30&type=owner",
    null,
    JSON.stringify([
      { name: "dts02-6502-signer", full_name: "aeyakovenko/dts02-6502-signer", description: "A signer — for the 6502", language: "Python", stargazers_count: 8, forks_count: 4, topics: ["retro"], created_at: at(600), pushed_at: at(100), html_url: "https://github.com/aeyakovenko/dts02-6502-signer", fork: false },
      { name: "percolator", full_name: "aeyakovenko/percolator", description: "Perps", language: "Rust", stargazers_count: 564, forks_count: 60, topics: [], created_at: "2026-01-01T00:00:00Z", pushed_at: at(90), html_url: "https://github.com/aeyakovenko/percolator", fork: false },
      { name: "a-fork", full_name: "aeyakovenko/a-fork", description: null, language: "C", stargazers_count: 0, created_at: at(700), pushed_at: at(700), html_url: "https://github.com/aeyakovenko/a-fork", fork: true },
    ]),
  );
  // the list was read before the test's clock (storeCache stamps the real time, which passes NOW after noon 28 Oct)
  db.prepare("UPDATE http_cache SET fetched_at = ?").run(at(60));
  upsertRepo(db, { id: 1, handle: "aeyakovenko", name: "dts02-6502-signer", full_name: "aeyakovenko/dts02-6502-signer", created_at: at(600), pushed_at: at(100), default_branch: "main", fork: false }, at(590));
  db.prepare("INSERT INTO accounts (handle, polls, last_poll_at) VALUES ('aeyakovenko', 3, ?)").run(at(30));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => forgetMemos());

const insights = () => new Insights({ db, accounts, toItem: (s) => toFeedItem(s, undefined), now: () => NOW });

test("the rules: categories, what an org's activity is, the day keys", () => {
  assert.equal(category("push"), "code");
  assert.equal(category("PullRequestReviewEvent"), "pull requests");
  assert.equal(category("WatchEvent"), "stars and forks");
  assert.equal(counts({ type: "WatchEvent" }, "user"), true);
  assert.equal(counts({ type: "WatchEvent" }, "org"), false);
  assert.equal(counts({ type: "push" }, "org"), true);
  assert.equal(counts({ type: "RepoList" }, "user"), false);
  const k = dayKeys(NOW, 3);
  assert.deepEqual(k, ["2026-10-26", "2026-10-27", "2026-10-28"]);
});

test("builders: every account, its activity before the cutoff only, an org's code only", () => {
  const b = insights().builders(cutoff);
  assert.deepEqual(b.map((x) => x.handle), ["aeyakovenko", "solana-labs", "karpathy"]);
  const t = b[0];
  // e1, e2, e3 count; e4 was seen inside the delay; e5 is a repo list entry
  assert.equal(t.events30d, 3);
  assert.equal(t.events7d, 3);
  assert.equal(t.lastActiveAt, at(90));
  assert.equal(t.lastWhat, "pushed to");
  assert.equal(t.items, 1, "the fresh line is inside the delay");
  assert.equal(t.catches, 1);
  assert.equal(t.read, true);
  assert.equal(t.spark.length, 14);
  assert.equal(t.spark[13], 2);
  const org = b[1];
  assert.equal(org.events30d, 1, "only the org's push counts");
  assert.equal(org.lastWhat, "pushed to");
  assert.equal(b[2].read, false);
  assert.equal(b[2].lastActiveAt, null);
  // live (no delay): the fresh push and line appear
  forgetMemos();
  const live = insights().builders(at(0))[0];
  assert.equal(live.events30d, 4);
  assert.equal(live.items, 2);
});

test("a builder's page: 84 days, 24 hours, the mix, repos from the stored list (no forks), lines; null off the list", () => {
  const p = insights().profile("@AeYakovenko", cutoff)!;
  assert.equal(p.handle, "aeyakovenko");
  assert.equal(p.days.length, 84);
  assert.equal(p.days.at(-1)!.day, "2026-10-28");
  assert.equal(p.hours.length, 24);
  assert.equal(p.hours.reduce((a, b) => a + b, 0), 3);
  assert.deepEqual(p.mix.map((m) => m.label).sort(), ["code", "issues", "stars and forks"]);
  assert.deepEqual(p.repos.map((r) => r.name), ["percolator", "dts02-6502-signer"]);
  assert.deepEqual(p.languages, [{ name: "Python", repos: 1 }, { name: "Rust", repos: 1 }]);
  assert.deepEqual(p.lines.map((l) => l.id), ["dts02-6502-signer"]);
  assert.equal(p.recent[0].what, "pushed to");
  assert.equal(p.recent[0].url, "https://github.com/aeyakovenko/percolator");
  assert.equal(p.source, "test");
  assert.deepEqual(p.touched[0], { repo: "aeyakovenko/percolator", count: 2 });
  assert.equal(insights().profile("nobody", cutoff), null);
});

test("the pulse: totals, 24 hours by group, groups, leaders, fresh repos and languages, all behind the delay", () => {
  const p = insights().pulse(cutoff);
  assert.equal(p.asOf, cutoff);
  assert.equal(p.totals.accounts, 3);
  assert.equal(p.totals.accountsRead, 1);
  assert.equal(p.totals.lines, 2);
  assert.equal(p.totals.catches, 1);
  assert.equal(p.hours.length, 24);
  assert.equal(p.hours.reduce((n, h) => n + h.total, 0), 3, "toly's two in the last day, the org's push");
  assert.equal(p.hours.reduce((n, h) => n + h.groups.chain, 0), 3);
  assert.equal(p.days.length, 84);
  assert.deepEqual(p.groups.map((g) => g.group), ["chain", "wallets", "launchpads", "ai", "oss"]);
  assert.equal(p.groups[0].active24h, 2);
  assert.equal(p.leaders[0].handle, "aeyakovenko");
  assert.equal(p.active[0].handle, "solana-labs");
  assert.deepEqual(p.hottest.map((h) => h.id), ["dts02-6502-signer", "nanochat-v2"]);
  assert.deepEqual(p.fresh.map((f) => f.name), ["dts02-6502-signer"]);
  assert.equal(p.fresh[0].handle, "aeyakovenko");
  assert.deepEqual(p.languages.map((l) => l.name).sort(), ["Python", "Rust"]);
  assert.deepEqual(p.topics, [{ name: "retro", repos: 1 }]);
});

test("search: every word must match, wildcards are plain text, the delay holds", () => {
  const s = insights();
  assert.deepEqual(s.search("signer", cutoff).items.map((i) => i.id), ["dts02-6502-signer"]);
  assert.deepEqual(s.search("6502 signer", cutoff).items.map((i) => i.id), ["dts02-6502-signer"]);
  assert.deepEqual(s.search("too-fresh", cutoff).items, []);
  assert.deepEqual(s.search("%", cutoff).items, []);
  assert.deepEqual(s.search("karpathy", cutoff).builders.map((b) => b.handle), ["karpathy"]);
  assert.deepEqual(s.search("solana", cutoff).builders.map((b) => b.handle).sort(), ["aeyakovenko", "solana-labs"]);
  assert.deepEqual(s.search("   ", cutoff), { items: [], builders: [] });
});

test("plain text from a README: no pictures, no HTML, links as words, no long dashes, a few lines only", () => {
  const md = "# Title\n\n![badge](https://x/b.svg) <img src=x>\n\nA [link](https://a) and <b>bold</b> — text.\n\n```sh\nnpm i\n```\n\n---\n" + "line\n".repeat(40);
  const t = plainText(md, 8);
  assert.doesNotMatch(t, /badge|<|—|```|https/);
  assert.match(t, /A link and bold - text\./);
  assert.ok(t.split("\n").length <= 8);
  assert.equal(tidy("a – b"), "a - b");
});

/** A fetch that answers from a list of [prefix, status, body, headers]; counts calls. */
function fake(routes: [string, number, string, Record<string, string>?][]) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes.find(([p]) => url.startsWith(p));
    if (!r) return new Response("nope", { status: 404 });
    return new Response(r[2], { status: r[1], headers: r[3] ?? {} });
  }) as typeof fetch;
  return { f, calls };
}

test("an item's extra facts: stored data first, the README fetched once in the background, then kept", async () => {
  const { f, calls } = fake([["https://raw.githubusercontent.com/aeyakovenko/dts02-6502-signer/HEAD/README.md", 200, "# DTS-02\n\nA 65C02 signer."]]);
  const e = new Enricher({ db, fetchImpl: f, now: () => NOW, gapMs: 0 });
  const it = line({ id: "dts02-6502-signer" });
  const toItem = (s: StoredItem) => toFeedItem(s, undefined);
  const first = e.more(it, cutoff, toItem);
  // the repo's facts come from the stored list: nothing fetched for them
  assert.equal(first.repo?.stars, 8);
  assert.equal(first.repo?.description, "A signer - for the 6502", "long dashes become hyphens");
  assert.deepEqual(first.pending, ["README"]);
  await e.idle();
  assert.equal(calls.length, 1);
  const second = e.more(it, cutoff, toItem);
  assert.deepEqual(second.pending, []);
  assert.equal(second.text?.kind, "readme");
  assert.match(second.text!.body, /A 65C02 signer\./);
  await e.idle();
  assert.equal(calls.length, 1, "kept: not fetched again");
});

test("an item's extra facts: a push's commits through the API under the hourly budget; kept for good", async () => {
  const sha = "f23d0cb23f3039a3de5d47b094b4ce7ca56b427c";
  const commits = JSON.stringify([{ sha, html_url: `https://github.com/aeyakovenko/percolator/commit/${sha}`, commit: { message: "Fix the thing — again\n\nmore", author: { name: "toly", date: at(90) } } }]);
  const { f, calls } = fake([
    [`https://api.github.com/repos/aeyakovenko/percolator/commits?sha=${sha}`, 200, commits],
    ["https://raw.githubusercontent.com/", 404, ""],
  ]);
  const e = new Enricher({ db, fetchImpl: f, now: () => NOW, gapMs: 0, perHour: 1 });
  const it = line({ id: "percolator-push", kind: "push", repo: "percolator", url: `https://github.com/aeyakovenko/percolator/commit/${sha}` });
  const m = e.more(it, cutoff, (s) => toFeedItem(s, undefined));
  assert.deepEqual(m.pending.sort(), ["README", "commits"]);
  await e.idle();
  const again = e.more(it, cutoff, (s) => toFeedItem(s, undefined));
  assert.equal(again.commits?.[0].message, "Fix the thing - again");
  assert.equal(again.commits?.[0].author, "toly");
  assert.equal(again.text, null, "no README anywhere: a 404 is kept, and nothing shown");
  assert.equal(getExtra(db, "readme:aeyakovenko/percolator")?.status, 404);
  const apiCalls = calls.filter((c) => c.startsWith("https://api.github.com/")).length;
  assert.equal(apiCalls, 1);
  // the budget (1 an hour) is spent: a release's notes are not asked for now
  const rel = e.more(line({ id: "rel", kind: "release", repo: "percolator", version: "v1.0", url: "https://github.com/aeyakovenko/percolator/releases/tag/v1.0" }), cutoff, (s) => toFeedItem(s, undefined));
  assert.deepEqual(rel.pending, []);
  assert.equal(e.allowed(true), false);
});

test("an item's extra facts: the watcher's reserve blocks the API; a 429 pauses everything", async () => {
  setMeta(db, "watcher", JSON.stringify({ rate: { limit: 60, remaining: 4, resetAt: NOW + 600_000 } }));
  const quiet = new Enricher({ db, fetchImpl: fake([]).f, now: () => NOW, gapMs: 0 });
  assert.equal(quiet.allowed(true), false, "the watcher has only 4 left");
  assert.equal(quiet.allowed(false), true, "the raw host is not part of the API limit");
  setMeta(db, "watcher", JSON.stringify({ rate: { limit: 60, remaining: 50, resetAt: NOW + 600_000 } }));
  const { f, calls } = fake([["https://raw.githubusercontent.com/", 429, "slow down", { "retry-after": "120" }]]);
  const e = new Enricher({ db, fetchImpl: f, now: () => NOW, gapMs: 0 });
  e.more(line({ id: "x", repo: "other", url: "https://github.com/aeyakovenko/other" }), cutoff, (s) => toFeedItem(s, undefined));
  await e.idle();
  assert.equal(e.pausedUntil, NOW + 120_000);
  assert.equal(e.allowed(false), false);
  assert.equal(e.allowed(true), false);
  const n = calls.length;
  assert.deepEqual(e.more(line({ id: "y", repo: "another", url: "https://github.com/aeyakovenko/another" }), cutoff, (s) => toFeedItem(s, undefined)).pending, []);
  await e.idle();
  assert.equal(calls.length, n, "nothing asked while paused");
  setMeta(db, "enrich_paused_until", "0");
  // switched off: stored data only
  const off = new Enricher({ db, enabled: false, fetchImpl: f, now: () => NOW });
  assert.equal(off.allowed(false), false);
});

test("pictures: watchlist accounts only, fetched once and kept, a 429 pauses", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let status = 200;
  const calls: string[] = [];
  const f = (async (u: string | URL | Request) => {
    calls.push(String(u));
    return status === 200 ? new Response(png, { status: 200, headers: { "content-type": "image/png" } }) : new Response("no", { status, headers: { "retry-after": "60" } });
  }) as typeof fetch;
  const a = new Avatars({ db, dir: join(dir, "avatars"), handles: accounts.map((x) => x.handle), fetchImpl: f, now: () => NOW });
  assert.equal(await a.get("stranger"), null);
  assert.equal(calls.length, 0, "never fetched for someone off the list");
  const pic = await a.get("aeyakovenko");
  assert.equal(pic?.type, "image/png");
  await a.get("AeYakovenko");
  assert.equal(calls.length, 1, "kept for a week");
  status = 429;
  assert.equal(await a.get("karpathy"), null);
  assert.equal(await a.get("solana-labs"), null);
  assert.equal(calls.length, 2, "paused after the 429");
});

test("the API: /v1/pulse, /v1/builders, a builder's page, an item's extras, search, pictures", async () => {
  const server: Server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, now: () => NOW });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
  };
  try {
    const pulse = await get("/v1/pulse");
    assert.equal(pulse.status, 200);
    for (const k of ["asOf", "totals", "hours", "days", "groups", "active", "leaders", "hottest", "busiestDays", "languages", "topics", "fresh", "sample"]) assert.ok(k in pulse.body, `pulse has ${k}`);
    const b = await get("/v1/builders");
    assert.equal((b.body.builders as unknown[]).length, 3);
    assert.equal((await get("/v1/builders/aeyakovenko")).status, 200);
    assert.equal((await get("/v1/builders/nobody")).status, 404);
    assert.equal((await get("/v1/pulse?delay=0")).status, 401, "live needs the key or a holder");
    const more = await get("/v1/feed/dts02-6502-signer/more");
    assert.equal(more.status, 200);
    assert.ok("repo" in (more.body.more as object));
    assert.equal((await get("/v1/feed/too-fresh/more")).status, 404, "inside the delay");
    assert.equal((await get("/v1/feed/nope/more")).status, 404);
    const s = await get("/v1/search?q=nanochat");
    assert.deepEqual((s.body.items as { id: string }[]).map((i) => i.id), ["nanochat-v2"]);
    assert.equal((await fetch(base + "/v1/avatar/aeyakovenko")).status, 404, "no pictures on this API");
  } finally {
    server.close();
  }
});
