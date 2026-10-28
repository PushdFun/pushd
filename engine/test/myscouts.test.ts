// Holders' own scouts: plain words to a rule (a pretend model, and the template parser), the checks on a rule, the
// match with no model call, tiers by holding, rate limits, the inbox, push for hits, the model's short note within
// the cap, and the routes behind a holder's session.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/api.ts";
import { insertItem, openDb, setExtra, toFeedItem } from "../src/db.ts";
import { Budget } from "../src/scouts/budget.ts";
import { MyScoutError, MyScouts } from "../src/scouts/myscouts.ts";
import { checkRule, match, readable, RuleError, templateRule } from "../src/scouts/rules.ts";
import { Scouts } from "../src/scouts/scouts.ts";
import { tokenServices } from "../src/token/local.ts";
import { WEI } from "../src/token/config.ts";
import type { WatchEntry } from "../src/types.ts";
import { FakeModel, line, scoutConfig } from "./scout-helpers.ts";
import { FakeChain, POT, SPLITTER, tokens } from "./token-helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const A = (handle: string, org: string, group: WatchEntry["group"], type: WatchEntry["type"] = "user"): WatchEntry => ({ handle, name: handle.toUpperCase(), org, group, type, source: "t" });
const accounts: WatchEntry[] = [A("aeyakovenko", "Solana", "chain"), A("garious", "Solana", "chain"), A("solana-labs", "Solana", "chain", "org"), A("vbuterin", "Ethereum", "chain"), A("karpathy", "nanoGPT", "ai"), A("pump-fun", "Pump.fun", "launchpads", "org")];
const ADDR = "0xabc0000000000000000000000000000000000abc";

function world(o: { model?: FakeModel | null; holder?: boolean; env?: Record<string, string> } = {}) {
  const db = openDb(":memory:");
  const config = scoutConfig({ PUSHD_MY_SCOUT_TIERS: "100:1,500:2", ...o.env }, o.model ? "k" : null);
  const budget = new Budget(db, config, () => NOW);
  const pushed: { address: string; payload: string }[] = [];
  const my = new MyScouts({
    db,
    accounts,
    config,
    provider: o.model ?? null,
    budget,
    toItem: (it) => toFeedItem(it, undefined),
    push: { on: true, sendTo: async (address, payload) => (pushed.push({ address, payload }), 1) },
    isHolder: async () => o.holder !== false,
    now: () => NOW,
  });
  return { db, my, pushed };
}

const RULE = { builders: ["aeyakovenko", "garious"], camps: [], kinds: ["repo"], keywords: ["tokens", "payments"], heatFloor: 0 };

describe("rules", () => {
  test("checked field by field; unknown builders refused (or dropped from a model's draft); never a rule that matches all", () => {
    assert.deepEqual(checkRule({ ...RULE, builders: ["@AEYAKOVENKO", "garious", "garious"] }, accounts).rule.builders, ["aeyakovenko", "garious"]);
    assert.throws(() => checkRule({ ...RULE, builders: ["sama"] }, accounts), (e: unknown) => e instanceof RuleError && /not on the watchlist/.test(e.message));
    assert.deepEqual(checkRule({ ...RULE, builders: ["sama", "garious"] }, accounts, { dropUnknown: true }).dropped, ["sama"]);
    assert.throws(() => checkRule({ ...RULE, camps: ["moon"] }, accounts), /not a camp/);
    assert.throws(() => checkRule({ ...RULE, kinds: ["tweet"] }, accounts), /not a kind/);
    assert.throws(() => checkRule({ ...RULE, keywords: ["<script>"] }, accounts), /keyword/);
    assert.throws(() => checkRule({ ...RULE, heatFloor: 11 }, accounts), /heat floor/);
    assert.throws(() => checkRule({}, accounts), /every line/);
    assert.throws(() => checkRule("x", accounts), /not valid/);
  });

  test("in plain words", () => {
    assert.equal(readable(checkRule(RULE, accounts).rule), 'Tell me about new repos from aeyakovenko or garious that mention "tokens" or "payments".');
    assert.equal(readable(checkRule({ camps: ["ai"], kinds: ["release", "repo"], heatFloor: 6 }, accounts).rule), "Tell me about releases or new repos from anyone in AI agent projects at heat 6 or more.");
  });

  test("the match: who, kind, words (with plurals) and the heat floor; it says which parts matched", () => {
    const r = checkRule({ ...RULE, heatFloor: 3 }, accounts).rule;
    const base = { handle: "aeyakovenko", group: "chain" as const, kind: "repo" as const, score: 5, text: "token-pay: a token payment rail" };
    const m = match(r, base);
    assert.ok(m.hit);
    assert.deepEqual(m.parts, ["aeyakovenko is on your list", "it is a new repo", 'it mentions "tokens"', "its heat is 5, your floor is 3"]);
    assert.equal(match(r, { ...base, handle: "vbuterin" }).hit, false);
    assert.equal(match(r, { ...base, kind: "push" }).hit, false);
    assert.equal(match(r, { ...base, text: "a tokenizer for llms" }).hit, false, "a word, not part of another word");
    assert.equal(match(r, { ...base, score: 2 }).hit, false);
    assert.ok(match(checkRule({ camps: ["chain"] }, accounts).rule, { ...base, handle: "vbuterin" }).hit);
  });

  test("the template parser reads the owner's example", () => {
    const t = templateRule("tell me when a Solana founder creates a repo about tokens or payments", accounts);
    assert.deepEqual(t.rule.builders, ["aeyakovenko", "garious"], "Solana people, not the org");
    assert.deepEqual(t.rule.kinds, ["repo"]);
    assert.deepEqual(t.rule.keywords, ["tokens", "payments"]);
    assert.equal(t.rule.heatFloor, 0);
    assert.equal(templateRule("very hot releases from ai labs", accounts).rule.heatFloor, 8);
    assert.deepEqual(templateRule("very hot releases from ai labs", accounts).rule.camps, ["ai"]);
  });
});

