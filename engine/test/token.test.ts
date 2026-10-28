// $PUSHD in the engine: the settings, the /v1/token panel and the keeper, on a pretend chain and an in-memory store.
// Nothing here calls a network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { scanBurns, scrub, ZERO, type PotState } from "../src/token/chain.ts";
import { isHolder, keeperStatus, toWei, tokenConfigFromEnv } from "../src/token/config.ts";
import { LOST_AFTER_MS, NotSent, memoryKeeperStore, runKeeper, type KeeperChain, type KeeperOptions } from "../src/token/keeper.ts";
import { keeperOnce } from "../src/token/local.ts";
import { TokenPanels } from "../src/token/panel.ts";
import { FakeChain, POT, TOKEN, testConfig, tokens } from "./token-helpers.ts";

const KEY = `0x${"1".repeat(64)}`;

describe("$PUSHD settings", () => {
  test("all off with nothing set: no contracts, no keeper, the public node, the default holder threshold", () => {
    const c = tokenConfigFromEnv({});
    assert.equal(c.pot, null);
    assert.equal(c.splitter, null);
    assert.equal(c.token, null);
    assert.equal(c.publicRpc, true);
    assert.equal(c.rpcUrl, "https://rpc.mainnet.chain.robinhood.com");
    assert.equal(c.holder.minWhole, "1000000");
    assert.equal(keeperStatus(c).on, false);
  });

  test("reads amounts on the digits, never through a float", () => {
    assert.equal(toWei("0.0005"), 500_000_000_000_000n);
    assert.equal(toWei("0.1"), 100_000_000_000_000_000n);
    assert.equal(toWei("1,000"), 1000n * 10n ** 18n);
    assert.equal(toWei("1e3"), null);
    assert.equal(toWei("-1"), null);
    assert.equal(tokenConfigFromEnv({ PUSHD_KEEPER_MIN_GAS_ETH: "nope" }).keeper.minGasWei, 500_000_000_000_000n);
    assert.equal(tokenConfigFromEnv({ PUSHD_HOLDER_MIN: "250,000" }).holder.minWei, tokens(250_000));
    assert.equal(tokenConfigFromEnv({ PUSHD_HOLDER_MIN: "0" }).holder.minWhole, "1000000");
  });

  test("decides holder status exactly in wei: one wei under is not enough", () => {
    const c = tokenConfigFromEnv({ PUSHD_HOLDER_MIN: "1000" });
    assert.equal(isHolder(c, tokens(1000) - 1n), false);
    assert.equal(isHolder(c, tokens(1000)), true);
    assert.equal(isHolder(c, null), false);
  });

  test("switches the keeper on only with its key and both contracts, and off with PUSHD_KEEPER=off whatever else is set", () => {
    assert.equal(keeperStatus(testConfig()).on, false);
    assert.equal(keeperStatus(testConfig({ PUSHD_KEEPER_KEY: KEY })).on, true);
    assert.equal(keeperStatus(tokenConfigFromEnv({ PUSHD_KEEPER_KEY: KEY, PUSHD_BURN_POT_ADDRESS: POT })).on, false);
    const off = keeperStatus(testConfig({ PUSHD_KEEPER_KEY: KEY, PUSHD_KEEPER: "off" }));
    assert.equal(off.on, false);
    assert.match(off.missing[0], /Switched off/);
    // the key itself never appears in what the settings say
    assert.doesNotMatch(JSON.stringify(testConfig({ PUSHD_KEEPER_KEY: KEY }), (_k, v) => (typeof v === "bigint" ? v.toString() : v)), new RegExp(KEY.slice(2)));
  });

  test("scrubs node addresses and anything key-like out of messages", () => {
    const m = scrub(`failed at https://rpc.example/v2/abc with ${KEY}`);
    assert.doesNotMatch(m, /rpc\.example/);
    assert.doesNotMatch(m, /1{20}/);
  });
});

