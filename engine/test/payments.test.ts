// Pay per call (HTTP 402, "pushd-burn" v1) against a pretend chain: real signatures from throwaway keys, every check
// on its own, one hash for one call (also when two requests race), a hash given back once after a failed serve,
// the closed mode before launch, and the totals the public counters read. Nothing calls a network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb } from "../src/db.ts";
import { ethString, PaymentError, Payments, payMessage, type ChainTx, type PaymentChain } from "../src/agent/payments.ts";
import { POT } from "./token-helpers.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const PRICE = 20_000_000_000_000n; // 0.00002 ETH
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

class MockChain implements PaymentChain {
  txs = new Map<string, ChainTx>();
  calls = 0;
  down = false;
  async tx(h: string) {
    this.calls++;
    if (this.down) throw new Error("fetch failed");
    return this.txs.get(h.toLowerCase()) ?? null;
  }
  put(t: Partial<ChainTx> & { hash: string; from: string }) {
    this.txs.set(t.hash.toLowerCase(), { to: POT, value: PRICE, chainId: 4663, blockNumber: 100, status: "success", timestamp: NOW - 60_000, ...t });
  }
}

function world(o: { payTo?: string | null; switchOn?: boolean } = {}) {
  const db = openDb(":memory:");
  const chain = new MockChain();
  let t = NOW;
  const pay = new Payments({ db, chain, payTo: o.payTo === undefined ? POT : o.payTo, switchOn: o.switchOn ?? true, maxAgeMs: 30 * 60_000, now: () => t });
  return { db, chain, pay, tick: (ms: number) => (t += ms) };
}

const payer = () => privateKeyToAccount(generatePrivateKey());
const proofFor = async (w: ReturnType<typeof payer>, tx: string) => ({ tx, signature: await w.signMessage({ message: payMessage(tx) }) });

const fails = async (p: Promise<unknown>, status: number, code: string) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof PaymentError, String(e));
    assert.equal(e.status, status, e.message);
    assert.equal(e.code, code, e.message);
    return true;
  });

describe("the 402 body", () => {
  test("price in ETH, pay-to (the burn pot), chain id 4663, how to sign and retry", () => {
    const { pay } = world();
    const b = pay.required("/v1/agent/live", "pushd_live", PRICE);
    assert.equal(b.scheme, "pushd-burn");
    assert.equal(b.version, 1);
    assert.equal(b.chainId, 4663);
    assert.equal(b.payTo, POT);
    assert.equal(b.priceWei, "20000000000000");
    assert.equal(b.priceEth, "0.00002");
    assert.equal(b.asset, "ETH");
    assert.match(b.sign, /PUSHD payment <tx hash in lower case>/);
    assert.match(b.note, /burn pot, which buys \$PUSHD and burns it/);
    assert.equal(ethString(1_000_000_000_000_000_000n), "1");
    assert.equal(ethString(300_000_000_000_000n), "0.0003");
  });

  test("closed before launch: no burn pot, or switched off", async () => {
    const w = world({ payTo: null });
    assert.equal(w.pay.open, false);
    const me = payer();
    await fails(w.pay.verifyAndClaim(await proofFor(me, hash(1)), "pushd_live", PRICE), 409, "closed");
    assert.equal(world({ switchOn: false }).pay.open, false);
    assert.equal(w.chain.calls, 0);
  });
});

