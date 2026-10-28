// Holder sign-in: the signed message (EIP-191 over a Sign-In With Ethereum text), its nonce and expiry, the balance
// threshold read from a pretend chain, sessions, live access through the API, and a holder's own watchlist. Real
// signatures from throwaway keys made in the test; nothing calls a network.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/api.ts";
import { insertItem, openDb, type StoredItem } from "../src/db.ts";
import { HolderError, Holders, CHALLENGE_TTL_MS } from "../src/token/holders.ts";
import { tokenServices } from "../src/token/local.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";
import { FakeChain, POT, SPLITTER, TOKEN, testConfig, tokens } from "./token-helpers.ts";

const wallet = () => privateKeyToAccount(generatePrivateKey());
const HANDLES = ["aeyakovenko", "solana-labs", "karpathy"];

function world(o: { launched?: boolean; env?: Record<string, string> } = {}) {
  const chain = new FakeChain();
  if (o.launched !== false) chain.launch();
  const db = openDb(":memory:");
  const clock = { t: Date.UTC(2026, 10, 1, 12) };
  const config = testConfig({ PUSHD_HOLDER_MIN: "100000", ...o.env });
  const holders = new Holders({ db, config, reader: chain, tokenAddress: async () => (chain.pots.token ? TOKEN : null), handles: HANDLES, now: () => clock.t });
  const signIn = async (w = wallet()) => {
    const c = await holders.challenge(w.address);
    return holders.signIn(w.address, c.nonce, await w.signMessage({ message: c.message }));
  };
  return { chain, db, clock, holders, signIn };
}

const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof HolderError, String(e));
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
};

