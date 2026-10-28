// The ranking: who may be in the pool (the token gates, the giants and the private list, forks, mirrors, templates,
// spam), the camps, counting a GH Archive hour, the score and its breakdown, the rotation's hysteresis, the live
// lists, and a whole deep pass over pretend sources.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { openDb } from "../src/db.ts";
import { GitHub } from "../src/github.ts";
import { addressesIn, campOf, githubLinksIn, githubOwner, isBot, repoNoise } from "../src/rank/classify.ts";
import { denied, deniedRepo, privateDeny, rankConfigFromEnv } from "../src/rank/config.ts";
import { countEvents, hourKey, kindOf, processHour } from "../src/rank/gharchive.ts";
import { Pool } from "../src/rank/pool.ts";
import { Ranker } from "../src/rank/ranker.ts";
import { campOrder, rotate, type StateRow } from "../src/rank/rotate.ts";
import { blend, scoreAll } from "../src/rank/score.ts";
import { ensureRankSchema, type PoolRow } from "../src/rank/store.ts";
import { Registry, whoOf } from "../src/registry.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400_000;

describe("who may be in the pool", () => {
  test("the camps: AI agents first, then tools and infra, then by chain", () => {
    assert.equal(campOf({ chain: "solana", categories: ["AI Agents"], text: "" }), "ai");
    assert.equal(campOf({ chain: "base", categories: [], text: "an autonomous agent framework" }), "ai");
    assert.equal(campOf({ chain: "solana", categories: ["Oracle"], text: "" }), "oss");
    assert.equal(campOf({ chain: "solana", categories: ["Pump.fun Ecosystem", "Meme"], text: "a cat coin" }), "launchpads");
    assert.equal(campOf({ chain: "robinhood", categories: [], text: "a frog" }), "chain");
    assert.equal(campOf({ chain: "base", categories: ["Base Meme"], text: "a frog" }), "wallets");
  });

  test("forks, mirrors, templates, empty repos, tutorials and trading-bot spam are not a project's own work", () => {
    assert.equal(repoNoise({ name: "x", description: null, fork: true }), "a fork");
    assert.equal(repoNoise({ name: "x", description: "Read-only mirror of the main repo", fork: false }), "a mirror");
    assert.equal(repoNoise({ name: "x", description: null, fork: false, template: true }), "a template");
    assert.equal(repoNoise({ name: "x", description: null, fork: false, size: 0 }), "empty");
    assert.equal(repoNoise({ name: "solana-sniper-bot", description: "fastest sniper", fork: false }), "a trading bot or spam");
    assert.equal(repoNoise({ name: "solidity-course", description: null, fork: false }), "a tutorial or course");
    assert.equal(repoNoise({ name: "agent-sdk", description: "The SDK for our agents", fork: false, size: 120 }), null);
    assert.ok(isBot("dependabot[bot]") && isBot("renovate-bot") && !isBot("toly"));
  });

  test("GitHub links and token addresses are read from listings, pages and READMEs", () => {
    assert.deepEqual(githubOwner("https://github.com/Virtual-Protocol"), { owner: "Virtual-Protocol", repo: null });
    assert.deepEqual(githubOwner("https://github.com/elizaOS/eliza/tree/main"), { owner: "elizaOS", repo: "eliza" });
    assert.equal(githubOwner("https://github.com/orgs/foo"), null);
    assert.equal(githubOwner("https://gitlab.com/foo"), null);
    assert.deepEqual(githubLinksIn('<a href="https://github.com/acme/agent">code</a> <a href="https://github.com/sponsors/x">s</a>'), ["https://github.com/acme/agent"]);
    const a = addressesIn("CA: `4LLwtXzS5kmbbAB3Lxic1KcMLs44gagFKexmjbQcpump` and 0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b, not abcdefghijklmnopqrstuvwxyzabcdefgh");
    assert.deepEqual(a.map((x) => x.kind), ["evm", "solana"]);
  });

  test("the giants and the private list are never in the pool; the private list is never shown anywhere", () => {
    const c = rankConfigFromEnv({ PUSHD_DENY_PRIVATE: "SecretOrg,repo:axon" });
    for (const g of ["ethereum", "Bitcoin", "torvalds", "openai", "vbuterin", "twitter", "solana-labs"]) assert.ok(denied(c, g), g);
    assert.ok(denied(c, "secretorg") && denied(c, "SecretOrg", { privateOnly: true }));
    assert.ok(!denied(c, "openai", { privateOnly: true }), "a giant may still be looked up");
    assert.ok(deniedRepo(c, "Axon") && !deniedRepo(c, "eliza"));
    assert.ok(!denied(c, "elizaOS"));
    // the local file is the default when the environment names none
    const fromFile = privateDeny({}, new URL("../data/deny.private.json", import.meta.url).pathname);
    assert.ok(fromFile.accounts.length > 5 && fromFile.repoNames.includes("axon"));
  });
});

