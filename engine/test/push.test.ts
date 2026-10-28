// Web push for holders: off without keys, the subscription check, the matching rule (the open site's), the balance
// check, the hourly cap, a gone subscription dropped, backfill never alerted, and the API routes with a real sign-in.
// A fake sender stands in for the push services; nothing calls a network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import webpush from "web-push";
import { createApi } from "../src/api.ts";
import { insertItem, openDb, type StoredItem } from "../src/db.ts";
import { Push, payloadFor, pushConfigFromEnv, readSub, wants, type PushSender } from "../src/push.ts";
import { DEFAULT_PREFS, HolderError, type HolderPrefs } from "../src/token/holders.ts";
import { tokenServices } from "../src/token/local.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";
import { FakeChain, POT, SPLITTER, tokens } from "./token-helpers.ts";

const keys = webpush.generateVAPIDKeys();
const CONFIG = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "https://pushd.fun" };
const P256 = "B" + "A".repeat(86);
const AUTH = "abcdefghijklmnopqrstuv";
const sub = (n: number) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: P256, auth: AUTH } });

function line(p: Partial<StoredItem> & { id: string }): StoredItem {
  const now = new Date(Date.now() - 3_600_000).toISOString();
  return { key: `k:${p.id}`, handle: "aeyakovenko", group: "chain", kind: "repo", repo: p.id, summary: "A thing.", summarySource: "fallback", heat: "high", score: 7, signals: [], githubAt: now, seenAt: now, shownAt: now, url: null, backfill: false, ...p };
}

function rig(o: { prefs?: Partial<HolderPrefs>; holder?: boolean; status?: number; perHour?: number; config?: typeof CONFIG | null } = {}) {
  const db = openDb(":memory:");
  const sent: { endpoint: string; payload: string; urgent: boolean }[] = [];
  const sender: PushSender = async (s, payload, x) => {
    sent.push({ endpoint: s.endpoint, payload, urgent: x.urgent });
    return { status: o.status ?? 201 };
  };
  const prefs = { ...DEFAULT_PREFS, ...o.prefs };
  const holders = { prefs: () => prefs, status: async () => ({ holder: o.holder ?? true }) };
  let t = Date.now();
  const push = new Push({ db, config: o.config === undefined ? CONFIG : o.config, holders, sender, perHour: o.perHour, now: () => ++t });
  return { db, push, sent };
}