describe("the /token panel", () => {
  const panels = (chain: FakeChain, env: Record<string, string> = {}, now = () => Date.UTC(2026, 9, 22)) => {
    const db = openDb(":memory:");
    return { db, p: new TokenPanels({ config: testConfig(env), reader: chain, db, now }) };
  };

  test("before the contracts exist: soon, and nothing is read", async () => {
    const chain = new FakeChain();
    const p = new TokenPanels({ config: tokenConfigFromEnv({}), reader: chain, db: openDb(":memory:") });
    const panel = await p.panel();
    assert.equal(panel.stage, "soon");
    assert.equal(panel.token, null);
    assert.equal(panel.supply, null);
    assert.deepEqual(chain.calls, {});
  });

  test("deployed but not launched: the addresses and no numbers, never zeros", async () => {
    const { p } = panels(new FakeChain());
    const panel = await p.panel();
    assert.equal(panel.stage, "deployed");
    assert.equal(panel.pot, POT);
    assert.equal(panel.token, null);
    assert.equal(panel.burned, null);
    assert.equal(panel.next, null);
  });

  test("live: supply now and at launch, the totals, the latest burns from the logs, the next burn, and nothing about shares", async () => {
    const chain = new FakeChain();
    chain.launch();
    chain.addBurn(1, 1500, tokens(2_000_000), 10_000_000_000_000_000n);
    chain.addBurn(2, 250_000, tokens(1_500_000), 8_000_000_000_000_000n);
    chain.pots = { ...chain.pots, waitingEth: 3_000_000_000_000_000n, waitingTokens: tokens(10), nextAt: Date.UTC(2026, 9, 22, 0, 30), ready: false };
    const { p } = panels(chain);
    const panel = await p.panel();
    assert.equal(panel.stage, "live");
    assert.equal(panel.token, TOKEN);
    assert.equal(panel.count, 2);
    assert.equal(panel.burned, tokens(3_500_000).toString());
    assert.equal(panel.ethSpent, "18000000000000000");
    assert.equal(panel.supply, (tokens(1_000_000_000) - tokens(3_500_000)).toString());
    assert.equal(panel.launchSupply, tokens(1_000_000_000).toString());
    assert.deepEqual(panel.latest.map((b) => b.n), [2, 1]);
    assert.deepEqual(panel.next, { eth: "3000000000000000", tokens: tokens(10).toString(), at: Date.UTC(2026, 9, 22, 0, 30), ready: false });
    assert.doesNotMatch(JSON.stringify(panel), /bps|share|owner|splitter/i);
  });

  test("reads the chain at most once a minute for everyone, and only reads logs when a burn is new", async () => {
    const chain = new FakeChain();
    chain.launch();
    chain.addBurn(1, 1500, tokens(1), 1n);
    let t = Date.UTC(2026, 9, 22);
    const { p } = panels(chain, {}, () => t);
    await Promise.all([p.panel(), p.panel(), p.panel()]);
    assert.equal(chain.calls.pot, 1);
    const logReads = chain.calls.burnLogs;
    t += 61_000;
    await p.panel();
    assert.equal(chain.calls.pot, 2);
    assert.equal(chain.calls.burnLogs, logReads);
    chain.block = 2_100_000;
    chain.addBurn(2, 2_050_000, tokens(1), 1n);
    t += 61_000;
    assert.deepEqual((await p.panel()).latest.map((b) => b.n), [2, 1]);
  });

  test("the last good reading, marked stale, when the chain stops answering; a plain sentence with none", async () => {
    const chain = new FakeChain();
    chain.launch();
    let t = Date.UTC(2026, 9, 22);
    const { p } = panels(chain, {}, () => t);
    const good = await p.panel();
    chain.down = true;
    t += 120_000;
    const stale = await p.panel();
    assert.equal(stale.stage, "live");
    assert.equal(stale.supply, good.supply);
    assert.equal(stale.stale, true);
    const none = await new TokenPanels({ config: testConfig(), reader: chain, db: openDb(":memory:") }).panel();
    assert.equal(none.stage, "deployed");
    assert.equal(none.stale, true);
    assert.match(none.problem ?? "", /did not answer/);
    assert.doesNotMatch(JSON.stringify(none), /rpc\.example/);
  });

  test("halves a span the node refuses as too big, and keeps spans at 100,000 blocks", async () => {
    const chain = new FakeChain();
    chain.maxSpan = 30_000;
    chain.addBurn(1, 1_050, tokens(1), 1n);
    chain.addBurn(2, 160_000, tokens(1), 1n);
    const r = await scanBurns(chain, POT, 1_000, 200_000);
    assert.deepEqual(r.logs.map((l) => l.n), [1, 2]);
    assert.equal(r.scannedTo, 200_000);
    const wide = new FakeChain();
    const spans: number[] = [];
    wide.burnLogs = async (_p, from, to) => {
      spans.push(to - from + 1);
      return [];
    };
    await scanBurns(wide, POT, 1, 250_000);
    assert.deepEqual(spans, [100_000, 100_000, 50_000]);
  });
});

