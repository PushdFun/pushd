// Look up anyone: what was typed, an account's and a repo's page built on demand, the lookup's own share of the hour
// (it never starves the watcher), the per-visitor limit, the cache and its stale answers, "busy, try in a minute",
// the redirect for the watched, the private list, search with GitHub's results labelled apart, and the scout read's
// allowances. Plus the GitHub allowance plan itself.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bookSpend, openDb, spendSince } from "../src/db.ts";
import { githubTokenFrom } from "../src/config.ts";
import { GitHub } from "../src/github.ts";
import { Lookup, LookupError, lookupConfigFromEnv, parseQuery } from "../src/lookup.ts";
import { extraMinutes, schedulePlan, shareRoom, sharesFor, tierMinutes } from "../src/plan.ts";
import { rankConfigFromEnv } from "../src/rank/config.ts";
import { ensureRankSchema } from "../src/rank/store.ts";
import { Registry } from "../src/registry.ts";
import { Scouts } from "../src/scouts/scouts.ts";
import { scoutConfig } from "./scout-helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");

describe("the GitHub allowance plan", () => {
  test("with a token the shares add up to well under 5,000 an hour, and the tiers read the Top 100 every 2, 5 and 12 minutes", () => {
    const s = sharesFor(true, {});
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    assert.ok(total <= 4000, `${total}`);
    assert.deepEqual(tierMinutes(100, s.watch, true), { 1: 2, 2: 5, 3: 12 });
  });

  test("without a token everything is slower and says so; the shares fit in 60", () => {
    const s = sharesFor(false, {});
    assert.ok(Object.values(s).reduce((a, b) => a + b, 0) <= 60);
    const t = tierMinutes(100, s.watch, false);
    assert.ok(t[1] >= 60 && t[3] > t[2] && t[2] > t[1]);
    const p = schedulePlan(null, 100, false, {}, NOW);
    assert.match(p.note, /No GitHub token/);
    assert.deepEqual(p.tiers.map((x) => x.ranks), ["1 to 20", "21 to 50", "51 to 100"]);
    assert.equal(p.tiers[0].withTokenMin, 2);
  });

  test("each part books what it spends; 304s are free; a part over its share has no room", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++) bookSpend(db, "lookup", "core", false, NOW);
    bookSpend(db, "lookup", "core", true, NOW);
    bookSpend(db, "watch", "core", false, NOW);
    assert.deepEqual(spendSince(db, NOW - 1000).find((r) => r.part === "lookup"), { part: "lookup", resource: "core", n: 5, free: 1 });
    assert.equal(shareRoom(db, "lookup", false, 3, NOW, {}), true, "8 an hour without a token: 5 spent, 3 more fit");
    assert.equal(shareRoom(db, "lookup", false, 4, NOW, {}), false);
    assert.equal(extraMinutes(10, sharesFor(true, {}).extra, true), 10);
  });

  test("the token: the environment first, then the local file; never anything that does not look like a token", () => {
    assert.equal(githubTokenFrom({ PUSHD_GITHUB_TOKEN: " abc_123456789012345678901234 " }, null), "abc_123456789012345678901234");
    assert.equal(githubTokenFrom({}, "/nonexistent/file"), null);
  });
});

describe("what was typed", () => {
  test("a username, owner/name, a GitHub link, or words", () => {
    assert.deepEqual(parseQuery("@toly"), { kind: "user", login: "toly" });
    assert.deepEqual(parseQuery("elizaOS/eliza"), { kind: "repo", owner: "elizaOS", name: "eliza" });
    assert.deepEqual(parseQuery("https://github.com/elizaOS/eliza.git"), { kind: "repo", owner: "elizaOS", name: "eliza" });
    assert.deepEqual(parseQuery("github.com/jup-ag"), { kind: "user", login: "jup-ag" });
    assert.deepEqual(parseQuery("agent framework"), { kind: "words", text: "agent framework" });
  });
});

