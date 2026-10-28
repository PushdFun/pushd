// The ranking at work: the hourly pass (new GH Archive hours, the markets of the projects in play, then the score and
// the rotation) and the deeper daily pass (the pool gathered again from the token listings, every owner's repos and
// commits read through the search API, followers for the best few). Its views: the Top N with its movement and
// breakdown (GET /v1/top), and one project's place (GET /v1/top/:handle).
import type { DB } from "../db.ts";
import { getMeta, setMeta } from "../db.ts";
import { schedulePlan, tierMinutes, tierOf, sharesFor } from "../plan.ts";
import type { GroupKey, ProjectRank, RankChange, RankRow, RankRules, TopView } from "../types.ts";
import { PART_DEFS, type RankConfig } from "./config.ts";
import { hoursToRead, processHour } from "./gharchive.ts";
import type { Pool } from "./pool.ts";
import { campOrder, rotate, type StateRow } from "./rotate.ts";
import { scoreAll } from "./score.ts";
import { ensureRankSchema, tokenOf, type PoolRow } from "./store.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type RankerDeps = {
  db: DB;
  config: RankConfig;
  /** null in the API process: it only reads the ranking */
  pool: Pool | null;
  authenticated: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
};

type StateFull = StateRow & { parts: string | null; top_repos: string | null; last_active: string | null; updated_at: number | null };