const KEEPER = "0x6ee9000000000000000000000000000000006ee9";
const GWEI = 1_000_000_000n;

class FakeKeeper implements KeeperChain {
  readonly account = KEEPER;
  chain = 4663;
  price = GWEI / 50n; // 0.02 gwei
  wallet = 5_000_000_000_000_000n; // 0.005 ETH
  wouldSplit = 1_000_000_000_000_000n;
  potState: PotState = { token: TOKEN, burnCount: 0, totalTokens: ZERO, totalEth: ZERO, lastBurnAt: 0, startedAt: 1, waitingEth: 2_000_000_000_000_000n, waitingTokens: ZERO, nextAt: 1, ready: true };
  sent: { kind: "sweep" | "burn"; gas: bigint; maxFee: bigint; pendingSaved: boolean }[] = [];
  receipts = new Map<string, { ok: boolean; gas: number; block: number } | null>();
  refuse: "sweep" | "burn" | null = null;
  mined = true;
  store = memoryKeeperStore();
  async chainId() {
    return this.chain;
  }
  async gasPrice() {
    return this.price;
  }
  async balance() {
    return this.wallet;
  }
  async sweepWouldSplit() {
    return this.wouldSplit;
  }
  async estimateSweep() {
    return 200_000n;
  }
  async pot() {
    return this.potState;
  }
  async estimateBurn() {
    return 400_000n;
  }
  async send(kind: "sweep" | "burn", gas: bigint, maxFee: bigint, before: (tx: string) => Promise<void>) {
    const tx = `0x${String(this.sent.length + 1).padStart(64, kind === "sweep" ? "5" : "b")}`;
    await before(tx);
    const pendingSaved = this.store.get()?.pending?.tx === tx;
    if (this.refuse === kind) throw new NotSent("insufficient funds at https://rpc.example/key");
    this.sent.push({ kind, gas, maxFee, pendingSaved });
    this.receipts.set(tx, this.mined ? { ok: true, gas: Number(gas) - 10_000, block: 100 } : null);
    return tx;
  }
  async receipt(tx: string) {
    return this.receipts.get(tx) ?? null;
  }
}

function keeperRun(k: FakeKeeper, extra: Partial<KeeperOptions> = {}) {
  return runKeeper({ chain: k, store: k.store, dailyGas: 8_000_000, maxGwei: 0.5, minGasWei: 500_000_000_000_000n, minSweepWei: 200_000_000_000_000n, waitMs: 50, pollMs: 5, now: () => Date.UTC(2026, 9, 22, 12), ...extra });
}

