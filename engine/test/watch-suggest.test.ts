// Holders watch any account (tiers, the server-wide cap, the Top list, unknown accounts), the watcher reading added
// accounts into their own store at a lower priority, their lines reaching the holder's inbox; and suggestions (the
// checks, the limits, the count, the private list) with the admin routes behind the admin key.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { insertItem, openDb, toFeedItem } from "../src/db.ts";
import { GitHub } from "../src/github.ts";
import { HolderWatch, parseWatchTiers, WatchError } from "../src/holderwatch.ts";
import { Budget } from "../src/scouts/budget.ts";
import { MyScouts } from "../src/scouts/myscouts.ts";
import { adminOk, SuggestError, Suggestions } from "../src/suggest.ts";
import { WEI } from "../src/token/config.ts";
import type { WatchEntry } from "../src/types.ts";
import { Watcher } from "../src/watcher.ts";
import { line, scoutConfig } from "./scout-helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const A = "0xaaa0000000000000000000000000000000000aaa";
const B = "0xbbb0000000000000000000000000000000000bbb";

function watchWorld(o: { globalMax?: number } = {}) {
  const db = openDb(":memory:");
  const known: Record<string, { login: string; type: "user" | "org"; name: string | null }> = {
    somedev: { login: "SomeDev", type: "user", name: "Some Dev" },
    otherorg: { login: "OtherOrg", type: "org", name: null },
    third: { login: "Third", type: "user", name: null },
  };
  const hw = new HolderWatch({
    db,
    config: { tiers: parseWatchTiers("100:1,500:2"), globalMax: o.globalMax ?? 10, addsPerHour: 20 },
    authenticated: true,
    inTop: (l) => l.toLowerCase() === "topproject",
    account: async (l) => known[l.toLowerCase()] ?? null,
    now: () => NOW,
  });
  return { db, hw };
}

describe("holders watch any account", () => {
  test("tiers by holding, the Top list, unknown accounts, the per-holder and the server-wide limits", async () => {
    const { hw } = watchWorld({ globalMax: 2 });
    await assert.rejects(hw.add(A, 50n * WEI, "SomeDev", "v"), (e: WatchError) => e.status === 403);
    const v = await hw.add(A, 100n * WEI, "@somedev", "v");
    assert.deepEqual(v.accounts.map((a) => a.login), ["SomeDev"], "GitHub's own spelling");
    assert.equal(v.allowed, 1);
    await assert.rejects(hw.add(A, 100n * WEI, "OtherOrg", "v"), (e: WatchError) => e.status === 403 && /allows 1/.test(e.message));
    await assert.rejects(hw.add(B, 500n * WEI, "TopProject", "v"), (e: WatchError) => e.status === 409);
    await assert.rejects(hw.add(B, 500n * WEI, "nobody-here", "v"), (e: WatchError) => e.status === 404);
    await hw.add(B, 500n * WEI, "OtherOrg", "v");
    await hw.add(B, 500n * WEI, "SomeDev", "v");
    assert.equal(hw.distinct().length, 2);
    // the server reads at most two different added accounts: a third new one waits
    const c = "0xccc0000000000000000000000000000000000ccc";
    await assert.rejects(hw.add(c, 500n * WEI, "Third", "v"), (e: WatchError) => e.status === 409);
    assert.deepEqual(hw.watchers("somedev").sort(), [A, B].sort());
    assert.deepEqual(hw.entries().map((e) => e.handle).sort(), ["OtherOrg", "SomeDev"]);
    assert.equal(hw.remove(A, 100n * WEI, "SomeDev").accounts.length, 0);
    assert.deepEqual(hw.watchers("somedev"), [B]);
  });

  test("the watcher reads an added account into its own store, and its new line reaches the holder's inbox, marked extra", async () => {
    const { db, hw } = watchWorld();
    await hw.add(A, 100n * WEI, "SomeDev", "v");
    const extrasDb = openDb(":memory:");
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      const headers = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3600), "content-type": "application/json" };
      if (url.includes("/events/public")) return new Response(JSON.stringify([]), { status: 200, headers });
      if (url.includes("/users/SomeDev/repos")) return new Response(JSON.stringify([]), { status: 200, headers });
      if (url.includes("/gists")) return new Response("[]", { status: 200, headers });
      return new Response("{}", { status: 404, headers });
    }) as typeof fetch;
    const gh = new GitHub({ db, fetchImpl: f, now: () => NOW, part: "watch" });
    const xgh = new GitHub({ db: extrasDb, spendDb: db, fetchImpl: f, now: () => NOW, part: "extra" });
    const w = new Watcher({ db, gh, accounts: [], extras: { db: extrasDb, gh: xgh, list: () => hw.entries() }, now: () => NOW });
    const res = await w.pollExtra(hw.entries()[0]);
    assert.equal(res.handle, "SomeDev");
    assert.equal((extrasDb.prepare("SELECT count(*) AS n FROM accounts WHERE handle = 'SomeDev'").get() as { n: number }).n, 1, "the schedule lives in the extras store");
    assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 0, "the public store is untouched");
    assert.ok((db.prepare("SELECT count(*) AS n FROM gh_spend WHERE part = 'extra'").get() as { n: number }).n >= 1, "booked to the extra share in the main book");

    // a new line from it (as the pipeline would store it) goes to the inbox of the holder who added it
    const it = line(NOW, { id: "new-thing", handle: "SomeDev", group: "oss", kind: "repo", repo: "new-thing", score: 6 });
    insertItem(extrasDb, it);
    const config = scoutConfig({ PUSHD_MY_SCOUT_TIERS: "100:1" }, null);
    const accounts: WatchEntry[] = [];
    const my = new MyScouts({
      db,
      accounts,
      config,
      provider: null,
      budget: new Budget(db, config, () => NOW),
      toItem: (x) => toFeedItem(x, undefined),
      push: null,
      isHolder: async () => true,
      extras: { db: extrasDb, watchers: (l) => hw.watchers(l), accountsOf: (a) => hw.accountsOf(a) },
      now: () => NOW,
    });
    // a rule of the holder's may name the added account
    my.save(A, 100n * WEI, { name: "SomeDev repos", text: "new repos from SomeDev", rule: { builders: ["somedev"], kinds: ["repo"] } });
    my.from(0, 0);
    assert.equal(await my.tick(), 2, "the watched account's hit and the rule's hit");
    const hits = my.hits(A);
    assert.deepEqual(hits.map((h) => h.scoutName).sort(), ["SomeDev repos", "Watched account"]);
    assert.ok(hits.every((h) => h.item.extra === true && h.item.id === "x:new-thing"));
    assert.equal(my.hits(B).length, 0, "only the holder who added it");
  });
});

