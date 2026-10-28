// The feed API against a temporary sqlite file: the site's exact shapes, the filters, the public delay, the live
// key rule, the catches log and the stream.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApi, delayFor, liveKeyOk } from "../src/api.ts";
import { insertItem, openDb, type DB, type StoredItem } from "../src/db.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";

const KEY = "s3cret-live-key";
const accounts: WatchEntry[] = [toly, someOrg, { handle: "karpathy", name: "Andrej Karpathy", org: "nanoGPT", group: "ai", type: "user", followers: 228000, source: "t" }];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function item(p: Partial<StoredItem> & { id: string }): StoredItem {
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
    githubAt: ago(30),
    seenAt: ago(29),
    shownAt: ago(29),
    url: `https://github.com/aeyakovenko/${p.id}`,
    backfill: false,
    ...p,
  };
}

let dir: string, db: DB, server: Server, base: string, noKeyServer: Server, noKeyBase: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pushd-api-"));
  db = openDb(join(dir, "test.sqlite"));
  insertItem(db, item({ id: "dts02-6502-signer", heat: "high", score: 7, githubAt: ago(40), seenAt: ago(39), shownAt: ago(39) }));
  insertItem(db, item({ id: "nanochat-v2-0-0", handle: "karpathy", group: "ai", kind: "release", repo: "nanochat", version: "v2.0.0", heat: "veryHigh", score: 9, githubAt: ago(20), seenAt: ago(19), shownAt: ago(19) }));
  insertItem(db, item({ id: "spl-push", handle: "solana-labs", kind: "push", repo: "spl", heat: "medium", score: 4, githubAt: ago(15), seenAt: ago(14), shownAt: ago(14) }));
  // still inside the 5 minute public delay
  insertItem(db, item({ id: "fresh-one", heat: "veryHigh", score: 8, githubAt: ago(2), seenAt: ago(1), shownAt: ago(1) }));
  server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: KEY, streamTickMs: 30 });
  noKeyServer = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => noKeyServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  noKeyBase = `http://127.0.0.1:${(noKeyServer.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  noKeyServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string, headers: Record<string, string> = {}, at = base) => {
  const r = await fetch(at + path, { headers });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const FEED_KEYS = ["id", "handle", "name", "org", "group", "kind", "repo", "version", "summary", "heat", "score", "signals", "githubAt", "shownAt", "url", "mediaUrl", "sample", "backfill"];

test("/v1/feed: the site's FeedItem shape, newest first, nothing marked sample, the public delay applied", async () => {
  const { status, body } = await get("/v1/feed?view=public");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["items"]);
  const items = body.items as Record<string, unknown>[];
  assert.deepEqual(items.map((i) => i.id), ["spl-push", "nanochat-v2-0-0", "dts02-6502-signer"]);
  for (const it of items) {
    for (const k of Object.keys(it)) assert.ok(FEED_KEYS.includes(k), `unexpected key ${k}`);
    for (const k of ["id", "handle", "group", "kind", "repo", "summary", "heat", "githubAt", "shownAt", "url", "mediaUrl", "sample"]) assert.ok(k in it, `missing ${k}`);
    assert.equal(it.sample, false);
    // no picture folder on this API: no line points at a picture
    assert.equal(it.mediaUrl, null);
    assert.equal(typeof it.score, "number");
    assert.ok(Array.isArray(it.signals));
  }
  const toly = items.find((i) => i.id === "dts02-6502-signer")!;
  assert.equal(toly.name, "Anatoly Yakovenko");
  assert.equal(toly.org, "Solana");
  // an org: its name, and "known for" only when it adds something
  const org = items.find((i) => i.id === "spl-push")!;
  assert.equal(org.name, "Solana Labs");
  assert.equal(org.org, "Solana");
  assert.equal(items.find((i) => i.id === "nanochat-v2-0-0")!.version, "v2.0.0");
});

test("/v1/feed filters: group, heat (that heat and up), person, limit", async () => {
  const ids = async (q: string) => ((await get(`/v1/feed?${q}`)).body.items as { id: string }[]).map((i) => i.id);
  assert.deepEqual(await ids("group=ai"), ["nanochat-v2-0-0"]);
  assert.deepEqual(await ids("group=ai-labs"), ["nanochat-v2-0-0"]);
  assert.deepEqual(await ids("heat=high"), ["nanochat-v2-0-0", "dts02-6502-signer"]);
  assert.deepEqual(await ids("heat=veryHigh"), ["nanochat-v2-0-0"]);
  assert.deepEqual(await ids("person=aeyakovenko"), ["dts02-6502-signer"]);
  assert.deepEqual(await ids("limit=1"), ["spl-push"]);
  assert.equal((await get("/v1/feed?group=nope")).status, 400);
  assert.equal((await get("/v1/feed?heat=lukewarm")).status, 400);
  assert.equal((await get("/v1/feed?limit=0")).status, 400);
});

test("the delay rule: under 5 minutes only with the live key; a wrong or missing key is a 401", async () => {
  assert.equal((await get("/v1/feed?delay=0")).status, 401);
  assert.equal((await get("/v1/feed?delay=0", { "x-pushd-live-key": "wrong" })).status, 401);
  assert.equal((await get("/v1/feed?delay=2")).status, 401);
  assert.equal((await get("/v1/feed?delay=0", { "x-pushd-live-key": KEY }, noKeyBase)).status, 401, "no key set: nobody gets live");
  const live = await get("/v1/feed?delay=0", { "x-pushd-live-key": KEY });
  assert.equal(live.status, 200);
  assert.equal((live.body.items as { id: string }[])[0].id, "fresh-one");
  // a longer delay is harmless and open
  assert.equal((await get("/v1/feed?delay=60")).status, 200);
  assert.equal(((await get("/v1/feed?delay=60")).body.items as unknown[]).length, 0);
  assert.equal((await get("/v1/feed?delay=abc")).status, 400);
  // the pure rule
  const o = { publicDelayMinutes: 5, liveKey: KEY };
  assert.equal(delayFor(null, undefined, o), 5);
  assert.equal(delayFor("0", KEY, o), 0);
  assert.equal(delayFor("10", undefined, o), 10);
  assert.throws(() => delayFor("0", undefined, o), /live key/);
  assert.equal(liveKeyOk(KEY, KEY), true);
  assert.equal(liveKeyOk(KEY + "x", KEY), false);
  assert.equal(liveKeyOk(KEY, null), false);
  assert.equal(liveKeyOk("", ""), false);
});

test("/v1/feed/:id: { item }, a 404 when missing or still inside the delay", async () => {
  const one = await get("/v1/feed/dts02-6502-signer?view=public");
  assert.equal(one.status, 200);
  assert.deepEqual(Object.keys(one.body), ["item"]);
  assert.equal((one.body.item as { repo: string }).repo, "dts02-6502-signer");
  assert.equal((await get("/v1/feed/nope")).status, 404);
  assert.equal((await get("/v1/feed/fresh-one")).status, 404);
  assert.equal((await get("/v1/feed/fresh-one?delay=0", { "x-pushd-live-key": KEY })).status, 200);
});

test("/v1/stats and /v1/watchlist: exactly the site's shapes", async () => {
  const s = await get("/v1/stats");
  const { schedule, ...rest } = s.body as Record<string, unknown>;
  // the pool and the last pass come from the ranking's tables (none here); the plan from src/plan.ts
  assert.deepEqual(rest, { builders: 3, groups: 5, publicDelayMinutes: 5, pool: 0, lastPass: null });
  assert.equal((schedule as { authenticated: boolean }).authenticated, false);
  assert.deepEqual(Object.keys(schedule as object).sort(), ["authenticated", "limitPerHour", "note", "shares", "spentLastHour", "tiers"]);
  const w = await get("/v1/watchlist");
  const groups = w.body.groups as { group: string; count: number; members: Record<string, unknown>[] }[];
  assert.deepEqual(groups.map((g) => g.group), ["chain", "wallets", "launchpads", "ai", "oss"]);
  assert.equal(groups.reduce((n, g) => n + g.count, 0), 3);
  for (const g of groups) {
    assert.deepEqual(Object.keys(g), ["group", "count", "members"]);
    assert.equal(g.members.length, Math.min(g.count, 8));
    for (const m of g.members) {
      assert.deepEqual(Object.keys(m).sort(), ["group", "handle", "name", "org", "sample"]);
      assert.equal(m.sample, false);
    }
  }
});

test("/v1/catches: high and up only, with githubAt and shownAt, behind the same delay", async () => {
  const c = await get("/v1/catches");
  const items = c.body.items as { id: string; heat: string; githubAt: string; shownAt: string }[];
  assert.deepEqual(items.map((i) => i.id), ["nanochat-v2-0-0", "dts02-6502-signer"]);
  for (const i of items) {
    assert.ok(["high", "veryHigh"].includes(i.heat));
    assert.ok(i.githubAt < i.shownAt);
  }
  const live = await get("/v1/catches?delay=0", { "x-pushd-live-key": KEY });
  assert.equal((live.body.items as unknown[]).length, 3);
});

test("/v1/stream: a new line arrives as a server-sent event, once", async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/v1/stream?delay=0`, { headers: { "x-pushd-live-key": KEY }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  insertItem(db, item({ id: "streamed", heat: "high", score: 6, githubAt: new Date().toISOString(), seenAt: new Date().toISOString(), shownAt: new Date().toISOString() }));
  let text = "";
  const until = Date.now() + 3000;
  while (!text.includes("event: item") && Date.now() < until) text += dec.decode((await reader.read()).value);
  ctl.abort();
  assert.match(text, /event: item\ndata: \{.*"id":"streamed"/);
  assert.equal(text.split('"id":"streamed"').length - 1, 1);
  // the public stream does not get it before the delay
  assert.equal((await get("/v1/stream?delay=0")).status, 401);
});

test("/health answers; unknown paths are 404 and other methods 405, as JSON", async () => {
  const h = await get("/health");
  assert.equal(h.body.ok, true);
  assert.equal((await get("/v2/nothing")).status, 404);
  const post = await fetch(base + "/v1/feed", { method: "POST" });
  assert.equal(post.status, 405);
  assert.deepEqual(await post.json(), { error: "GET only" });
});