describe("GH Archive", () => {
  test("an hour's file name and what each event counts as", () => {
    assert.equal(hourKey(Date.parse("2026-10-28T09:30:00Z")), "2026-10-28-9");
    assert.deepEqual(kindOf({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { merged: true } } }), { k: "pr_merged", n: 1, contributor: true });
    assert.equal(kindOf({ type: "WatchEvent" })?.k, "star");
    assert.equal(kindOf({ type: "PushEvent", payload: { size: 3 } })?.n, 3);
    assert.equal(kindOf({ type: "MemberEvent" }), null);
  });

  test("an hour is streamed and counted for the pool's owners only, bots left out, nothing kept on disk", async () => {
    const db = openDb(":memory:");
    ensureRankSchema(db);
    const ev = (type: string, repo: string, actor: string, payload: object = {}) => JSON.stringify({ type, repo: { name: repo }, actor: { login: actor }, payload });
    const lines = [
      ev("PullRequestEvent", "acme/agent", "alice", { action: "opened" }),
      ev("PullRequestEvent", "acme/agent", "bob", { action: "closed", pull_request: { merged: true } }),
      ev("WatchEvent", "acme/agent", "carol"),
      ev("WatchEvent", "Acme/site", "dave"),
      ev("IssueCommentEvent", "acme/agent", "github-actions[bot]"),
      ev("ReleaseEvent", "acme/agent", "alice", { action: "published" }),
      ev("WatchEvent", "someone/else", "erin"),
    ].join("\n");
    const body = gzipSync(Buffer.from(lines));
    const f = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const r = await processHour(db, "2026-10-28-9", (o) => o === "acme", f, () => NOW);
    assert.equal(r.status, 200);
    assert.equal(r.events, 7);
    assert.equal(r.kept, 5);
    const acts = Object.fromEntries((db.prepare("SELECT k, n FROM act_hour WHERE login = 'acme'").all() as { k: string; n: number }[]).map((x) => [x.k, x.n]));
    assert.deepEqual(acts, { pr_open: 1, pr_merged: 1, star: 2, release: 1 });
    assert.equal((db.prepare("SELECT count(*) AS n FROM act_actor WHERE login = 'acme'").get() as { n: number }).n, 2, "contributors: alice and bob");
    assert.equal((db.prepare("SELECT bytes FROM source_calls WHERE source = 'gharchive'").get() as { bytes: number }).bytes, body.length);
    // a stream of plain lines counts the same way
    async function* gen() {
      yield ev("ForkEvent", "acme/agent", "zed");
    }
    assert.deepEqual(await countEvents(db, "2026-10-28-10", gen(), (o) => o === "acme"), { events: 1, kept: 1 });
  });
});