describe("my scouts", () => {
  test("tiers by holding; saving within the tier, edits and deletes only of your own", () => {
    const w = world();
    assert.equal(w.my.allowed(null), 0);
    assert.equal(w.my.allowed(99n * WEI), 0);
    assert.equal(w.my.allowed(100n * WEI), 1);
    assert.equal(w.my.allowed(500n * WEI), 2);
    assert.throws(() => w.my.save(ADDR, 50n * WEI, { rule: RULE }), (e: unknown) => e instanceof MyScoutError && e.status === 403);
    const s = w.my.save(ADDR, 100n * WEI, { name: "Solana money", text: "x", rule: RULE });
    assert.equal(s.name, "Solana money");
    assert.match(s.readable, /^Tell me about new repos/);
    assert.throws(() => w.my.save(ADDR, 100n * WEI, { rule: RULE }), /allows 1 scout/);
    const e = w.my.save(ADDR, 100n * WEI, { id: s.id, name: "Renamed", rule: { ...RULE, heatFloor: 4 } });
    assert.equal(e.name, "Renamed");
    assert.equal(e.rule.heatFloor, 4);
    assert.throws(() => w.my.save("0xdef0000000000000000000000000000000000def", 500n * WEI, { id: s.id, rule: RULE }), /No such scout/);
    assert.throws(() => w.my.remove("0xdef0000000000000000000000000000000000def", s.id), /No such scout/);
    assert.deepEqual(w.my.remove(ADDR, s.id), { ok: true });
    assert.equal(w.my.list(ADDR).length, 0);
  });

  test("drafts: the template parser without a model, a model's draft checked, and a rate limit", async () => {
    const t = world({ env: { PUSHD_MY_SCOUT_DRAFTS_PER_HOUR: "2" } });
    const d = await t.my.draft(ADDR, "tell me when a Solana founder creates a repo about tokens or payments");
    assert.equal(d.source, "template");
    assert.deepEqual(d.rule.builders, ["aeyakovenko", "garious"]);
    await t.my.draft(ADDR, "releases from ai labs");
    await assert.rejects(t.my.draft(ADDR, "one more"), (e: unknown) => e instanceof MyScoutError && e.status === 429);
    await assert.rejects(t.my.draft(ADDR, "x"), /few words/);

    const model = new FakeModel(() => JSON.stringify({ builders: ["aeyakovenko", "garious", "sama"], camps: [], kinds: ["repo"], keywords: ["token", "payments"], heat_floor: 0, unsupported: "" }));
    const m = world({ model });
    const md = await m.my.draft(ADDR, "tell me when a Solana founder creates a repo about tokens or payments");
    assert.equal(md.source, "model");
    assert.deepEqual(md.rule.builders, ["aeyakovenko", "garious"]);
    assert.deepEqual(md.notes, ["Not on the watchlist, left out: sama."]);
    assert.match(model.requests[0].user, /aeyakovenko \| AEYAKOVENKO \| Solana \| chain \| person/);
    assert.match(model.requests[0].user, /<<<UNTRUSTED_/);

    const junk = world({ model: new FakeModel(() => "nope") });
    assert.equal((await junk.my.draft(ADDR, "solana founder repos about tokens")).source, "template", "a bad answer falls back to the parser");
  });

  test("a new line is matched with no model call; a hit lands in the inbox once and goes out as push", async () => {
    const model = new FakeModel(() => "Matched because it is a new Solana repo about token payments.");
    const w = world({ model });
    const s = w.my.save(ADDR, 100n * WEI, { name: "Solana money", rule: RULE });
    setExtra(w.db, "readme:aeyakovenko/pay-rail", 200, "A rail for token payments.");
    const hit = line(NOW, { id: "pay-rail", score: 6, heat: "high" });
    insertItem(w.db, hit);
    insertItem(w.db, line(NOW, { id: "other", handle: "vbuterin" }));
    insertItem(w.db, line(NOW, { id: "old-backfill", backfill: true }));
    assert.equal(await w.my.tick(), 1);
    assert.equal(model.requests.length, 1, "only the short note, after the match");
    const hits = w.my.hits(ADDR);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].item.id, "pay-rail");
    assert.equal(hits[0].scoutName, "Solana money");
    assert.equal(hits[0].why, 'Matched: aeyakovenko is on your list, it is a new repo and it mentions "tokens".');
    assert.equal(hits[0].modelWhy, "Matched because it is a new Solana repo about token payments.");
    assert.equal(w.pushed.length, 1);
    assert.match(JSON.parse(w.pushed[0].payload).title, /^Solana money: aeyakovenko \/ pay-rail$/);
    assert.equal(await w.my.matchItem(hit), 0, "once per scout and line");
    assert.equal(w.my.hits(ADDR, { after: hits[0].n }).length, 0);
    assert.equal(w.my.list(ADDR)[0].hits, 1);
    void s;
  });

  test("a wallet that no longer holds gets no hits; the preview shows recent matches with no model", async () => {
    const w = world({ holder: false });
    w.my.save(ADDR, 100n * WEI, { rule: RULE });
    const it = line(NOW, { id: "token-thing" });
    insertItem(w.db, it);
    assert.equal(await w.my.matchItem(it), 0);
    const p = w.my.preview(RULE, new Date(NOW).toISOString());
    assert.deepEqual(p.items.map((x) => x.item.id), ["token-thing"]);
    assert.throws(() => w.my.preview({ builders: ["sama"] }, new Date(NOW).toISOString()), (e: unknown) => e instanceof MyScoutError && e.status === 400);
  });
});