describe("verifying a payment", () => {
  test("a good payment passes once; the same hash again is refused, and so is a race of two", async () => {
    const w = world();
    const me = payer();
    w.chain.put({ hash: hash(1), from: me.address });
    const p = await proofFor(me, hash(1));
    const v = await w.pay.verifyAndClaim(p, "pushd_live", PRICE);
    assert.deepEqual(v, { tx: hash(1), wallet: me.address.toLowerCase(), valueWei: PRICE, block: 100 });
    w.pay.served(v.tx);
    await fails(w.pay.verifyAndClaim(p, "pushd_live", PRICE), 409, "used");
    const before = w.chain.calls;
    await fails(w.pay.verifyAndClaim(p, "pushd_live", PRICE), 409, "used");
    assert.equal(w.chain.calls, before, "a used hash is refused before the chain is asked");

    w.chain.put({ hash: hash(2), from: me.address });
    const p2 = await proofFor(me, hash(2));
    const both = await Promise.allSettled([w.pay.verifyAndClaim(p2, "pushd_live", PRICE), w.pay.verifyAndClaim(p2, "pushd_live", PRICE)]);
    assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "only one of two racing requests gets the call");
    assert.equal((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "used");
  });

  test("every check on its own", async () => {
    const w = world();
    const me = payer();
    const other = payer();
    const cases: [number, Partial<ChainTx>, number, string][] = [
      [10, { to: "0x000000000000000000000000000000000000dEaD" }, 402, "wrong_to"],
      [11, { to: null }, 402, "wrong_to"],
      [12, { value: PRICE - 1n }, 402, "too_little"],
      [13, { status: "reverted" }, 402, "reverted"],
      [14, { status: null, blockNumber: null }, 402, "pending"],
      [15, { chainId: 1 }, 402, "wrong_chain"],
      [16, { timestamp: NOW - 31 * 60_000 }, 402, "too_old"],
      [17, { timestamp: NOW + 10 * 60_000 }, 402, "bad_time"],
      [18, { from: other.address }, 402, "wrong_signer"],
      [19, { timestamp: null }, 503, "chain_silent"],
    ];
    for (const [n, patch, status, code] of cases) {
      w.chain.put({ hash: hash(n), from: me.address, ...patch });
      await fails(w.pay.verifyAndClaim(await proofFor(me, hash(n)), "pushd_live", PRICE), status, code);
    }
    // unknown on the chain, and a signature over another hash
    await fails(w.pay.verifyAndClaim(await proofFor(me, hash(20)), "pushd_live", PRICE), 402, "not_found");
    w.chain.put({ hash: hash(21), from: me.address });
    await fails(w.pay.verifyAndClaim({ tx: hash(21), signature: (await proofFor(me, hash(22))).signature }, "pushd_live", PRICE), 402, "wrong_signer");
    // more than the price is fine
    w.chain.put({ hash: hash(23), from: me.address, value: PRICE * 10n });
    assert.equal((await w.pay.verifyAndClaim(await proofFor(me, hash(23)), "pushd_live", PRICE)).valueWei, PRICE * 10n);
    // a failed check never claims the hash: fixed on the chain side (now mined), it passes
    w.chain.put({ hash: hash(14), from: me.address });
    assert.ok(await w.pay.verifyAndClaim(await proofFor(me, hash(14)), "pushd_live", PRICE));
    // a silent chain
    w.chain.down = true;
    w.chain.put({ hash: hash(24), from: me.address });
    await fails(w.pay.verifyAndClaim(await proofFor(me, hash(24)), "pushd_live", PRICE), 503, "chain_silent");
  });

  test("bad shapes are refused before anything is read", () => {
    assert.equal(Payments.proofFrom(undefined, undefined), null);
    assert.throws(() => Payments.proofFrom("0x12", "0x" + "a".repeat(130)), (e: unknown) => e instanceof PaymentError && e.code === "bad_tx");
    assert.throws(() => Payments.proofFrom(hash(1), "nope"), (e: unknown) => e instanceof PaymentError && e.code === "bad_signature");
    assert.throws(() => Payments.proofFrom(hash(1), undefined), (e: unknown) => e instanceof PaymentError && e.code === "bad_signature");
    assert.equal(Payments.proofFrom(hash(1).toUpperCase().replace("0X", "0x"), "0x" + "a".repeat(130))!.tx, hash(1), "the hash in lower case");
  });

  test("a failed serve gives the hash back once; a second failure keeps it spent", async () => {
    const w = world();
    const me = payer();
    w.chain.put({ hash: hash(30), from: me.address });
    const p = await proofFor(me, hash(30));
    await w.pay.verifyAndClaim(p, "pushd_deep_read", PRICE);
    w.pay.giveBack(hash(30));
    await w.pay.verifyAndClaim(p, "pushd_deep_read", PRICE);
    w.pay.giveBack(hash(30));
    await fails(w.pay.verifyAndClaim(p, "pushd_deep_read", PRICE), 409, "used");
  });

  test("the totals: every verified payment, its ETH and wallets; paid calls an hour per wallet", async () => {
    const w = world();
    const a = payer();
    const b = payer();
    w.chain.put({ hash: hash(40), from: a.address, value: PRICE });
    w.chain.put({ hash: hash(41), from: a.address, value: PRICE * 15n });
    w.chain.put({ hash: hash(42), from: b.address, value: PRICE });
    for (const [n, who] of [[40, a], [41, a], [42, b]] as const) w.pay.served((await w.pay.verifyAndClaim(await proofFor(who, hash(n)), "pushd_live", PRICE)).tx);
    const t = w.pay.totals();
    assert.equal(t.payments, 3);
    assert.equal(t.wallets, 2);
    assert.equal(t.wei, (PRICE * 17n).toString());
    assert.equal(t.eth, "0.00034");
    assert.equal(w.pay.paidInHour(a.address), 2);
    w.tick(3_600_001);
    assert.equal(w.pay.paidInHour(a.address), 0);
  });
});