describe("suggestions", () => {
  const world = () => new Suggestions({ db: openDb(":memory:"), inTop: (l) => l.toLowerCase() === "topproject", rankOf: (l) => (l === "AgentX" ? 140 : null), hidden: (l) => l.toLowerCase() === "hiddenorg", perHour: 3, perDay: 5, now: () => NOW });

  test("checked, counted, never added: a second suggestion of the same login is a vote", () => {
    const s = world();
    assert.throws(() => s.add({ login: "not a login", camp: "ai", why: "because it is good" }, "v"), (e: SuggestError) => e.status === 400);
    assert.throws(() => s.add({ login: "AgentX", camp: "nope", why: "because it is good" }, "v"), SuggestError);
    assert.throws(() => s.add({ login: "AgentX", camp: "ai", why: "short" }, "v"), /8 characters/);
    assert.throws(() => s.add({ login: "AgentX", camp: "ai", why: "see https://spam.example now" }, "v"), /No links/);
    assert.throws(() => s.add({ login: "TopProject", camp: "ai", why: "it ships every day" }, "v"), (e: SuggestError) => e.status === 409);
    const a = s.add({ login: "https://github.com/AgentX", camp: "ai", why: "ships agents every week — really" }, "v1");
    assert.equal(a.already, false);
    const b = s.add({ login: "agentx", camp: "ai", why: "very active repo lately" }, "v2");
    assert.equal(b.already, true);
    const list = s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
    assert.equal(list[0].why, "ships agents every week - really", "no long dashes kept");
    assert.equal(list[0].rank, 140);
    assert.equal(list[0].status, "new");
    assert.equal(s.decide(list[0].id, "approved").status, "approved");
  });

  test("the private list is taken like any other and dropped; the limits per visitor", () => {
    const s = world();
    assert.equal(s.add({ login: "HiddenOrg", camp: "ai", why: "a fine project here" }, "v").ok, true);
    assert.equal(s.list().length, 0);
    s.add({ login: "one", camp: "ai", why: "a fine project here" }, "v");
    s.add({ login: "two", camp: "ai", why: "a fine project here" }, "v");
    assert.throws(() => s.add({ login: "three", camp: "ai", why: "a fine project here" }, "v"), (e: SuggestError) => e.status === 429);
  });

  test("the admin routes: invisible without the key, the inbox and the decision with it", async () => {
    const db = openDb(":memory:");
    const suggestions = new Suggestions({ db, inTop: () => false, rankOf: () => null, hidden: () => false });
    suggestions.add({ login: "AgentX", camp: "ai", why: "a fine project here" }, "v");
    const server = createApi({ db, accounts: [], publicDelayMinutes: 5, liveKey: null, suggestions, adminKey: "s3cret-admin-key", now: () => NOW });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/v1/admin/suggestions`)).status, 404);
      assert.equal((await fetch(`${base}/v1/admin/suggestions`, { headers: { "x-pushd-admin-key": "wrong" } })).status, 404);
      const ok = await fetch(`${base}/v1/admin/suggestions`, { headers: { "x-pushd-admin-key": "s3cret-admin-key" } });
      const j = (await ok.json()) as { suggestions: { id: number; login: string }[] };
      assert.equal(j.suggestions[0].login, "AgentX");
      const d = await fetch(`${base}/v1/admin/suggestions/${j.suggestions[0].id}`, { method: "POST", headers: { "x-pushd-admin-key": "s3cret-admin-key", "content-type": "application/json" }, body: JSON.stringify({ status: "declined" }) });
      assert.equal(((await d.json()) as { suggestion: { status: string } }).suggestion.status, "declined");
      const st = await fetch(`${base}/v1/admin/status`, { headers: { "x-pushd-admin-key": "s3cret-admin-key" } });
      assert.equal(st.status, 200);
      const pub = await fetch(`${base}/v1/suggestions`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ login: "Another", camp: "oss", why: "tools people use" }) });
      assert.equal(pub.status, 200);
    } finally {
      server.close();
    }
    assert.equal(adminOk("x", null), false);
    assert.equal(adminOk(undefined, "x"), false);
  });
});