describe("web push", () => {
  test("off without keys: no key, no subscribing, nothing sent", async () => {
    assert.equal(pushConfigFromEnv({}), null);
    assert.equal(pushConfigFromEnv({ PUSHD_VAPID_PUBLIC_KEY: "short", PUSHD_VAPID_PRIVATE_KEY: "x" }), null);
    assert.deepEqual(pushConfigFromEnv({ PUSHD_VAPID_PUBLIC_KEY: keys.publicKey, PUSHD_VAPID_PRIVATE_KEY: keys.privateKey }), CONFIG);
    const { push, sent } = rig({ config: null });
    assert.equal(push.on, false);
    assert.throws(() => push.key(), (e: unknown) => e instanceof HolderError && e.status === 409 && /not switched on yet/.test(e.message));
    assert.throws(() => push.subscribe("0xabc", sub(1)), HolderError);
    assert.equal(await push.deliver(line({ id: "a" })), 0);
    assert.equal(sent.length, 0);
    assert.equal(typeof push.start(), "function");
  });

  test("a subscription must be an https endpoint with two proper keys", () => {
    assert.deepEqual(readSub(sub(1)), sub(1));
    for (const bad of [null, {}, { ...sub(1), endpoint: "http://push.example.com/x" }, { ...sub(1), endpoint: "https://u:p@push.example.com/x" }, { endpoint: sub(1).endpoint, keys: { p256dh: "short", auth: AUTH } }, { ...sub(1), endpoint: "https://x/" + "a".repeat(1100) }])
      assert.throws(() => readSub(bad), HolderError);
  });

  test("the rule: the alert heat, muted builders, only my list", () => {
    const it = line({ id: "a", heat: "high" });
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "high" }, it), true);
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "veryHigh" }, it), false);
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "off" }, it), false);
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "low", mute: ["aeyakovenko"] }, it), false);
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "low", alertMine: true }, it), false);
    assert.equal(wants({ ...DEFAULT_PREFS, alertHeat: "low", alertMine: true, follow: ["aeyakovenko"] }, it), true);
    const p = JSON.parse(payloadFor({ ...it, kind: "release", version: "v2.0", heat: "veryHigh" }));
    assert.deepEqual(p, { id: "a", title: "aeyakovenko released a v2.0", body: "Very high heat. A thing.", url: "/feed/a", tag: "pushd-a" });
  });

  test("sends to every device of a holder who wants it, urgent for hot lines; at most five devices", async () => {
    const { push, sent } = rig();
    for (let i = 1; i <= 7; i++) push.subscribe("0xAbC", sub(i));
    assert.equal(push.devices("0xabc"), 5);
    assert.equal(await push.deliver(line({ id: "a" })), 5);
    assert.ok(sent.every((s) => s.urgent));
    assert.match(sent[0].payload, /"tag":"pushd-a"/);
    push.unsubscribe("0xabc", sub(7).endpoint);
    assert.equal(push.devices("0xabc"), 4);
    push.unsubscribe("0xabc");
    assert.equal(push.devices("0xabc"), 0);
  });

  test("nothing for a wallet that no longer holds, or a line under the alert heat", async () => {
    const sold = rig({ holder: false });
    sold.push.subscribe("0xabc", sub(1));
    assert.equal(await sold.push.deliver(line({ id: "a" })), 0);
    const cool = rig({ prefs: { alertHeat: "veryHigh" } });
    cool.push.subscribe("0xabc", sub(1));
    assert.equal(await cool.push.deliver(line({ id: "a", heat: "high" })), 0);
  });

  test("the hourly cap holds; a gone subscription (410) is dropped", async () => {
    const capped = rig({ perHour: 2 });
    capped.push.subscribe("0xabc", sub(1));
    for (const id of ["a", "b", "c", "d"]) await capped.push.deliver(line({ id }));
    assert.equal(capped.sent.length, 2);
    const gone = rig({ status: 410 });
    gone.push.subscribe("0xabc", sub(1));
    assert.equal(await gone.push.deliver(line({ id: "a" })), 0);
    assert.equal(gone.push.devices("0xabc"), 0);
  });

  test("following new lines: each once, in order; a backfill line is never an alert", async () => {
    const { db, push, sent } = rig();
    push.subscribe("0xabc", sub(1));
    push.from(0);
    insertItem(db, line({ id: "one" }));
    insertItem(db, line({ id: "old", backfill: true }));
    insertItem(db, line({ id: "two" }));
    assert.equal(await push.tick(), 2);
    assert.equal(await push.tick(), 0);
    assert.deepEqual(sent.map((s) => JSON.parse(s.payload).id), ["one", "two"]);
  });

  test("the API: the key, subscribing with a holder's session, off without keys", async () => {
    const accounts: WatchEntry[] = [toly, someOrg];
    const db = openDb(":memory:");
    const chain = new FakeChain();
    chain.launch();
    const holder = privateKeyToAccount(generatePrivateKey());
    chain.bal.set(holder.address.toLowerCase(), tokens(250_000));
    const env = { PUSHD_BURN_POT_ADDRESS: POT, PUSHD_SPLITTER_ADDRESS: SPLITTER, PUSHD_HOLDER_MIN: "100000" };
    const token = tokenServices({ db, handles: accounts.map((a) => a.handle), env, reader: chain });
    const push = new Push({ db, config: CONFIG, holders: token.holders, sender: async () => ({ status: 201 }) });
    const on: Server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, token, push });
    const off: Server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, token });
    for (const s of [on, off]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = (s: Server, p: string) => `http://127.0.0.1:${(s.address() as AddressInfo).port}${p}`;
    const call = (s: Server, p: string, method = "GET", body?: unknown, bearer?: string) =>
      fetch(url(s, p), { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      assert.deepEqual(await (await call(on, "/v1/holders/push/key")).json(), { key: keys.publicKey });
      assert.equal((await call(off, "/v1/holders/push/key")).status, 409);
      const c = (await (await call(on, "/v1/holders/challenge", "POST", { address: holder.address })).json()) as { nonce: string; message: string };
      const { session } = (await (await call(on, "/v1/holders/session", "POST", { address: holder.address, nonce: c.nonce, signature: await holder.signMessage({ message: c.message }) })).json()) as { session: string };
      assert.equal((await call(on, "/v1/holders/push", "PUT", sub(1))).status, 401, "needs a session");
      assert.equal((await call(on, "/v1/holders/push", "PUT", { endpoint: "nope" }, session)).status, 400);
      const ok = await call(on, "/v1/holders/push", "PUT", sub(1), session);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, devices: 1 });
      assert.equal(push.devices(holder.address), 1);
      assert.equal((await call(off, "/v1/holders/push", "PUT", sub(1), session)).status, 409);
      assert.equal((await call(on, "/v1/holders/push", "DELETE", {}, session)).status, 200);
      assert.equal(push.devices(holder.address), 0);
    } finally {
      for (const s of [on, off]) {
        s.closeAllConnections();
        s.close();
      }
    }
  });
});