describe("my scouts through the API", () => {
  test("a holder's session, the holding check, draft, save, inbox; nobody else gets in", async () => {
    const chain = new FakeChain();
    chain.launch();
    const db = openDb(":memory:");
    const me = privateKeyToAccount(generatePrivateKey());
    chain.bal.set(me.address.toLowerCase(), tokens(2_000_000));
    const token = tokenServices({ db, handles: accounts.map((a) => a.handle), env: { PUSHD_BURN_POT_ADDRESS: POT, PUSHD_SPLITTER_ADDRESS: SPLITTER, PUSHD_BURN_POT_BLOCK: "1000" }, reader: chain });
    const config = scoutConfig({}, null);
    const scouts = new Scouts({ db, accounts, config, provider: null, gh: null });
    const server = createApi({
      db,
      accounts,
      publicDelayMinutes: 5,
      liveKey: null,
      token,
      scouts,
      myScouts: (toItem) => new MyScouts({ db, accounts, config, provider: null, budget: scouts.budget, toItem, push: null, isHolder: async (a) => (await token.holders.status(a)).holder }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const call = (path: string, init: { method?: string; body?: unknown; session?: string } = {}) =>
        fetch(base + path, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.session ? { authorization: `Bearer ${init.session}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
      assert.equal((await call("/v1/holders/scouts")).status, 401);
      const c = (await (await call("/v1/holders/challenge", { method: "POST", body: { address: me.address } })).json()) as { message: string; nonce: string };
      const s = (await (await call("/v1/holders/session", { method: "POST", body: { address: me.address, nonce: c.nonce, signature: await me.signMessage({ message: c.message }) } })).json()) as { session: string };
      const list = (await (await call("/v1/holders/scouts", { session: s.session })).json()) as { allowed: number; scouts: unknown[]; mode: string };
      assert.equal(list.allowed, 1, "2,000,000 $PUSHD: the first tier");
      assert.equal(list.mode, "template");
      const d = (await (await call("/v1/holders/scouts/draft", { method: "POST", session: s.session, body: { text: "Solana founder repos about tokens" } })).json()) as { rule: unknown; source: string };
      assert.equal(d.source, "template");
      const saved = await call("/v1/holders/scouts", { method: "POST", session: s.session, body: { name: "Mine", rule: d.rule } });
      assert.equal(saved.status, 200);
      const id = ((await saved.json()) as { scout: { id: string } }).scout.id;
      assert.equal((await call("/v1/holders/scouts", { method: "POST", session: s.session, body: { rule: { builders: ["nobody-at-all"] } } })).status, 400);
      assert.equal((await call("/v1/holders/scouts/hits", { session: s.session })).status, 200);
      chain.bal.set(me.address.toLowerCase(), 0n);
      db.prepare("DELETE FROM holder_balances").run();
      assert.equal((await call("/v1/holders/scouts", { session: s.session })).status, 403, "sold: the scouts close");
      chain.bal.set(me.address.toLowerCase(), tokens(2_000_000));
      db.prepare("DELETE FROM holder_balances").run();
      assert.equal((await call(`/v1/holders/scouts/${id}`, { method: "DELETE", session: s.session })).status, 200);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
