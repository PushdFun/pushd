// Credit protection for the scouts: the quality gate (heat floor, routine work, near-identical pushes to one repo),
// deep reads only for hot new repos and releases, the hourly and per-model caps beside the daily one, and proof that
// the caps hold with ten times the usual volume of lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertItem, openDb } from "../src/db.ts";
import { Budget } from "../src/scouts/budget.ts";
import { Scouts } from "../src/scouts/scouts.ts";
import type { WatchEntry } from "../src/types.ts";
import { answer, FakeModel, line } from "./scout-helpers.ts";
import { scoutConfigFromEnv } from "../src/scouts/config.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const accounts: WatchEntry[] = [{ handle: "gakonst", name: "Georgios", org: "x", group: "wallets", type: "user", source: "t" }];

function world(env: Record<string, string> = {}, now = () => NOW) {
  const db = openDb(":memory:");
  const config = scoutConfigFromEnv({ PUSHD_SCOUT_GAP_MS: "0", ...env }, { key: "k" });
  const model = new FakeModel(() => answer({ heat: 5 }));
  const scouts = new Scouts({ db, accounts, config, provider: model, gh: null, now });
  return { db, scouts, model, config };
}

test("the gate: a line under the heat floor gets a template call and no model call", async () => {
  const { db, scouts, model } = world();
  const it = line(NOW, { id: "low", handle: "gakonst", group: "wallets", kind: "push", score: 1 });
  insertItem(db, it);
  const c = await scouts.callItem(it, false);
  assert.equal(c?.source, "template");
  assert.match(c!.flags[0], /under the heat gate/);
  assert.equal(model.requests.length, 0);
});

test("the gate: routine work never reaches the model", async () => {
  const { db, scouts, model } = world({ PUSHD_SCOUT_MIN_HEAT: "0" });
  const it = line(NOW, { id: "bump", handle: "gakonst", group: "wallets", kind: "push", score: 5, summary: "Bump dependencies and fix CI." });
  insertItem(db, it);
  const c = await scouts.callItem(it, false);
  assert.equal(c?.source, "template");
  assert.match(c!.flags[0], /routine work/);
  assert.equal(model.requests.length, 0);
});

test("near-identical pushes to one repo make one model call, not one each (the nanocode-ts repeats)", async () => {
  const { db, scouts, model } = world({ PUSHD_SCOUT_MIN_HEAT: "0" });
  const pushes = [0, 1, 2, 3, 4].map((i) =>
    line(NOW, { id: `nanocode-ts-push-${i}`, key: `k${i}`, handle: "gakonst", group: "wallets", kind: "push", repo: "nanocode-ts", score: 4, summary: "Nanocode agents in TypeScript.", githubAt: new Date(NOW - (60 - i * 10) * 60_000).toISOString() }),
  );
  for (const p of pushes) insertItem(db, p);
  scouts.follow();
  await scouts.work(10);
  assert.equal(model.requests.length, 1, "one model call for the repo");
  const calls = pushes.map((p) => scouts.callOf(p.id)!);
  assert.equal(calls.filter((c) => c.source === "model").length, 1);
  assert.ok(calls.filter((c) => c.source === "template").every((c) => /already|waiting/.test(c.flags[0])));
});

test("deep reads only for new repos and releases at the deep heat or more", async () => {
  const { db, scouts } = world({ PUSHD_SCOUT_MIN_HEAT: "0", PUSHD_SCOUT_DEEP_MIN_HEAT: "6" });
  const cool = line(NOW, { id: "cool-repo", handle: "gakonst", group: "wallets", kind: "repo", score: 4 });
  insertItem(db, cool);
  const c = await scouts.callItem(cool, false);
  assert.equal(c?.deep, false);
  assert.ok(!c!.flags.some((f) => /could not be read/.test(f)), "not a failed read: no read was wanted");
});