const user = { login: "SomeDev", type: "User", name: "Some Dev", bio: "builds things", company: null, blog: "somedev.xyz", followers: 1234, following: 5, public_repos: 12, created_at: "2019-01-01T00:00:00Z", html_url: "https://github.com/SomeDev" };
const events = [
  { id: "1", type: "PushEvent", actor: { login: "SomeDev" }, repo: { id: 1, name: "SomeDev/tool" }, created_at: "2026-10-28T10:00:00Z", payload: {} },
  { id: "2", type: "CreateEvent", actor: { login: "SomeDev" }, repo: { id: 2, name: "SomeDev/new-thing" }, created_at: "2026-10-27T09:00:00Z", payload: { ref_type: "repository" } },
  { id: "3", type: "WatchEvent", actor: { login: "SomeDev" }, repo: { id: 3, name: "x/y" }, created_at: "2026-10-26T09:00:00Z", payload: {} },
];
const repos = [
  { name: "tool", full_name: "SomeDev/tool", owner: { login: "SomeDev", type: "User" }, description: "A tool", language: "Rust", stargazers_count: 50, forks_count: 2, created_at: "2025-01-01T00:00:00Z", pushed_at: "2026-10-28T10:00:00Z", fork: false, default_branch: "main", html_url: "https://github.com/SomeDev/tool" },
  { name: "fork", full_name: "SomeDev/fork", owner: { login: "SomeDev", type: "User" }, description: null, language: "Go", stargazers_count: 500, forks_count: 0, created_at: "2025-01-01T00:00:00Z", pushed_at: "2026-10-28T10:00:00Z", fork: true, default_branch: "main", html_url: "https://github.com/SomeDev/fork" },
];

function world(o: { remaining?: number; token?: boolean; env?: Record<string, string> } = {}) {
  const db = openDb(":memory:");
  ensureRankSchema(db);
  let t = NOW;
  const calls: string[] = [];
  let remaining = o.remaining ?? 4000;
  const routes: Record<string, unknown> = {
    "https://api.github.com/users/SomeDev/events/public": events,
    "https://api.github.com/users/SomeDev/repos": repos,
    "https://api.github.com/users/SomeDev": user,
    "https://api.github.com/users/somedev": user,
    "https://api.github.com/repos/SomeDev/tool/commits": [{ sha: "abc", html_url: "https://github.com/SomeDev/tool/commit/abc", commit: { message: "Add the thing\n\nmore", author: { name: "Some Dev", date: "2026-10-28T10:00:00Z" } } }],
    "https://api.github.com/repos/SomeDev/tool/releases": [{ tag_name: "v1.0.0", name: "One", published_at: "2026-10-20T00:00:00Z", html_url: "https://github.com/SomeDev/tool/releases/tag/v1.0.0", prerelease: false, draft: false }],
    "https://api.github.com/repos/SomeDev/tool": { ...repos[0], subscribers_count: 4, open_issues_count: 1, topics: ["cli"], license: { spdx_id: "MIT" } },
    "https://raw.githubusercontent.com/SomeDev/tool/main/README.md": "# tool\n\nA tool that does a thing.",
    "https://api.github.com/search/users": { items: [{ login: "agentdev", type: "User" }, { login: "HiddenOrg", type: "Organization" }] },
    "https://api.github.com/search/repositories": { items: [{ full_name: "agentdev/agent", description: "An agent", stargazers_count: 9, language: "TS", pushed_at: "2026-10-27T00:00:00Z", fork: false }] },
  };
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const search = url.includes("/search/");
    const headers = { "x-ratelimit-limit": search ? "30" : "5000", "x-ratelimit-remaining": String(search ? 29 : --remaining), "x-ratelimit-reset": String(Math.floor(t / 1000) + 3600), "x-ratelimit-resource": search ? "search" : "core", "content-type": "application/json" };
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => url.startsWith(k));
    if (!hit) return new Response("{}", { status: 404, headers });
    return new Response(typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1]), { status: 200, headers });
  }) as typeof fetch;
  const gh = new GitHub({ db, token: o.token === false ? null : "t".repeat(30), fetchImpl: f, now: () => t, part: "lookup", wait: false });
  const registry = new Registry(db, [{ handle: "watched-dev", name: "W", org: "W", group: "ai", type: "user", source: "t" }]);
  const scouts = new Scouts({ db, accounts: registry.known, config: scoutConfig({}, null), provider: null, gh: null, now: () => t });
  const lookup = new Lookup({ db, gh, registry, ranker: null, scouts, rank: rankConfigFromEnv({ PUSHD_DENY_PRIVATE: "HiddenOrg" }), searchWatch: () => ({ items: [], builders: [] }), config: lookupConfigFromEnv({ ...o.env }, o.token !== false), now: () => t });
  return { db, lookup, calls, advance: (ms: number) => (t += ms) };
}

