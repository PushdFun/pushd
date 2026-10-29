// The money side of the scouts: every model call is estimated before it is made and refused when it would break a
// cap, and every call that was made is written down with what it cost (the scout_spend table, and the engine's
// shared costs table that /health adds up). The caps:
//   - a hard daily cap (PUSHD_SCOUT_DAILY_USD, a UTC day): what was spent today plus what calls in flight may still
//     spend, plus this call's estimate, must stay under it;
//   - a per-call cap (PUSHD_SCOUT_CALL_MAX_USD) on the estimate: the whole prompt at the input price plus the most
//     the answer may be (max_tokens) at the output price, so the real cost can only be lower;
//   - a per-hour cap (PUSHD_SCOUT_HOURLY_USD): the last 60 minutes' spend plus what is in flight plus this estimate;
//   - a per-model budget (PUSHD_SCOUT_MODEL_CALLS_PER_DAY): calls to one model a UTC day, in flight counted.
// The same class keeps the agents' own book (src/agents, the agent_spend table, PUSHD_AGENTS_DAILY_USD): a second
// Budget on another table, so the two caps never eat into each other.
import { logCost, type DB } from "../db.ts";
import type { ScoutConfig } from "./config.ts";
import { roughTokens, type ModelAnswer } from "./provider.ts";

export const spendSchema = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  usd REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS ${table}_day ON ${table}(day);
`;
export const SPEND_SCHEMA = spendSchema("scout_spend");

/** Why a call was not made. */
export type Refusal = "no key" | "daily cap" | "call cap" | "hourly cap" | "model cap";

export class Budget {
  private reserved = 0;
  private readonly inflight = new Map<string, number>();
  private readonly holds = new Map<number, string>();
  private seq = 0;

  constructor(
    private readonly db: DB,
    private readonly c: Pick<ScoutConfig, "dailyUsd" | "callMaxUsd" | "prices"> & Partial<Pick<ScoutConfig, "hourlyUsd" | "modelCallsPerDay">>,
    private readonly now: () => number = Date.now,
    /** the book's table: scout_spend for the scouts, agent_spend for the agents */
    private readonly table: "scout_spend" | "agent_spend" = "scout_spend",
  ) {
    db.exec(spendSchema(table));
  }

  private day = () => new Date(this.now()).toISOString().slice(0, 10);

  /** USD spent today (UTC), every scout call counted. */
  spentToday(): number {
    return (this.db.prepare(`SELECT coalesce(sum(usd), 0) AS s FROM ${this.table} WHERE day = ?`).get(this.day()) as { s: number }).s;
  }

  callsToday(model?: string): number {
    if (model) return (this.db.prepare(`SELECT count(*) AS n FROM ${this.table} WHERE day = ? AND model = ?`).get(this.day(), model) as { n: number }).n;
    return (this.db.prepare(`SELECT count(*) AS n FROM ${this.table} WHERE day = ?`).get(this.day()) as { n: number }).n;
  }

  /** USD spent in the last 60 minutes. */
  spentThisHour(): number {
    return (this.db.prepare(`SELECT coalesce(sum(usd), 0) AS s FROM ${this.table} WHERE at >= ?`).get(this.now() - 3_600_000) as { s: number }).s;
  }

  /** Calls to each model today. */
  perModelToday(): { model: string; calls: number; usd: number }[] {
    return this.db.prepare(`SELECT model, count(*) AS calls, round(sum(usd), 6) AS usd FROM ${this.table} WHERE day = ? GROUP BY model ORDER BY calls DESC`).all(this.day()) as { model: string; calls: number; usd: number }[];
  }

  /** The most a call can cost: the prompt at the input price and the longest answer at the output price. */
  estimate(model: string, prompt: string, maxTokens: number): number {
    const [pin, pout] = this.c.prices[model] ?? [5, 20];
    return (roughTokens(prompt) * pin + maxTokens * pout) / 1_000_000;
  }

  /** Holds the estimate for a call about to be made, or says why not. Release it with settle() or cancel(). */
  reserve(estimate: number, model?: string): { ok: true; hold: number } | { ok: false; why: Refusal } {
    if (estimate > this.c.callMaxUsd) return { ok: false, why: "call cap" };
    if (this.spentToday() + this.reserved + estimate > this.c.dailyUsd) return { ok: false, why: "daily cap" };
    if (this.c.hourlyUsd != null && this.spentThisHour() + this.reserved + estimate > this.c.hourlyUsd) return { ok: false, why: "hourly cap" };
    if (model && this.c.modelCallsPerDay != null && this.callsToday(model) + (this.inflight.get(model) ?? 0) >= this.c.modelCallsPerDay) return { ok: false, why: "model cap" };
    this.reserved += estimate;
    // a hold is its estimate plus a tiny unique offset, so in-flight calls per model can be let go one by one
    const hold = estimate + ++this.seq * 1e-12;
    if (model) {
      this.inflight.set(model, (this.inflight.get(model) ?? 0) + 1);
      this.holds.set(hold, model);
    }
    return { ok: true, hold };
  }

  cancel(hold: number) {
    this.reserved = Math.max(0, this.reserved - hold);
    const m = this.holds.get(hold);
    if (m) {
      this.holds.delete(hold);
      this.inflight.set(m, Math.max(0, (this.inflight.get(m) ?? 1) - 1));
    }
  }

  /** Writes a made call down and lets go of its hold. A call with no reported cost is booked at its token count. */
  settle(hold: number, a: Omit<ModelAnswer, "text">, purpose: string, ref: string, ok: boolean): number {
    this.cancel(hold);
    const [pin, pout] = this.c.prices[a.model] ?? this.c.prices[Object.keys(this.c.prices)[0]] ?? [5, 20];
    const estimated = a.usd == null;
    const usd = a.usd ?? (a.inputTokens * pin + a.outputTokens * pout) / 1_000_000;
    const at = this.now();
    this.db
      .prepare(`INSERT INTO ${this.table} (at, day, purpose, model, input_tokens, output_tokens, usd, estimated, ok, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(at, this.day(), purpose, a.model, a.inputTokens, a.outputTokens, usd, estimated ? 1 : 0, ok ? 1 : 0, ref);
    logCost(this.db, { at: new Date(at).toISOString(), provider: "openrouter", model: a.model, inputTokens: a.inputTokens, outputTokens: a.outputTokens, usd, ref: `${purpose}:${ref}` });
    return usd;
  }

  /** Today's numbers, for /health and the scouts page. */
  today(): { day: string; usd: number; calls: number; capUsd: number; leftUsd: number; hourUsd: number; hourCapUsd: number | null; perModel: { model: string; calls: number; usd: number }[]; modelCallsPerDay: number | null } {
    const usd = Math.round(this.spentToday() * 1e6) / 1e6;
    return {
      day: this.day(),
      usd,
      calls: this.callsToday(),
      capUsd: this.c.dailyUsd,
      leftUsd: Math.max(0, Math.round((this.c.dailyUsd - usd) * 1e6) / 1e6),
      hourUsd: Math.round(this.spentThisHour() * 1e6) / 1e6,
      hourCapUsd: this.c.hourlyUsd ?? null,
      perModel: this.perModelToday(),
      modelCallsPerDay: this.c.modelCallsPerDay ?? null,
    };
  }
}