function row(login: string, p: Partial<PoolRow> = {}): PoolRow {
  return {
    login: login.toLowerCase(),
    display: login,
    type: "org",
    name: login,
    symbol: login.slice(0, 4).toUpperCase(),
    chain: "solana",
    address: `${login}pump`,
    dex_url: null,
    pair_created_at: NOW - 90 * DAY,
    liquidity_usd: 100_000,
    volume_usd: 50_000,
    volume_h6: 12_000,
    mcap_usd: 5_000_000,
    token_at: NOW,
    repo: null,
    camp: "launchpads",
    categories: "[]",
    description: null,
    sources: '["coingecko","github via CoinGecko"]',
    status: "ok",
    why: null,
    followers: 100,
    followers_at: NOW,
    gh: JSON.stringify({ type: "org", display: login, repos: [], commits: { d1: 0, d7: 0, d30: 0, authors7: 0, authors30: 0, total30: 0 }, pushedAt: new Date(NOW - DAY).toISOString(), readAt: NOW }),
    gh_at: NOW,
    added_at: NOW - 10 * DAY,
    checked_at: NOW,
    ...p,
  };
}

function insertRow(db: ReturnType<typeof openDb>, r: PoolRow) {
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO pool (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(r);
}

const gh = (commits: { d1: number; d7: number; d30: number }, authors = 1) => JSON.stringify({ type: "org", display: "x", repos: [], commits: { ...commits, authors7: authors, authors30: authors, total30: commits.d30 }, pushedAt: new Date(NOW - DAY).toISOString(), readAt: NOW });

describe("the score", () => {
  test("the decay weighs the last day most and the month least", () => {
    const recent = blend({ "24h": 10, "7d": 10, "30d": 10 }, 7);
    const old = blend({ "24h": 0, "7d": 0, "30d": 10 }, 7);
    assert.ok(recent > old * 5);
  });

  test("busier projects score higher, every part is explained, and the points add up to the score", () => {
    const db = openDb(":memory:");
    ensureRankSchema(db);
    const rows = [row("busy", { gh: gh({ d1: 20, d7: 120, d30: 400 }, 9) }), row("mid", { gh: gh({ d1: 2, d7: 15, d30: 60 }, 3) }), row("quiet", { gh: gh({ d1: 0, d7: 0, d30: 2 }, 1) })];
    for (const r of rows) insertRow(db, r);
    db.prepare("INSERT INTO act_hour (login, hour, k, n) VALUES ('busy', '2026-10-28-10', 'star', 40), ('busy', '2026-10-28-10', 'pr_merged', 6)").run();
    const s = scoreAll(db, rows, rankConfigFromEnv({}), NOW);
    assert.deepEqual(s.map((x) => x.login), ["busy", "mid", "quiet"]);
    for (const x of s) {
      assert.equal(x.parts.length, 10);
      assert.ok(Math.abs(x.parts.reduce((a, p) => a + p.points, 0) - x.score) < 0.6);
      assert.ok(x.score >= 0 && x.score <= 100);
    }
    const commits = s[0].parts.find((p) => p.key === "commits")!;
    assert.deepEqual(commits.raw, { "24h": 20, "7d": 120, "30d": 400 });
    assert.equal(commits.norm, 1);
    assert.equal(s[0].parts.find((p) => p.key === "stars")!.raw["24h"], 40);
  });
});

describe("the rotation", () => {
  const rules = { size: 3, enterRank: 2, enterPasses: 2, exitRank: 4, exitPasses: 2, minDwellHours: 1, campMin: 0 };
  const ranked = (logins: string[]) => logins.map((l, i) => ({ login: l, score: 100 - i, parts: [] }));

  test("the first pass fills the list at once", () => {
    const r = rotate({ order: ranked(["a", "b", "c", "d"]), state: new Map(), gone: new Map(), peak14: () => null, rules, now: NOW });
    assert.deepEqual([...r.next.values()].filter((s) => s.in_top).map((s) => s.login), ["a", "b", "c"]);
    assert.ok(r.changes.every((c) => c.change === "enter" && /first ranking/.test(c.reason)));
  });

  test("a newcomer waits for its passes, a member leaves only after its passes below the exit rank and the dwell", () => {
    let state = rotate({ order: ranked(["a", "b", "c", "d", "e"]), state: new Map(), gone: new Map(), peak14: () => null, rules, now: NOW }).next;
    // "e" jumps to the top: one pass is not enough to enter, and nobody has fallen out yet
    let r = rotate({ order: ranked(["e", "a", "b", "d", "c"]), state, gone: new Map(), peak14: () => null, rules, now: NOW + 3_600_000 * 2 });
    assert.equal(r.changes.length, 0, "no churn on one pass");
    state = r.next;
    // "c" is below the exit rank (4) a second pass in a row: it leaves; "e" has its two passes: it enters
    r = rotate({ order: ranked(["e", "a", "b", "d", "c"]), state, gone: new Map(), peak14: (l) => (l === "c" ? 98 : null), rules, now: NOW + 3_600_000 * 3 });
    const ch = Object.fromEntries(r.changes.map((c) => [c.login, c]));
    assert.equal(ch.c?.change, "exit");
    assert.match(ch.c.reason, /ranked below 4 for 2 passes/);
    assert.equal(ch.e?.change, "enter");
    assert.match(ch.e.reason, /top 2 for 2 passes/);
  });

  test("the dwell: a member never leaves before its minimum time in", () => {
    const state = new Map<string, StateRow>([["a", { login: "a", in_top: 1, entered_at: NOW, left_at: null, streak_in: 0, streak_out: 5, rank: 9, score: 1 }]]);
    const r = rotate({ order: ranked(["x", "y", "z", "w", "a"]), state, gone: new Map(), peak14: () => null, rules, now: NOW + 600_000 });
    assert.ok(!r.changes.some((c) => c.login === "a" && c.change === "exit"));
  });

  test("a member that stops being eligible leaves at once, with why; a big drop is said in numbers", () => {
    const state = new Map<string, StateRow>([
      ["a", { login: "a", in_top: 1, entered_at: NOW - DAY, left_at: null, streak_in: 0, streak_out: 0, rank: 1, score: 50 }],
      ["b", { login: "b", in_top: 1, entered_at: NOW - DAY, left_at: null, streak_in: 0, streak_out: 1, rank: 5, score: 20 }],
    ]);
    const r = rotate({ order: [{ login: "x", score: 90, parts: [] }, { login: "y", score: 80, parts: [] }, { login: "z", score: 70, parts: [] }, { login: "w", score: 60, parts: [] }, { login: "b", score: 15, parts: [] }], state, gone: new Map([["a", "no push to its own repos in 30 days"]]), peak14: () => 50, rules, now: NOW });
    const ch = Object.fromEntries(r.changes.filter((c) => c.change === "exit").map((c) => [c.login, c.reason]));
    assert.match(ch.a, /no longer eligible: no push/);
    assert.match(ch.b, /activity dropped 70% over 14 days/);
  });

  test("each camp keeps its minimum inside the list", () => {
    const camp = (l: string) => (l.startsWith("ai") ? "ai" : "launchpads") as "ai" | "launchpads";
    const order = campOrder(ranked(["l1", "l2", "l3", "l4", "ai1", "ai2"]), camp, 4, 1);
    assert.deepEqual(order.slice(0, 4).map((x) => x.login).sort(), ["ai1", "l1", "l2", "l3"]);
  });
});

describe("the live lists and the views", () => {
  test("the registry changes its arrays in place, and lookups follow them; the old list steps aside", () => {
    const db = openDb(":memory:");
    ensureRankSchema(db);
    const reg = new Registry(db, [{ handle: "old", name: "Old", org: "Old", group: "oss", type: "user", source: "t" }]);
    const top = reg.top;
    const known = reg.known;
    assert.equal(top.length, 0);
    assert.ok(whoOf(known).has("old"));
    insertRow(db, row("Acme"));
    db.prepare("INSERT INTO rank_state (login, in_top, entered_at, rank, score) VALUES ('acme', 1, ?, 1, 50)").run(NOW);
    assert.equal(reg.refresh(), true);
    assert.equal(top, reg.top, "the same array");
    assert.deepEqual(top.map((t) => t.handle), ["Acme"]);
    assert.equal(top[0].org, "$ACME");
    assert.ok(whoOf(known).has("acme"));
    assert.ok(!whoOf(known).has("old"), "the old hand-made list is not known once the ranking has a list");
    assert.ok(reg.inTop("ACME"));
  });

  test("a whole deep pass over pretend sources: gates, owners, the GitHub read, the rank and the views", async () => {
    const db = openDb(":memory:");
    const now = () => NOW;
    const c = rankConfigFromEnv({ PUSHD_DENY_PRIVATE: "HiddenOrg", PUSHD_POOL_CODE_SEARCH_PAGES: "0", PUSHD_POOL_GECKO_CATEGORIES: "ai-agents", PUSHD_RANK_CAMP_MIN: "0", PUSHD_TOP_SIZE: "10" }, true);
    const day = (n: number) => NOW - n * DAY;
    const pair = (addr: string, sym: string, liq: number, vol: number, ageDays: number, links: string[] = []) => ({ chainId: "solana", url: `https://dexscreener.com/solana/${addr}`, baseToken: { address: addr, symbol: sym, name: sym }, liquidity: { usd: liq }, volume: { h24: vol, h6: vol / 4 }, marketCap: 1e6, pairCreatedAt: day(ageDays), info: { websites: [], socials: links.map((u) => ({ url: u })) } });
    const routes: Record<string, unknown> = {
      "https://api.dexscreener.com/token-profiles/latest/v1": [{ chainId: "solana", tokenAddress: "NEWxyz", links: [{ url: "https://github.com/young-token" }] }],
      "https://api.dexscreener.com/token-boosts/latest/v1": [],
      "https://api.dexscreener.com/token-boosts/top/v1": [],
      "https://api.dexscreener.com/community-takeovers/latest/v1": [],
      "https://api.coingecko.com/api/v3/coins/markets": [
        { id: "agentx", symbol: "agx", name: "AgentX", market_cap: 2e6, total_volume: 90_000 },
        { id: "hidden", symbol: "hid", name: "Hidden", market_cap: 2e6, total_volume: 80_000 },
        { id: "giant", symbol: "gnt", name: "Giant", market_cap: 2e6, total_volume: 70_000 },
        { id: "sleepy", symbol: "slp", name: "Sleepy", market_cap: 2e6, total_volume: 60_000 },
      ],
      "https://api.coingecko.com/api/v3/coins/agentx": { id: "agentx", symbol: "agx", name: "AgentX", categories: ["AI Agents"], platforms: { solana: "AGXmint" }, links: { repos_url: { github: ["https://github.com/agentx-labs"] } } },
      "https://api.coingecko.com/api/v3/coins/hidden": { id: "hidden", symbol: "hid", name: "Hidden", platforms: { solana: "HIDmint" }, links: { repos_url: { github: ["https://github.com/HiddenOrg"] } } },
      "https://api.coingecko.com/api/v3/coins/giant": { id: "giant", symbol: "gnt", name: "Giant", platforms: { solana: "GNTmint" }, links: { repos_url: { github: ["https://github.com/openai"] } } },
      "https://api.coingecko.com/api/v3/coins/sleepy": { id: "sleepy", symbol: "slp", name: "Sleepy", platforms: { solana: "SLPmint" }, links: { repos_url: { github: ["https://github.com/sleepy-dev"] } } },
      "https://api.dexscreener.com/tokens/v1/solana/": [pair("NEWxyz", "NEW", 80_000, 50_000, 3), pair("AGXmint", "AGX", 200_000, 90_000, 200), pair("HIDmint", "HID", 200_000, 80_000, 200), pair("GNTmint", "GNT", 200_000, 70_000, 200), pair("SLPmint", "SLP", 200_000, 60_000, 200)],
      "https://api.github.com/search/repositories?q=user%3Aagentx-labs": { total_count: 2, items: [{ name: "agent-sdk", owner: { login: "AgentX-Labs", type: "Organization" }, stargazers_count: 300, forks_count: 20, created_at: new Date(day(400)).toISOString(), pushed_at: new Date(day(1)).toISOString(), fork: false, archived: false, size: 900, description: "The agent SDK", topics: ["ai-agents"], language: "TypeScript" }] },
      "https://api.github.com/search/commits?q=user%3Aagentx-labs": { total_count: 140, items: Array.from({ length: 30 }, (_, i) => ({ commit: { committer: { date: new Date(NOW - i * 3_600_000 * 5).toISOString() } }, author: { login: `dev${i % 4}` } })) },
      "https://api.github.com/search/repositories?q=user%3Asleepy-dev": { total_count: 1, items: [{ name: "site", owner: { login: "sleepy-dev", type: "User" }, stargazers_count: 2, forks_count: 0, created_at: new Date(day(500)).toISOString(), pushed_at: new Date(day(120)).toISOString(), fork: false, archived: false, size: 10, description: "", topics: [], language: "HTML" }] },
      "https://api.github.com/search/commits?q=user%3Asleepy-dev": { total_count: 0, items: [] },
      "https://api.github.com/users/AgentX-Labs": { login: "AgentX-Labs", type: "Organization", followers: 900, name: "AgentX" },
    };
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => url.startsWith(k));
      const headers = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4900", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3600), "content-type": "application/json", ...(url.includes("/search/") ? { "x-ratelimit-resource": "search" } : {}) };
      return hit ? new Response(JSON.stringify(hit[1]), { status: 200, headers }) : new Response("{}", { status: 404, headers });
    }) as typeof fetch;
    const sleep = async () => undefined;
    const search = new GitHub({ db, token: "t".repeat(30), fetchImpl: f, now, sleep, part: "search" });
    const core = new GitHub({ db, token: "t".repeat(30), fetchImpl: f, now, sleep, part: "rank", wait: false });
    const pool = new Pool({ db, config: c, search, core, fetchImpl: f, now, sleep });
    const ranker = new Ranker({ db, config: { ...c, sources: { ...c.sources, gharchive: false } }, pool, authenticated: true, fetchImpl: f, now });
    await ranker.deep();
    const rows = db.prepare("SELECT login, status, why, camp, display, followers FROM pool ORDER BY login").all() as { login: string; status: string; why: string | null; camp: string; display: string; followers: number | null }[];
    const by = Object.fromEntries(rows.map((r) => [r.login, r]));
    assert.equal(by["agentx-labs"].status, "ok");
    assert.equal(by["agentx-labs"].camp, "ai");
    assert.equal(by["agentx-labs"].display, "AgentX-Labs");
    assert.equal(by["agentx-labs"].followers, 900);
    assert.equal(by["young-token"].status, "out");
    assert.match(by["young-token"].why!, /less than 30 days/);
    assert.equal(by["sleepy-dev"].status, "out");
    assert.match(by["sleepy-dev"].why!, /no push to its own repos in 30 days/);
    assert.ok(!by["hiddenorg"], "the private list never enters the pool");
    assert.ok(!by["openai"], "a giant never enters the pool");
    assert.ok(!calls.some((u) => /HiddenOrg|hiddenorg/i.test(u) && u.includes("api.github.com")), "nothing is even asked about the private list");
    const view = ranker.top();
    assert.deepEqual(view.rows.map((r) => r.handle), ["AgentX-Labs"]);
    assert.equal(view.rows[0].token?.symbol, "AGX");
    assert.equal(view.rows[0].tier, 1);
    assert.equal(view.rows[0].movement, "new");
    assert.equal(view.entered.length, 0, "the first fill is not shown as entries");
    assert.equal(view.pool, 3, "the private list and the giant are not stored at all");
    const p = ranker.project("agentx-labs")!;
    assert.equal(p.row.rank, 1);
    assert.equal(p.changes[0].change, "enter");
    // what was spent where: the search API for the ranking, one core request for followers
    const spent = db.prepare("SELECT part, resource, count(*) AS n FROM gh_spend GROUP BY 1, 2").all() as { part: string; resource: string; n: number }[];
    assert.deepEqual(spent.find((s) => s.part === "rank"), { part: "rank", resource: "core", n: 1 });
    assert.ok(spent.find((s) => s.part === "search" && s.resource === "search")!.n >= 4);
  });
});