describe("an account's page", () => {
  test("built from three requests, then kept: the second look costs nothing", async () => {
    const w = world();
    const a = await w.lookup.user("SomeDev", "v1");
    assert.ok("page" in a);
    const p = a.page;
    assert.equal(p.user.login, "SomeDev");
    assert.equal(p.user.blog, "https://somedev.xyz");
    assert.equal(p.days.length, 84);
    assert.equal(p.days.reduce((n, d) => n + d.events, 0), 3);
    assert.deepEqual(p.repos.map((r) => r.name), ["tool"], "forks are not its own repos");
    assert.equal(p.recent[0].what, "pushed to");
    assert.equal(p.stale, false);
    assert.equal(w.calls.length, 3);
    await w.lookup.user("somedev", "v2");
    assert.equal(w.calls.length, 3, "kept");
    const spent = spendSince(w.db, 0).find((r) => r.part === "lookup");
    assert.equal(spent?.n, 3, "booked to the lookup share");
  });

  test("the watched go to their builder page; the private list is never shown", async () => {
    const w = world();
    assert.deepEqual(await w.lookup.user("watched-dev", "v"), { redirect: "/builders/watched-dev" });
    await assert.rejects(w.lookup.user("HiddenOrg", "v"), (e: LookupError) => e.status === 404);
    assert.equal(w.calls.length, 0, "nothing asked of GitHub for either");
  });

  test("a visitor gets a few fresh builds a minute; past that: busy, try in a minute (kept pages still answer)", async () => {
    const w = world({ env: { PUSHD_LOOKUP_PER_MIN: "1" } });
    await w.lookup.user("SomeDev", "v1");
    await assert.rejects(w.lookup.repo("SomeDev", "tool", "v1", null), (e: LookupError) => e.status === 503 && (e.retryInSec ?? 0) >= 5);
    const again = await w.lookup.user("SomeDev", "v1");
    assert.ok("page" in again, "a kept page is free");
    assert.ok("page" in (await w.lookup.repo("SomeDev", "tool", "v2", null)), "another visitor is not held up");
  });

  test("the lookup share of the hour: used up, a page that was kept is served as stale, and an unknown one is busy", async () => {
    const w = world({ token: false });
    await w.lookup.user("SomeDev", "v1");
    w.advance(7 * 3_600_000);
    for (let i = 0; i < 8; i++) bookSpend(w.db, "lookup", "core", false, NOW + 7 * 3_600_000);
    const stale = await w.lookup.user("SomeDev", "v2");
    assert.ok("page" in stale && stale.page.stale, "served stale");
    await assert.rejects(w.lookup.repo("SomeDev", "tool", "v3", null), (e: LookupError) => e.status === 503 && /busy/i.test(e.message));
    assert.equal(w.calls.length, 3, "no request over the share");
  });

  test("the watcher comes first: with GitHub's own count low, lookups wait", async () => {
    const w = world({ remaining: 400 });
    await assert.rejects(
      (async () => {
        await w.lookup.user("SomeDev", "v1"); // the reading arrives with these answers: about 400 left, under the reserve
        await w.lookup.repo("SomeDev", "tool", "v1", null);
      })(),
      (e: LookupError) => e.status === 503,
    );
  });
});

describe("a repo's page, search and the scout read", () => {
  test("a repo: facts, README head, commits, releases, the scout it routes to, and the read's allowance", async () => {
    const w = world();
    const { page } = await w.lookup.repo("SomeDev", "tool", "v1", null);
    assert.equal(page.repo.fullName, "SomeDev/tool");
    assert.equal(page.repo.license, "MIT");
    assert.equal(page.readme, "# tool\n\nA tool that does a thing.");
    assert.equal(page.commits[0].message, "Add the thing");
    assert.equal(page.releases[0].tag, "v1.0.0");
    assert.equal(page.scout, "deepseek");
    assert.match(page.scoutWhy, /not in a camp/);
    assert.equal(page.allowance.open, false, "no model here");
    assert.equal(page.allowance.mode, "template");
    await assert.rejects(w.lookup.read("SomeDev", "tool", "v1", null), (e: LookupError) => e.status === 503);
  });

  test("search: a direct link for a username or owner/name; GitHub's results apart, without the private list", async () => {
    const w = world();
    const r = await w.lookup.search("agent", "v1");
    assert.equal(r.direct?.href, "/gh/agent");
    assert.deepEqual(r.github.users.map((u) => u.login), ["agentdev"]);
    assert.equal(r.github.repos[0].fullName, "agentdev/agent");
    assert.equal(r.github.busy, false);
    const again = await w.lookup.search("agent", "v2");
    assert.deepEqual(again.github.users, r.github.users);
    assert.equal(w.calls.filter((c) => c.includes("/search/")).length, 2, "kept ten minutes");
    assert.equal((await w.lookup.search("elizaOS/eliza", "v1")).direct?.href, "/gh/elizaOS/eliza");
  });

  test("search: over the lookup's search allowance, GitHub's part says busy and the rest still answers", async () => {
    const w = world({ env: { PUSHD_LOOKUP_SEARCH_PER_MIN: "2" } });
    await w.lookup.search("one", "v1");
    const r = await w.lookup.search("two", "v1");
    assert.equal(r.github.busy, true);
    assert.ok((r.github.retryInSec ?? 0) > 0);
    assert.deepEqual(r.watch, { items: [], builders: [] });
  });
});