describe("holder sign-in", () => {
  test("before launch: no message and no session, it opens at launch", async () => {
    const w = world({ launched: false });
    await rejects(w.holders.challenge(wallet().address), 409, /opens at launch/);
  });

  test("the message names the site, the wallet, Robinhood Chain, a nonce and an expiry, and says it sends nothing", async () => {
    const w = world();
    const me = wallet();
    const c = await w.holders.challenge(me.address.toLowerCase());
    assert.match(c.message, /^pushd\.fun wants you to sign in with your Ethereum account:\n/);
    assert.ok(c.message.includes(me.address), "the checksummed address");
    assert.match(c.message, /Chain ID: 4663/);
    assert.match(c.message, new RegExp(`Nonce: ${c.nonce}`));
    assert.match(c.message, /Expiration Time: 2026-11-01T12:10:00\.000Z/);
    assert.match(c.message, /sends nothing and approves nothing/);
    assert.equal(c.expiresAt - w.clock.t, CHALLENGE_TTL_MS);
    await rejects(w.holders.challenge("0x123"), 400);
  });

  test("a wallet at the threshold gets a session; one wei under is refused with no session", async () => {
    const w = world();
    const rich = wallet();
    const poor = wallet();
    w.chain.bal.set(rich.address.toLowerCase(), tokens(100_000));
    w.chain.bal.set(poor.address.toLowerCase(), tokens(100_000) - 1n);
    const ok = await w.signIn(rich);
    assert.equal(ok.status.holder, true);
    assert.equal(ok.status.balanceWei, tokens(100_000).toString());
    assert.equal(ok.status.address, rich.address.toLowerCase());
    assert.equal(w.holders.session(ok.session)?.address, rich.address.toLowerCase());
    assert.equal(await w.holders.liveAllowed(ok.session), true);
    await rejects(w.signIn(poor), 403, /less than 100,000 \$PUSHD/);
    assert.equal((w.db.prepare("SELECT count(*) AS n FROM holder_sessions").get() as { n: number }).n, 1);
    // only a hash of the session is kept
    assert.equal(w.db.prepare("SELECT 1 FROM holder_sessions WHERE id_hash = ?").get(ok.session), undefined);
  });

  test("a wallet with no $PUSHD is refused", async () => {
    const w = world();
    await rejects(w.signIn(), 403);
  });

  test("refuses a replayed nonce, an expired one, another signer, another wallet's nonce and junk", async () => {
    const w = world();
    const me = wallet();
    const other = wallet();
    w.chain.bal.set(me.address.toLowerCase(), tokens(1_000_000));
    w.chain.bal.set(other.address.toLowerCase(), tokens(1_000_000));
    const c = await w.holders.challenge(me.address);
    const sig = await me.signMessage({ message: c.message });
    await w.holders.signIn(me.address, c.nonce, sig);
    await rejects(w.holders.signIn(me.address, c.nonce, sig), 401, /already used/);

    const late = await w.holders.challenge(me.address);
    const lateSig = await me.signMessage({ message: late.message });
    w.clock.t += CHALLENGE_TTL_MS + 1;
    await rejects(w.holders.signIn(me.address, late.nonce, lateSig), 401, /expired/);

    const c2 = await w.holders.challenge(me.address);
    await rejects(w.holders.signIn(me.address, c2.nonce, await other.signMessage({ message: c2.message })), 401, /not from that wallet/);
    // a failed try spends the nonce too
    await rejects(w.holders.signIn(me.address, c2.nonce, await me.signMessage({ message: c2.message })), 401, /already used/);

    const c3 = await w.holders.challenge(me.address);
    await rejects(w.holders.signIn(other.address, c3.nonce, await other.signMessage({ message: c3.message })), 401, /not known/);
    const c4 = await w.holders.challenge(me.address);
    await rejects(w.holders.signIn(me.address, c4.nonce, "0xdeadbeef"), 401, /not valid/);
    // a signature over another text
    const c5 = await w.holders.challenge(me.address);
    await rejects(w.holders.signIn(me.address, c5.nonce, await me.signMessage({ message: "something else" })), 401);
  });

  test("the balance is read again after the cache time, so selling closes the live feed", async () => {
    const w = world({ env: { PUSHD_HOLDER_CACHE_MINUTES: "10" } });
    const me = wallet();
    w.chain.bal.set(me.address.toLowerCase(), tokens(500_000));
    const { session } = await w.signIn(me);
    w.chain.bal.set(me.address.toLowerCase(), 0n);
    const reads = w.chain.calls.balances;
    assert.equal(await w.holders.liveAllowed(session), true, "inside the cache time the last reading stands");
    assert.equal(w.chain.calls.balances, reads, "and the chain is not asked");
    w.clock.t += 10 * 60_000 + 1;
    assert.equal(await w.holders.liveAllowed(session), false);
  });

  test("a silent chain: the last reading for a while, then nothing; never a holder from a gap", async () => {
    const w = world({ env: { PUSHD_HOLDER_CACHE_MINUTES: "10" } });
    const me = wallet();
    w.chain.bal.set(me.address.toLowerCase(), tokens(500_000));
    const { session } = await w.signIn(me);
    w.chain.down = true;
    w.clock.t += 30 * 60_000;
    assert.equal(await w.holders.liveAllowed(session), true);
    w.clock.t += 31 * 60_000;
    assert.equal(await w.holders.liveAllowed(session), false);
    // and a sign-in while silent is refused, not guessed
    const fresh = wallet();
    const c = await w.holders.challenge(fresh.address);
    await rejects(w.holders.signIn(fresh.address, c.nonce, await fresh.signMessage({ message: c.message })), 503, /did not answer/);
  });

  test("sessions expire and sign out", async () => {
    const w = world({ env: { PUSHD_HOLDER_SESSION_DAYS: "7" } });
    const me = wallet();
    w.chain.bal.set(me.address.toLowerCase(), tokens(500_000));
    const a = await w.signIn(me);
    const b = await w.signIn(me);
    w.holders.signOut(a.session);
    assert.equal(w.holders.session(a.session), null);
    assert.ok(w.holders.session(b.session));
    w.clock.t += 7 * 86_400_000;
    assert.equal(w.holders.session(b.session), null);
    assert.equal(w.holders.session("not a token"), null);
  });

  test("a holder's own watchlist: handles from the shared list only, in their own case, never both followed and muted", () => {
    const w = world();
    const a = "0xabc0000000000000000000000000000000000abc";
    assert.deepEqual(w.holders.prefs(a), { follow: [], mute: [], alertHeat: "high", alertMine: false, scouts: [] });
    const p = w.holders.setPrefs(a, { follow: ["@AEYAKOVENKO", "karpathy", "karpathy"], mute: ["solana-labs"], alertHeat: "veryHigh", alertMine: true });
    assert.deepEqual(p, { follow: ["aeyakovenko", "karpathy"], mute: ["solana-labs"], alertHeat: "veryHigh", alertMine: true, scouts: [] });
    assert.deepEqual(w.holders.prefs(a.toUpperCase().replace("0X", "0x")), p);
    assert.throws(() => w.holders.setPrefs(a, { follow: ["somebody-else"] }), /not on the watchlist/);
    assert.throws(() => w.holders.setPrefs(a, { follow: ["karpathy"], mute: ["karpathy"] }), /both/);
    assert.throws(() => w.holders.setPrefs(a, { alertHeat: "max" }), /alert level/);
    assert.deepEqual(w.holders.prefs(a), p, "a refused save changes nothing");
    assert.deepEqual(w.holders.setPrefs(a, { alertHeat: "off" }).follow, ["aeyakovenko", "karpathy"], "fields left out stay");
  });
});

