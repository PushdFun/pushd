// One day at a time (src/days.ts): the days with activity, one day's events and lines, an org's code only, the public
// delay, the groups against their week, the API routes and their 400 on a bad date.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApi } from "../src/api.ts";
import { Days, validDay } from "../src/days.ts";
import { insertItem, openDb, recordEvent, storeCache, toFeedItem, type DB, type StoredItem } from "../src/db.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const karpathy: WatchEntry = { handle: "karpathy", name: "Andrej Karpathy", org: "nanoGPT", group: "ai", type: "user", followers: 228000, source: "t" };
const accounts = [toly, someOrg, karpathy];
const cutoff = new Date(NOW - 5 * 60_000).toISOString();

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
    signals: [],
    githubAt: "2026-10-27T03:14:27Z",
    seenAt: "2026-10-27T03:15:00Z",
    shownAt: "2026-10-27T03:15:00Z",
    url: `https://github.com/aeyakovenko/${p.id}`,
    backfill: false,
    ...p,
  };
}

let dir: string, db: DB;
const ev = (key: string, handle: string, type: string, at: string, seen = at) => recordEvent(db, { key, handle, type, repo: `${handle}/r`, githubAt: at, seenAt: seen, verdict: "activity" });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pushd-days-"));
  db = openDb(join(dir, "t.sqlite"));
  ev("a1", "aeyakovenko", "push", "2026-10-27T03:00:00Z");
  ev("a2", "aeyakovenko", "WatchEvent", "2026-10-27T17:20:00Z");
  ev("a3", "karpathy", "push", "2026-10-27T17:40:00Z");
  ev("a4", "aeyakovenko", "push", "2026-10-26T09:00:00Z");
  ev("a5", "aeyakovenko", "RepoList", "2026-10-27T03:14:27Z");
  // an org: a stranger's star does not count, its push does
  ev("o1", "solana-labs", "WatchEvent", "2026-10-27T10:00:00Z");
  ev("o2", "solana-labs", "push", "2026-10-27T10:05:00Z");
  // today: one seen long ago, one seen a minute ago (inside the delay)
  ev("t1", "karpathy", "push", "2026-10-28T09:00:00Z");
  ev("t2", "karpathy", "push", "2026-10-28T11:57:00Z", "2026-10-28T11:59:00Z");
  insertItem(db, line({ id: "dts02-6502-signer", heat: "high", score: 7 }));
  insertItem(db, line({ id: "too-fresh", githubAt: "2026-10-28T11:57:00Z", seenAt: "2026-10-28T11:59:00Z", shownAt: "2026-10-28T11:59:00Z" }));
  storeCache(
    db,
    "https://api.github.com/users/aeyakovenko/repos?sort=created&direction=desc&per_page=30&type=owner",
    null,
    JSON.stringify([
      { name: "dts02-6502-signer", full_name: "aeyakovenko/dts02-6502-signer", description: "A signer", language: "Python", stargazers_count: 8, created_at: "2026-10-27T03:14:27Z", pushed_at: "2026-10-27T17:00:00Z", html_url: "https://github.com/aeyakovenko/dts02-6502-signer", fork: false },
      { name: "old", full_name: "aeyakovenko/old", description: null, language: "Rust", stargazers_count: 1, created_at: "2025-01-01T00:00:00Z", pushed_at: null, html_url: "https://github.com/aeyakovenko/old", fork: false },
    ]),
  );
  // the list was read before the test's clock (storeCache stamps the real time, which passes NOW after noon 28 Oct)
  db.prepare("UPDATE http_cache SET fetched_at = ?").run("2026-10-28T11:00:00.000Z");
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const days = () => new Days({ db, accounts, toItem: (s) => toFeedItem(s, undefined) });

test("a valid day is a real calendar date in YYYY-MM-DD", () => {
  assert.equal(validDay("2026-10-27"), true);
  assert.equal(validDay("2026-02-30"), false);
  assert.equal(validDay("27-10-2026"), false);
  assert.equal(validDay("2026-10-27T00"), false);
});

test("the days list: days with activity, newest first, behind the delay", () => {
  const list = days().list(cutoff);
  assert.deepEqual(list.map((d) => d.day), ["2026-10-28", "2026-10-27", "2026-10-26"]);
  assert.deepEqual(list[0], { day: "2026-10-28", events: 1, lines: 0, catches: 0 }, "the fresh push and line are inside the delay");
  // toly's push and star, karpathy's push, the org's push; not the org's star, not the repo-list entry
  assert.deepEqual(list[1], { day: "2026-10-27", events: 4, lines: 1, catches: 1 });
});

test("one day: events oldest first, the lines, groups against their week, hours, new repos", () => {
  const d = days().day("2026-10-27", cutoff);
  assert.equal(d.day, "2026-10-27");
  assert.deepEqual(d.events.map((e) => e.at), ["2026-10-27T03:00:00Z", "2026-10-27T10:05:00Z", "2026-10-27T17:20:00Z", "2026-10-27T17:40:00Z"]);
  assert.equal(d.events[0].name, "Anatoly Yakovenko");
  assert.equal(d.events[0].what, "pushed to");
  assert.equal(d.events[2].what, "starred");
  assert.equal(d.totalEvents, 4);
  assert.equal(d.truncated, false);
  assert.deepEqual(d.lines.map((l) => l.id), ["dts02-6502-signer"]);
  assert.equal(d.catches, 1);
  const chain = d.groups.find((g) => g.group === "chain")!;
  assert.equal(chain.events, 3);
  assert.equal(chain.lines, 1);
  assert.equal(chain.avg7, Math.round((1 / 7) * 10) / 10, "the 26 Oct push, over 7 days");
  assert.equal(d.hours[17], 2);
  assert.equal(d.hours.reduce((a, b) => a + b, 0), 4);
  assert.equal(d.top[0].handle, "aeyakovenko");
  assert.deepEqual(d.fresh.map((f) => f.name), ["dts02-6502-signer"]);
  assert.equal(d.active, 3);
  assert.equal(d.sample, false);
  // live: the fresh one shows
  const live = days().day("2026-10-28", new Date(NOW).toISOString());
  assert.equal(live.totalEvents, 2);
  assert.deepEqual(live.lines.map((l) => l.id), ["too-fresh"]);
});

test("the API: /v1/days and /v1/day/:date, a 400 on a bad date, live only with the key", async () => {
  const server: Server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, now: () => NOW });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const list = await fetch(base + "/v1/days");
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { days: unknown[] }).days.length, 3);
    const one = await fetch(base + "/v1/day/2026-10-27");
    assert.equal(one.status, 200);
    const body = (await one.json()) as Record<string, unknown>;
    for (const k of ["day", "asOf", "events", "truncated", "totalEvents", "lines", "catches", "top", "groups", "hours", "fresh", "active", "sample"]) assert.ok(k in body, `has ${k}`);
    assert.equal((await fetch(base + "/v1/day/2026-13-01")).status, 400);
    assert.equal((await fetch(base + "/v1/day/yesterday")).status, 400);
    assert.equal((await fetch(base + "/v1/day/2026-10-28?delay=0")).status, 401);
  } finally {
    server.close();
  }
});