test("the hourly cap and the per-model budget refuse a call, beside the daily cap", () => {
  const db = openDb(":memory:");
  let t = NOW;
  const b = new Budget(db, { dailyUsd: 2, callMaxUsd: 0.03, prices: { m: [1, 1] }, hourlyUsd: 0.01, modelCallsPerDay: 3 }, () => t);
  const h1 = b.reserve(0.004, "m");
  assert.ok(h1.ok);
  b.settle(h1.ok ? h1.hold : 0, { model: "m", inputTokens: 1, outputTokens: 1, usd: 0.004 }, "t", "1", true);
  const h2 = b.reserve(0.004, "m");
  assert.ok(h2.ok);
  b.settle(h2.ok ? h2.hold : 0, { model: "m", inputTokens: 1, outputTokens: 1, usd: 0.004 }, "t", "2", true);
  const h3 = b.reserve(0.004, "m");
  assert.deepEqual(h3, { ok: false, why: "hourly cap" });
  t += 3_700_000; // an hour later the hour has room again
  const h4 = b.reserve(0.004, "m");
  assert.ok(h4.ok);
  // three calls to "m" today with this one in flight: the fourth is refused by the model budget
  const h5 = b.reserve(0.001, "m");
  assert.deepEqual(h5, { ok: false, why: "model cap" });
  b.cancel(h4.ok ? h4.hold : 0);
  assert.ok(b.reserve(0.001, "m").ok, "a cancelled call frees its place");
  assert.equal(b.today().hourCapUsd, 0.01);
});

test("ten times the volume: 1,200 lines in a day, the caps hold and the model is asked only for what passes the gate", async () => {
  const DAY0 = Date.parse("2026-10-28T00:10:00Z");
  let t = DAY0;
  const { db, scouts, model, config } = world(
    { PUSHD_SCOUT_DAILY_USD: "0.015", PUSHD_SCOUT_HOURLY_USD: "0.001", PUSHD_SCOUT_MODEL_CALLS_PER_DAY: "60", PUSHD_SCOUT_MIN_HEAT: "4" },
    () => t,
  );
  // a pretend model that reports no price: each call is booked at its token count (1,200 in, 90 out)
  (model as unknown as { script: unknown }).script = () => ({ text: answer({ heat: 5 }), usd: null });
  const kinds = ["push", "repo", "release", "gist"] as const;
  let n = 0;
  for (let h = 0; h < 24; h++) {
    t = DAY0 + h * 3_600_000;
    for (let i = 0; i < 50; i++) {
      n++;
      const it = line(t, { id: `l${n}`, key: `k${n}`, handle: "gakonst", group: "wallets", kind: kinds[n % 4], repo: `repo-${n % 37}`, version: n % 4 === 2 ? `v${n}` : undefined, score: n % 10, summary: n % 7 === 0 ? "Bump deps." : `Work number ${n}.`, githubAt: new Date(t - 60_000).toISOString(), shownAt: new Date(t).toISOString() });
      insertItem(db, it);
    }
    scouts.follow();
    await scouts.work(200);
  }
  const today = scouts.budget.today();
  const spentAll = (db.prepare("SELECT coalesce(sum(usd), 0) AS s, count(*) AS n FROM scout_spend").get() as { s: number; n: number });
  const maxHour = (db.prepare("SELECT max(s) AS m FROM (SELECT (at / 3600000) AS h, sum(usd) AS s FROM scout_spend GROUP BY h)").get() as { m: number }).m;
  assert.equal(n, 1200);
  assert.ok(spentAll.s <= config.dailyUsd + 1e-9, `daily cap: ${spentAll.s}`);
  assert.ok(maxHour <= config.hourlyUsd + 1e-9, `hourly cap: ${maxHour}`);
  assert.ok(spentAll.n <= 60, `per-model budget: ${spentAll.n} calls`);
  assert.equal(model.requests.length, spentAll.n, "every model call is booked");
  const calls = db.prepare("SELECT source, count(*) AS n FROM scout_calls GROUP BY source").all() as { source: string; n: number }[];
  assert.equal(calls.reduce((s, c) => s + c.n, 0), 1200, "every line still gets a call (template when gated or capped)");
  assert.ok(scouts.gated >= 600, `the gate took most lines: ${scouts.gated}`);
  assert.ok(today.calls <= 60);
});