describe("holders through the API", () => {
  const accounts: WatchEntry[] = [toly, someOrg, { handle: "karpathy", name: "Andrej Karpathy", org: "nanoGPT", group: "ai", type: "user", followers: 228000, source: "t" }];
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const item = (id: string, min: number): StoredItem => ({
    id,
    key: `k:${id}`,
    handle: "aeyakovenko",
    group: "chain",
    kind: "repo",
    repo: id,
    summary: "A thing.",
    summarySource: "fallback",
    heat: "high",
    score: 7,
    signals: [],
    githubAt: ago(min + 1),
    seenAt: ago(min),
    shownAt: ago(min),
    url: null,
    backfill: false,
  });
  let server: Server, closed: Server, base: string, closedBase: string, chain: FakeChain;
  const clock = { t: Date.now() };
  const holder = wallet();
  const seller = wallet();

  before(async () => {
    const db = openDb(":memory:");
    insertItem(db, item("old-one", 30));
    insertItem(db, item("fresh-one", 1));
    chain = new FakeChain();
    chain.launch();
    chain.bal.set(holder.address.toLowerCase(), tokens(250_000));
    chain.bal.set(seller.address.toLowerCase(), tokens(250_000));
    const env = { PUSHD_BURN_POT_ADDRESS: POT, PUSHD_SPLITTER_ADDRESS: SPLITTER, PUSHD_HOLDER_CACHE_MINUTES: "1", PUSHD_HOLDER_MIN: "100000" };
    const token = tokenServices({ db, handles: accounts.map((a) => a.handle), env, reader: chain, now: () => clock.t });
    server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, token });
    closed = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  });
  after(() => {
    for (const s of [server, closed]) {
      s.closeAllConnections();
      s.close();
    }
  });

  /** The answers' bodies, loosely: every field the tests read. */
  type Body = { stage: string; token: string | null; holderMin: string; session: string; status: { holder: boolean }; error: string; prefs: { follow: string[] }; nonce: string; message: string; items: { id: string }[] };
  const json = async (r: Response | Promise<Response>) => (await (await r).json()) as Body;
  const post = (url: string, body: unknown, method = "POST", bearer?: string) =>
    fetch(url, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  const signIn = async (w: ReturnType<typeof wallet>, at = base) => {
    const c = await json(post(`${at}/v1/holders/challenge`, { address: w.address }));
    return post(`${at}/v1/holders/session`, { address: w.address, nonce: c.nonce, signature: await w.signMessage({ message: c.message }) });
  };

  test("/v1/token answers the panel; without token settings it says soon", async () => {
    const live = await json(fetch(`${base}/v1/token`));
    assert.equal(live.stage, "live");
    assert.equal(live.token, TOKEN);
    assert.equal(live.holderMin, "100000");
    const soon = await json(fetch(`${closedBase}/v1/token`));
    assert.equal(soon.stage, "soon");
    assert.equal(soon.token, null);
  });

  test("a holder's session opens the live feed; nobody else gets past the public delay", async () => {
    const r = await signIn(holder);
    assert.equal(r.status, 200);
    const { session, status } = await json(r);
    assert.equal(status.holder, true);
    const ids = async (headers: Record<string, string> = {}, q = "?delay=0") => {
      const res = await fetch(`${base}/v1/feed${q}`, { headers });
      return { status: res.status, ids: res.ok ? (await json(res)).items.map((i) => i.id) : [] };
    };
    assert.deepEqual(await ids({ authorization: `Bearer ${session}` }), { status: 200, ids: ["fresh-one", "old-one"] });
    assert.deepEqual(await ids({}, ""), { status: 200, ids: ["old-one"] });
    assert.equal((await ids({})).status, 401);
    assert.equal((await ids({ authorization: "Bearer nope-nope-nope-nope-nope-nope" })).status, 401);
    assert.equal((await fetch(`${base}/v1/feed/fresh-one?delay=0`, { headers: { authorization: `Bearer ${session}` } })).status, 200);
    assert.equal((await fetch(`${base}/v1/feed/fresh-one`)).status, 404);
    const me = await json(fetch(`${base}/v1/holders/me`, { headers: { authorization: `Bearer ${session}` } }));
    assert.equal(me.status.holder, true);
    assert.deepEqual(me.prefs.follow, []);
  });

  test("a wallet under the threshold is refused with its balance and no session", async () => {
    const r = await signIn(wallet());
    assert.equal(r.status, 403);
    const b = await json(r);
    assert.match(b.error, /less than 100,000/);
    assert.equal(b.status.holder, false);
    assert.equal(b.session, undefined);
  });

  test("prefs save through the API and are checked; sign-out ends the session", async () => {
    const { session } = await json(signIn(holder));
    const ok = await post(`${base}/v1/holders/prefs`, { follow: ["karpathy"], alertHeat: "veryHigh" }, "PUT", session);
    assert.equal(ok.status, 200);
    assert.deepEqual((await json(ok)).prefs, { follow: ["karpathy"], mute: [], alertHeat: "veryHigh", alertMine: false, scouts: [] });
    assert.equal((await post(`${base}/v1/holders/prefs`, { follow: ["nobody"] }, "PUT", session)).status, 400);
    assert.equal((await post(`${base}/v1/holders/prefs`, { follow: [] }, "PUT")).status, 401);
    assert.equal((await post(`${base}/v1/holders/session`, {}, "DELETE", session)).status, 204);
    assert.equal((await fetch(`${base}/v1/holders/me`, { headers: { authorization: `Bearer ${session}` } })).status, 401);
  });

  test("selling closes the live feed once the balance is read again", async () => {
    const { session } = await json(signIn(seller));
    const live = () => fetch(`${base}/v1/feed?delay=0`, { headers: { authorization: `Bearer ${session}` } }).then((r) => r.status);
    assert.equal(await live(), 200);
    chain.bal.set(seller.address.toLowerCase(), 0n);
    assert.equal(await live(), 200, "inside the cache time (a minute here) the last reading stands");
    clock.t += 61_000;
    assert.equal(await live(), 401);
  });

  test("with no token settings the holder routes say it opens at launch", async () => {
    const r = await post(`${closedBase}/v1/holders/challenge`, { address: holder.address });
    assert.equal(r.status, 409);
    assert.match((await json(r)).error, /opens at launch/);
  });
});