export class Ranker {
  private busy = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly d: RankerDeps) {
    ensureRankSchema(d.db);
  }

  private now = () => (this.d.now ?? Date.now)();
  private log = (m: string) => this.d.log?.(`rank: ${m}`);

  get rules(): RankRules {
    const c = this.d.config;
    return { size: c.size, enterRank: c.enterRank, enterPasses: c.enterPasses, exitRank: c.exitRank, exitPasses: c.exitPasses, minDwellHours: c.minDwellHours, campMin: c.campMin };
  }

  // ---- the passes ----

  /** Reads up to `max` GH Archive hours not read yet, newest first. */
  async archive(max = 3): Promise<{ hours: number; events: number; kept: number; bytes: number }> {
    if (!this.d.config.sources.gharchive) return { hours: 0, events: 0, kept: 0, bytes: 0 };
    const want = new Set((this.d.db.prepare("SELECT login FROM pool WHERE status != 'out' OR login IN (SELECT login FROM rank_state WHERE in_top = 1)").all() as { login: string }[]).map((r) => r.login));
    const todo = hoursToRead(this.d.db, Math.max(2, this.d.config.sources.gharchiveBackfillHours), this.now()).slice(0, max);
    const sum = { hours: 0, events: 0, kept: 0, bytes: 0 };
    for (const h of todo) {
      const r = await processHour(this.d.db, h, (o) => want.has(o), this.d.fetchImpl, this.d.now);
      if (r.status !== 200) continue;
      sum.hours++;
      sum.events += r.events;
      sum.kept += r.kept;
      sum.bytes += r.bytes;
    }
    // the archive's counts are kept 35 days
    const cut = new Date(this.now() - 35 * DAY).toISOString().slice(0, 10);
    this.d.db.prepare("DELETE FROM act_actor WHERE day < ?").run(cut);
    this.d.db.prepare("DELETE FROM act_repo WHERE day < ?").run(cut);
    this.d.db.prepare("DELETE FROM act_hour WHERE substr(hour, 1, 10) < ?").run(cut);
    return sum;
  }

  /** Scores the eligible pool and rotates the Top N. Writes the state, the history and the log. */
  rank(kind: "hourly" | "deep" | "manual" = "manual"): { changes: number; eligible: number } {
    const t0 = this.now();
    const db = this.d.db;
    const rows = db.prepare("SELECT * FROM pool WHERE status = 'ok'").all() as PoolRow[];
    const scored = scoreAll(db, rows, this.d.config, t0);
    const campOfLogin = new Map(rows.map((r) => [r.login, r.camp]));
    const order = campOrder(scored, (l) => campOfLogin.get(l) ?? "oss", this.d.config.size, this.d.config.campMin);
    const stateRows = db.prepare("SELECT * FROM rank_state").all() as StateFull[];
    const state = new Map(stateRows.map((s) => [s.login, s as StateRow]));
    const gone = new Map<string, string>();
    for (const s of stateRows) {
      if (!s.in_top || campOfLogin.has(s.login)) continue;
      const p = db.prepare("SELECT why FROM pool WHERE login = ?").get(s.login) as { why: string | null } | undefined;
      gone.set(s.login, p?.why ?? "it left the pool");
    }
    const since14 = t0 - 14 * DAY;
    const peakQ = db.prepare("SELECT max(score) AS m FROM rank_history WHERE login = ? AND at >= ?");
    const { next, changes } = rotate({ order, state, gone, peak14: (l) => (peakQ.get(l, since14) as { m: number | null }).m, rules: this.d.config, now: t0 });
    const byLogin = new Map(scored.map((s) => [s.login, s]));
    const tx = db.transaction(() => {
      const up = db.prepare(
        `INSERT INTO rank_state (login, in_top, entered_at, left_at, streak_in, streak_out, rank, score, parts, top_repos, last_active, updated_at) VALUES (@login, @in_top, @entered_at, @left_at, @streak_in, @streak_out, @rank, @score, @parts, @top_repos, @last_active, @updated_at)
         ON CONFLICT(login) DO UPDATE SET in_top = excluded.in_top, entered_at = excluded.entered_at, left_at = excluded.left_at, streak_in = excluded.streak_in, streak_out = excluded.streak_out, rank = excluded.rank, score = excluded.score, parts = coalesce(excluded.parts, parts), top_repos = coalesce(excluded.top_repos, top_repos), last_active = coalesce(excluded.last_active, last_active), updated_at = excluded.updated_at`,
      );
      for (const st of next.values()) {
        const s = byLogin.get(st.login);
        // a project that left the pool keeps its last numbers, without a rank
        up.run({ ...st, rank: s ? st.rank : null, parts: s ? JSON.stringify(s.parts) : null, top_repos: s ? JSON.stringify(s.topRepos) : null, last_active: s?.lastActiveAt ?? null, updated_at: t0 });
      }
      const hist = db.prepare("INSERT OR REPLACE INTO rank_history (at, login, rank, score) VALUES (?, ?, ?, ?)");
      order.slice(0, Math.max(300, this.d.config.exitRank * 2)).forEach((x, i) => hist.run(t0, x.login, i + 1, x.score));
      const logQ = db.prepare("INSERT INTO rank_log (at, login, change, rank, reason) VALUES (?, ?, ?, ?, ?)");
      for (const c of changes) logQ.run(t0, c.login, c.change, c.rank, c.reason);
      db.prepare("DELETE FROM rank_history WHERE at < ?").run(t0 - 30 * DAY);
      db.prepare("INSERT INTO rank_passes (at, kind, pool, eligible, ms, note) VALUES (?, ?, ?, ?, ?, ?)").run(t0, kind, (db.prepare("SELECT count(*) AS n FROM pool").get() as { n: number }).n, rows.length, this.now() - t0, `${changes.length} change(s)`);
    });
    tx();
    this.log(`${kind} pass: ${rows.length} eligible, ${changes.length} change(s) (${changes.filter((c) => c.change === "enter").length} in, ${changes.filter((c) => c.change === "exit").length} out)`);
    return { changes: changes.length, eligible: rows.length };
  }

  async hourly(): Promise<void> {
    const a = await this.archive(3);
    if (a.hours) this.log(`archive: ${a.hours} hour(s), ${a.events} events, ${a.kept} kept, ${(a.bytes / 1e6).toFixed(1)} MB streamed`);
    if (this.d.pool) {
      const n = await this.d.pool.refreshMarkets();
      this.log(`markets refreshed for ${n} token(s)`);
    }
    this.rank("hourly");
    setMeta(this.d.db, "rank_hourly_at", String(this.now()));
  }

  async deep(): Promise<void> {
    if (!this.d.pool) return;
    const r = await this.d.pool.deepPass();
    this.log(`deep pass: ${r.tokens} token(s), ${r.withGithub} with GitHub, ${r.owners} owner(s), ${r.eligible} eligible, ${r.read} read on GitHub, ${Math.round(r.ms / 1000)} s`);
    setMeta(this.d.db, "rank_deep_at", String(this.now()));
    setMeta(this.d.db, "rank_deep_result", JSON.stringify(r));
    // the archive's backfill, a few hours each pass, so the first ranking has more than an hour of history
    await this.archive(12);
    this.rank("deep");
  }

  private async guarded(fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch (e) {
      this.log(`pass failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Runs the passes on their schedule (the watcher's process). Returns a stop function. */
  start(): () => void {
    if (!this.d.config.on || !this.d.pool) return () => undefined;
    const tick = () =>
      this.guarded(async () => {
        const deepAt = Number(getMeta(this.d.db, "rank_deep_at") ?? 0);
        const hourAt = Number(getMeta(this.d.db, "rank_hourly_at") ?? 0);
        if (this.now() - deepAt >= this.d.config.deepEveryHours * HOUR) await this.deep();
        else if (this.now() - hourAt >= this.d.config.everyHourMin * 60_000) await this.hourly();
      });
    void tick();
    const t = setInterval(tick, 60_000);
    t.unref?.();
    this.timers.push(t);
    return () => this.timers.forEach(clearInterval);
  }

  // ---- the views ----

  private rows(): (PoolRow & StateFull & { s_rank: number | null })[] {
    return this.d.db
      .prepare("SELECT p.*, s.in_top, s.entered_at, s.left_at, s.streak_in, s.streak_out, s.rank AS s_rank, s.score, s.parts, s.top_repos, s.last_active, s.updated_at FROM pool p JOIN rank_state s ON s.login = p.login")
      .all() as (PoolRow & StateFull & { s_rank: number | null })[];
  }

  /** The rank a project had a day ago (the nearest pass at least 24 hours back). */
  private rankDayAgo(): Map<string, number> {
    const t = (this.d.db.prepare("SELECT max(at) AS t FROM rank_history WHERE at <= ?").get(this.now() - DAY) as { t: number | null }).t ?? (this.d.db.prepare("SELECT min(at) AS t FROM rank_history").get() as { t: number | null }).t;
    if (t == null) return new Map();
    return new Map((this.d.db.prepare("SELECT login, rank FROM rank_history WHERE at = ?").all(t) as { login: string; rank: number }[]).map((r) => [r.login, r.rank]));
  }

  private toRow(r: PoolRow & StateFull & { s_rank: number | null }, prev: Map<string, number>, minutes: Record<1 | 2 | 3, number>, topRank: number | null): RankRow {
    const rank = r.s_rank ?? 0;
    const before = prev.get(r.login);
    const isNew = !!r.in_top && !!r.entered_at && this.now() - r.entered_at < DAY;
    const delta = before != null && rank ? before - rank : 0;
    const tier = r.in_top && topRank ? tierOf(topRank) : null;
    return {
      rank,
      handle: r.display,
      ...(r.name ? { name: r.name.replace(/[\u2013\u2014]/g, "-") } : {}),
      ...(r.symbol ? { org: `$${r.symbol.replace(/^\$/, "")}` } : {}),
      group: r.camp as GroupKey,
      type: r.type === "user" ? "user" : "org",
      score: r.score ?? 0,
      movement: isNew ? "new" : delta > 0 ? "up" : delta < 0 ? "down" : "same",
      delta,
      inTop: !!r.in_top,
      enteredAt: r.entered_at ? new Date(r.entered_at).toISOString() : null,
      tier,
      checkEveryMin: tier ? minutes[tier] : null,
      lastActiveAt: r.last_active ?? null,
      token: tokenOf(r, this.now()),
      parts: r.parts ? JSON.parse(r.parts) : [],
      topRepos: r.top_repos ? JSON.parse(r.top_repos) : [],
      sample: false,
    };
  }

  private change(r: { at: number; login: string; change: string; rank: number; reason: string }, names: Map<string, PoolRow>): RankChange {
    const p = names.get(r.login);
    return { at: new Date(r.at).toISOString(), handle: p?.display ?? r.login, ...(p?.name ? { name: p.name } : {}), group: (p?.camp ?? "oss") as GroupKey, change: r.change as "enter" | "exit", rank: r.rank, reason: r.reason };
  }

  top(): TopView {
    const all = this.rows();
    const prev = this.rankDayAgo();
    const members = all.filter((r) => r.in_top).sort((a, b) => (a.s_rank ?? 1e9) - (b.s_rank ?? 1e9));
    const minutes = tierMinutes(members.length, sharesFor(this.d.authenticated).watch, this.d.authenticated);
    const rows = members.map((r, i) => ({ ...this.toRow(r, prev, minutes, i + 1), rank: i + 1 }));
    // the ranking's own place (score order) stays in `delta`; the list shows 1..N in the order of the score
    const waiting = all
      .filter((r) => !r.in_top && r.s_rank != null && r.status === "ok")
      .sort((a, b) => (a.s_rank ?? 0) - (b.s_rank ?? 0))
      .slice(0, 12)
      .map((r) => this.toRow(r, prev, minutes, null));
    const names = new Map((this.d.db.prepare("SELECT * FROM pool").all() as PoolRow[]).map((p) => [p.login, p]));
    const log = (change: string) =>
      (this.d.db.prepare("SELECT * FROM rank_log WHERE change = ? AND reason NOT LIKE 'in the first ranking pass%' ORDER BY at DESC, n DESC LIMIT 12").all(change) as { at: number; login: string; change: string; rank: number; reason: string }[]).map((r) => this.change(r, names));
    const byCamp = { chain: 0, wallets: 0, launchpads: 0, ai: 0, oss: 0 } as Record<GroupKey, number>;
    for (const r of rows) byCamp[r.group]++;
    const passes = (this.d.db.prepare("SELECT count(*) AS n, max(at) AS t FROM rank_passes").get() as { n: number; t: number | null });
    const deepAt = Number(getMeta(this.d.db, "rank_deep_at") ?? 0);
    return {
      asOf: new Date(this.now()).toISOString(),
      lastPass: passes.t ? new Date(passes.t).toISOString() : null,
      lastDeepPass: deepAt ? new Date(deepAt).toISOString() : null,
      passes: passes.n,
      pool: (this.d.db.prepare("SELECT count(*) AS n FROM pool").get() as { n: number }).n,
      rows,
      waiting,
      entered: log("enter"),
      dropped: log("exit"),
      byCamp,
      weights: PART_DEFS.map((p) => ({ key: p.key, label: p.label, weight: this.d.config.weights[p.key] })),
      rules: this.rules,
      schedule: schedulePlan(this.d.db, members.length || this.d.config.size, this.d.authenticated, process.env, this.now()),
      sample: false,
    };
  }

  /** One project's place: its row, its rank over the last 30 days, its changes. Null when it is not in the pool. */
  project(handle: string): ProjectRank | null {
    const login = handle.replace(/^@/, "").toLowerCase();
    const all = this.rows();
    const r = all.find((x) => x.login === login);
    if (!r) return null;
    const members = all.filter((x) => x.in_top).sort((a, b) => (a.s_rank ?? 1e9) - (b.s_rank ?? 1e9));
    const minutes = tierMinutes(members.length, sharesFor(this.d.authenticated).watch, this.d.authenticated);
    const pos = members.findIndex((x) => x.login === login);
    const row = this.toRow(r, this.rankDayAgo(), minutes, pos >= 0 ? pos + 1 : null);
    if (pos >= 0) row.rank = pos + 1;
    const history = (this.d.db.prepare("SELECT at, rank, score FROM rank_history WHERE login = ? ORDER BY at").all(login) as { at: number; rank: number; score: number }[]).map((h) => ({ at: new Date(h.at).toISOString(), rank: h.rank, score: h.score }));
    const names = new Map([[r.login, r as PoolRow]]);
    const changes = (this.d.db.prepare("SELECT * FROM rank_log WHERE login = ? ORDER BY at DESC LIMIT 10").all(login) as { at: number; login: string; change: string; rank: number; reason: string }[]).map((c) => this.change(c, names));
    return { row, history, changes, poolSince: new Date(r.added_at).toISOString(), rules: this.rules };
  }

  /** The row for a login (lookups and pages), or null outside the pool's ranking. */
  rowOf(handle: string): RankRow | null {
    return this.project(handle)?.row ?? null;
  }

  /** For /v1/admin/status: the passes and the outside sources' calls. */
  status() {
    return {
      lastPass: (this.d.db.prepare("SELECT * FROM rank_passes ORDER BY at DESC LIMIT 1").get() as object | undefined) ?? null,
      lastDeep: getMeta(this.d.db, "rank_deep_result") ? JSON.parse(getMeta(this.d.db, "rank_deep_result")!) : null,
      pool: this.d.db.prepare("SELECT status, count(*) AS n FROM pool GROUP BY status").all(),
      inTop: (this.d.db.prepare("SELECT count(*) AS n FROM rank_state WHERE in_top = 1").get() as { n: number }).n,
      archiveHours: this.d.db.prepare("SELECT count(*) AS hours, coalesce(sum(events), 0) AS events, coalesce(sum(kept), 0) AS kept, coalesce(sum(bytes), 0) AS bytes FROM gha_hours WHERE status = 200 AND at >= ?").get(this.now() - DAY),
    };
  }
}