describe("the keeper", () => {
  test("sweeps when the fees are worth it and burns when preview() says ready, writing each transaction down before it is sent", async () => {
    const k = new FakeKeeper();
    const r = await keeperRun(k);
    assert.equal(r.done, "ran");
    if (r.done !== "ran") return;
    assert.equal(r.sweep?.split, "1000000000000000");
    assert.ok(r.burn?.tx);
    assert.deepEqual(k.sent.map((s) => s.kind), ["sweep", "burn"]);
    assert.ok(k.sent.every((s) => s.pendingSaved));
    // gas is the estimate plus a quarter; the fee at most twice the base fee
    assert.equal(k.sent[0].gas, 250_000n);
    assert.equal(k.sent[1].gas, 500_000n);
    assert.equal(k.sent[0].maxFee, k.price * 2n);
    const rec = k.store.get()!;
    assert.equal(rec.runs, 1);
    assert.equal(rec.sweeps, 1);
    assert.equal(rec.burns, 1);
    assert.equal(rec.failures, 0);
    assert.equal(rec.pending, null);
    assert.equal(rec.account, KEEPER);
    assert.equal(rec.sweptWei, "1000000000000000");
    assert.equal(rec.lastSweep?.tx, r.sweep?.tx);
    assert.equal(rec.gasByDay["2026-10-22"], 250_000 - 10_000 + 500_000 - 10_000);
  });

  test("sends nothing it does not need: fees under the minimum wait, and no burn before preview() says ready", async () => {
    const k = new FakeKeeper();
    k.wouldSplit = 100_000_000_000_000n;
    k.potState = { ...k.potState, ready: false, nextAt: Date.UTC(2026, 9, 22, 12, 20) };
    const r = await keeperRun(k);
    assert.deepEqual(k.sent, []);
    assert.equal(r.done, "ran");
    assert.deepEqual((r as { notes: string[] }).notes, ["Fees waiting are under the sweep minimum.", "A burn is due 2026-10-22 12:20 UTC."]);
  });

  test("does nothing before the launch", async () => {
    const k = new FakeKeeper();
    k.wouldSplit = ZERO;
    k.potState = { ...k.potState, token: null, ready: false };
    const r = await keeperRun(k);
    assert.deepEqual(k.sent, []);
    assert.deepEqual((r as { notes: string[] }).notes, ["$PUSHD is not launched yet."]);
  });

  test("refuses another chain, a gas price over the cap, and a wallet under its gas floor", async () => {
    const wrong = new FakeKeeper();
    wrong.chain = 1;
    assert.deepEqual(await keeperRun(wrong), { done: "refused", reason: "The node is not Robinhood Chain." });
    const pricey = new FakeKeeper();
    pricey.price = GWEI;
    const p = await keeperRun(pricey);
    assert.ok(p.done === "refused" && p.reason.includes("over the cap"));
    const poor = new FakeKeeper();
    poor.wallet = 499_999_999_999_999n;
    const q = await keeperRun(poor);
    assert.ok(q.done === "refused" && q.reason.includes("gas floor"));
    assert.equal(poor.store.get()?.lastResult, "Refused: the keeper wallet is under its gas floor.");
    for (const k of [wrong, pricey, poor]) assert.deepEqual(k.sent, []);
  });

  test("keeps the day's gas under its cap", async () => {
    const k = new FakeKeeper();
    const r = await keeperRun(k, { dailyGas: 300_000 });
    assert.deepEqual(k.sent.map((s) => s.kind), ["sweep"]);
    assert.match((r as { notes: string[] }).notes[0], /today's gas cap/);
  });

  test("never sends while a transaction is out, writes it off as lost after half an hour, and never sends twice", async () => {
    const k = new FakeKeeper();
    k.mined = false;
    const first = await keeperRun(k);
    assert.equal(first.done, "ran");
    assert.equal(k.sent.length, 1);
    assert.equal((await keeperRun(k, { now: () => Date.UTC(2026, 9, 22, 12, 15) })).done, "waiting");
    assert.equal(k.sent.length, 1);
    k.mined = true;
    const later = await keeperRun(k, { now: () => Date.UTC(2026, 9, 22, 12) + LOST_AFTER_MS + 1 });
    assert.equal(later.done, "ran");
    const rec = k.store.get()!;
    assert.equal(rec.failures, 1);
    assert.equal(rec.lastError, "The sweep transaction never arrived.");
  });

  test("forgets a send the node refused outright, scrubbed, and goes on to the burn", async () => {
    const k = new FakeKeeper();
    k.refuse = "sweep";
    const r = await keeperRun(k);
    assert.deepEqual(k.sent.map((s) => s.kind), ["burn"]);
    assert.ok(r.done === "ran" && r.sweep === null && r.burn);
    const rec = k.store.get()!;
    assert.equal(rec.pending, null);
    assert.match(rec.lastError ?? "", /The node refused the sweep/);
    assert.doesNotMatch(rec.lastError ?? "", /rpc\.example/);
  });

  test("runs one at a time", async () => {
    const k = new FakeKeeper();
    const [a, b] = await Promise.all([keeperRun(k), keeperRun(k)]);
    assert.deepEqual([a.done, b.done].sort(), ["busy", "ran"]);
  });

  test("the engine's keeper stays off until its key and both addresses are set, and never reads a chain then", async () => {
    const db = openDb(":memory:");
    const r = await keeperOnce(db, tokenConfigFromEnv({ PUSHD_KEEPER_KEY: KEY }), { PUSHD_KEEPER_KEY: KEY });
    assert.equal(r.done, "off");
    assert.ok(r.done === "off" && r.missing.some((m) => m.includes("PUSHD_BURN_POT_ADDRESS")));
    const off = await keeperOnce(db, testConfig({ PUSHD_KEEPER_KEY: KEY, PUSHD_KEEPER: "off" }), { PUSHD_KEEPER_KEY: KEY });
    assert.equal(off.done, "off");
  });
});
