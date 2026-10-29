// PUSHD Agents at work: who is signed in with GitHub, their agents, the runs and their receipts, the webhook, the
// schedules, the limits and the pay per run. (The paid agent API that lets AI agents read PUSHD is src/agent.)
//
// Who: a person signs in with GitHub (the PUSHD GitHub App's own OAuth); the repos they can reach through the app's
// installations are kept, nothing else. A wallet that signed in as a holder in the same browser is linked to the
// GitHub account, and its $PUSHD is read on every run the way every holder check reads it.
//
// Limits (decided by the owner):
//   - without a holding: PUSHD_AGENTS_FREE_PER_DAY runs a UTC day (5). Past them a run can be paid: about $0.10 in ETH,
//     to the burn pot, with the same 402 scheme and checks as the paid agent API (src/agent/payments.ts), so every
//     paid run buys $PUSHD and burns it.
//   - holders: no daily count, under a quiet fair-use guard (PUSHD_AGENTS_HOLDER_PER_HOUR, _PER_DAY).
//   - everyone: all agents' model spend a UTC day stays under PUSHD_AGENTS_DAILY_USD; when it is reached runs pause with
//     a plain message until 00:00 UTC, and a run stopped by it is not counted or charged.
//   - agents per GitHub account follow the holding (PUSHD_AGENTS_TIERS); without one: 1.
//   - the key check on each push uses no model and is never counted.
//
// Every run is a receipt (agent_runs): job, repo, model, cost, outputs, and every action it took (agent_actions,
// written once): branch, commit, pull request, comment, labels, draft release.
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db.ts";
import { Limiter } from "../agent/limits.ts";
import { ethString, PaymentError, Payments } from "../agent/payments.ts";
import { Budget } from "../scouts/budget.ts";
import { checkText } from "../scouts/guard.ts";
import type { ModelProvider } from "../scouts/provider.ts";
import { SCOUT_BY_ID, SCOUTS } from "../scouts/roster.ts";
import { WEI } from "../token/config.ts";
import { ask, JobError } from "./ask.ts";
import type { AgentsConfig } from "./config.ts";
import { GhAppError, isRepo, verifyWebhook, type GitHubApp, type RepoClient } from "./github-app.ts";
import { RUNNERS, type Action, type JobResult, type Outside, type Output, type RunCtx, type RunInput } from "./jobs.ts";
import { maskSecrets } from "./secrets.ts";
import { checkSpec, draftSystem, isJobId, JOBS, specSchema, SpecError, SPEC_LIMITS, templateSpec, type AgentSpec, type JobId, type Trigger } from "./spec.ts";
import { ensureAgentsSchema, markSha, markUrl } from "./store.ts";

export class AgentsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const PAUSED = "Agent runs are paused for today. They start again at 00:00 UTC. Nothing was charged.";
export const RUN_TOOL = "pushd_agent_run";
/** the scouts' own agents belong to this account id (no GitHub user has id 0) */
export const SYSTEM_USER = 0;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dayStart = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());

export type Holding = { holder: boolean; balanceWei: bigint | null };

export type AgentsDeps = {
  db: DB;
  config: AgentsConfig;
  /** the GitHub App; null until its settings are there (sign-in and runs then answer that it is not set up) */
  app: GitHubApp | null;
  provider: ModelProvider | null;
  payments: Payments;
  /** a wallet's holding, read the way every holder check reads it (cached, from the chain) */
  holding: (wallet: string) => Promise<Holding>;
  /** the wallet behind a holder's session token, when it is valid */
  holderSession: (token: string | null) => string | null;
  /** web push to a wallet's devices (src/push.ts); null when push is off */
  push: { sendTo(address: string, payload: string, urgent: boolean): Promise<number>; on: boolean } | null;
  outside: Outside;
  siteUrl: string;
  now?: () => number;
  log?: (msg: string) => void;
};

type AgentRow = { id: string; user_id: number; name: string; text: string; spec: string; paused: number; proof: number; scout: string | null; created_at: number; updated_at: number };
type RunRow = {
  id: string;
  agent_id: string;
  user_id: number;
  job: string;
  trigger: string;
  repo: string;
  input: string;
  status: string;
  billing: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  model: string | null;
  usd: number;
  summary: string | null;
  outputs: string;
  flags: string;
  error: string | null;
  payment_tx: string | null;
  public: number;
};

export type RunView = {
  id: string;
  agentId: string;
  job: string;
  jobTitle: string;
  trigger: string;
  repo: string;
  status: string;
  billing: string;
  createdAt: number;
  finishedAt: number | null;
  model: string | null;
  usd: number;
  summary: string | null;
  outputs: Output[];
  flags: string[];
  error: string | null;
  actions: { action: string; url: string | null; note: string | null; at: number }[];
  payment: { tx: string } | null;
};

export type AgentView = { id: string; name: string; text: string; spec: AgentSpec; paused: boolean; proof: boolean; createdAt: number; updatedAt: number; runs: number; lastRunAt: number | null; scout: string | null };

export type MeView = {
  user: { id: number; login: string };
  wallet: string | null;
  holder: boolean;
  repos: string[];
  agents: AgentView[];
  allowed: number;
  tiers: { minWhole: string; agents: number }[];
  freePerDay: number;
  freeLeft: number | null;
  paused: boolean;
  price: { wei: string; eth: string; payTo: string | null; open: boolean };
  inbox: { n: number; runId: string | null; at: number; title: string; body: string; seen: boolean }[];
  installUrl: string | null;
};

export class Agents {
  readonly budget: Budget;
  private readonly limiter: Limiter;
  private busy = false;

  constructor(private readonly d: AgentsDeps) {
    ensureAgentsSchema(d.db);
    const prices: Record<string, [number, number]> = { [d.config.model]: [1, 5] };
    for (const s of SCOUTS) {
      prices[s.model] = s.price;
      prices[s.deepModel] = s.deepPrice;
    }
    this.budget = new Budget(d.db, { dailyUsd: d.config.dailyUsd, callMaxUsd: d.config.callMaxUsd, prices }, d.now, "agent_spend");
    this.limiter = new Limiter(d.now);
  }

  private now = () => (this.d.now ?? Date.now)();
  private log = (m: string) => this.d.log?.(`agents: ${m}`);

  /** The agents' budget is spent for today: runs that need the model wait until 00:00 UTC. */
  get paused(): boolean {
    return this.budget.spentToday() >= this.d.config.dailyUsd;
  }

  // ---- who ----

  private user(id: number): { id: number; login: string; wallet: string | null } | null {
    return (this.d.db.prepare("SELECT id, login, wallet FROM gh_users WHERE id = ?").get(id) as { id: number; login: string; wallet: string | null } | undefined) ?? null;
  }

  /** Sign-in with GitHub: the OAuth code to a session of ours. The GitHub token is used once and dropped. */
  async signIn(code: unknown, redirectUri: unknown, visitor: string): Promise<{ session: string; expiresAt: number; user: { id: number; login: string } }> {
    if (!this.d.app) throw new AgentsError(409, "Sign-in with GitHub is not set up yet.");
    const lim = this.limiter.take(`signin:${visitor}`, 10, HOUR);
    if (!lim.ok) throw new AgentsError(429, "Too many sign-ins. Try again later.");
    if (typeof code !== "string" || typeof redirectUri !== "string" || !/^https?:\/\/[^\s]{1,200}$/.test(redirectUri)) throw new AgentsError(400, "That sign-in is not valid. Start again.");
    let who;
    try {
      who = await this.d.app.signIn(code, redirectUri);
    } catch (e) {
      throw e instanceof GhAppError ? new AgentsError(e.status, e.message) : e;
    }
    const now = this.now();
    const db = this.d.db;
    db.transaction(() => {
      db.prepare("INSERT INTO gh_users (id, login, created_at, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login, seen_at = excluded.seen_at").run(who.id, who.login, now, now);
      db.prepare("DELETE FROM gh_user_repos WHERE user_id = ?").run(who.id);
      for (const i of who.installations) {
        db.prepare("INSERT INTO gh_installs (id, account, account_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account = excluded.account, updated_at = excluded.updated_at").run(i.id, i.account, i.accountId, now);
        for (const r of i.repos) db.prepare("INSERT OR IGNORE INTO gh_user_repos (user_id, install_id, full_name) VALUES (?, ?, ?)").run(who.id, i.id, r);
      }
    })();
    const session = randomBytes(32).toString("base64url");
    const expiresAt = now + this.d.config.sessionDays * DAY;
    db.prepare("DELETE FROM gh_sessions WHERE expires_at < ?").run(now);
    db.prepare("INSERT INTO gh_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(session), who.id, now, expiresAt);
    return { session, expiresAt, user: { id: who.id, login: who.login } };
  }

  /** The GitHub account behind a session token, or null. */
  session(token: unknown): { id: number; login: string; wallet: string | null } | null {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const row = this.d.db.prepare("SELECT user_id, expires_at FROM gh_sessions WHERE id_hash = ?").get(sha(token)) as { user_id: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    return this.user(row.user_id);
  }

  signOut(token: unknown) {
    if (typeof token === "string") this.d.db.prepare("DELETE FROM gh_sessions WHERE id_hash = ?").run(sha(token));
  }

  /** The wallet behind a holder's session token (a scout vote is cast with it). */
  walletOf(holderToken: string | null): string | null {
    return this.d.holderSession(holderToken);
  }

  /** A holder's session in the same browser links its wallet to the GitHub account (one account per wallet). */
  link(userId: number, holderToken: string | null): string | null {
    const wallet = this.d.holderSession(holderToken);
    if (!wallet) return this.user(userId)?.wallet ?? null;
    const w = wallet.toLowerCase();
    this.d.db.transaction(() => {
      this.d.db.prepare("UPDATE gh_users SET wallet = NULL WHERE wallet = ? AND id <> ?").run(w, userId);
      this.d.db.prepare("UPDATE gh_users SET wallet = ? WHERE id = ?").run(w, userId);
    })();
    return w;
  }

  async holdingOf(userId: number): Promise<Holding> {
    const w = this.user(userId)?.wallet;
    if (!w) return { holder: false, balanceWei: null };
    return this.d.holding(w).catch(() => ({ holder: false, balanceWei: null }));
  }

  repos(userId: number): string[] {
    return (this.d.db.prepare("SELECT r.full_name FROM gh_user_repos r JOIN gh_installs i ON i.id = r.install_id WHERE r.user_id = ? AND i.suspended = 0 ORDER BY lower(r.full_name)").all(userId) as { full_name: string }[]).map((r) => r.full_name);
  }

  private installFor(userId: number, repo: string): number | null {
    const r = this.d.db.prepare("SELECT r.install_id FROM gh_user_repos r JOIN gh_installs i ON i.id = r.install_id WHERE r.user_id = ? AND lower(r.full_name) = lower(?) AND i.suspended = 0").get(userId, repo) as { install_id: number } | undefined;
    return r?.install_id ?? null;
  }

  /** How many agents a holding allows: the highest tier it reaches; 1 without one. */
  allowed(h: Holding): number {
    let n = 1;
    if (h.holder && h.balanceWei != null) for (const t of this.d.config.tiers) if (h.balanceWei >= t.minWhole * WEI) n = Math.max(n, t.scouts);
    return n;
  }

  private count(sql: string, ...a: unknown[]): number {
    return (this.d.db.prepare(sql).get(...a) as { n: number }).n;
  }

  freeUsed(userId: number): number {
    return this.count("SELECT count(*) AS n FROM agent_runs WHERE user_id = ? AND billing = 'free' AND created_at >= ?", userId, dayStart(this.now()));
  }

  async me(userId: number, holderToken: string | null): Promise<MeView> {
    const u = this.user(userId);
    if (!u) throw new AgentsError(401, "not signed in");
    const wallet = this.link(userId, holderToken);
    const h = await this.holdingOf(userId);
    return {
      user: { id: u.id, login: u.login },
      wallet,
      holder: h.holder,
      repos: this.repos(userId),
      agents: this.list(userId),
      allowed: this.allowed(h),
      tiers: this.d.config.tiers.map((t) => ({ minWhole: t.minWhole.toString(), agents: t.scouts })),
      freePerDay: this.d.config.freePerDay,
      freeLeft: h.holder ? null : Math.max(0, this.d.config.freePerDay - this.freeUsed(userId)),
      paused: this.paused,
      price: { wei: this.d.config.runPriceWei.toString(), eth: ethString(this.d.config.runPriceWei), payTo: this.d.payments.payTo, open: this.d.payments.open },
      inbox: this.inbox(userId),
      installUrl: this.d.app?.installUrl ?? null,
    };
  }

  // ---- the builder ----

  private act(key: string, perHour: number, what: string) {
    this.d.db.prepare("DELETE FROM agent_acts WHERE at < ?").run(this.now() - HOUR);
    if (this.count("SELECT count(*) AS n FROM agent_acts WHERE key = ?", key) >= perHour) throw new AgentsError(429, what);
    this.d.db.prepare("INSERT INTO agent_acts (key, at) VALUES (?, ?)").run(key, this.now());
  }

  /** Plain words to a spec the person reads and confirms. The model when it can; the keyword reader otherwise. */
  async draft(userId: number, textInput: unknown): Promise<{ spec: AgentSpec; source: "model" | "template"; notes: string[] }> {
    if (typeof textInput !== "string" || textInput.trim().length < 6) throw new AgentsError(400, "Say in a few words what the agent should do.");
    const text = textInput.trim().slice(0, SPEC_LIMITS.text);
    this.act(`draft:${userId}`, this.d.config.draftsPerHour, `At most ${this.d.config.draftsPerHour} drafts an hour. Pick the jobs by hand meanwhile.`);
    const installed = this.repos(userId);
    if (this.d.provider && !this.paused) {
      try {
        const a = await ask(
          { provider: this.d.provider, budget: this.budget, model: this.d.config.model, ref: `draft:${userId}` },
          { purpose: "draft", system: draftSystem(), facts: { repos: installed }, untrusted: [{ label: "the person's words", text, max: SPEC_LIMITS.text }], schema: specSchema(installed), maxTokens: 600 },
        );
        const { unsupported, ...rest } = a.json;
        const { spec, dropped } = checkSpec(rest, installed, { strict: false });
        const notes = dropped.map((x) => `Left out: ${x}`);
        const u = typeof unsupported === "string" && unsupported.trim() ? checkText(unsupported, a.source, { max: 200, min: 4 }) : null;
        if (u?.ok) notes.push(`Not something an agent does: ${u.text}`);
        if (!installed.length) notes.push("Install the PUSHD GitHub App on a repo first, then pick it here.");
        return { spec, source: "model", notes };
      } catch {
        /* the keyword reader stands in */
      }
    }
    const t = templateSpec(text, installed);
    return { spec: t.spec, source: "template", notes: [...t.notes, "Read by the keyword reader, not a model. Check the jobs below."] };
  }

  /** Saves a new agent, or an edit (with `id`). The spec is checked again, strictly, whatever the page sent. */
  async save(userId: number, input: unknown): Promise<AgentView> {
    if (!input || typeof input !== "object") throw new AgentsError(400, "Nothing to save.");
    const i = input as Record<string, unknown>;
    let spec: AgentSpec;
    try {
      spec = checkSpec(i.spec, this.repos(userId)).spec;
    } catch (e) {
      if (e instanceof SpecError) throw new AgentsError(400, e.message);
      throw e;
    }
    const text = typeof i.text === "string" ? i.text.trim().slice(0, SPEC_LIMITS.text) : "";
    const now = this.now();
    this.act(`save:${userId}`, 60, "Too many saves this hour. Try again later.");
    if (typeof i.id === "string") {
      const r = this.d.db.prepare("UPDATE agents SET name = ?, text = ?, spec = ?, updated_at = ? WHERE id = ? AND user_id = ? AND scout IS NULL").run(spec.name, text, JSON.stringify(spec), now, i.id, userId);
      if (!r.changes) throw new AgentsError(404, "No such agent of yours.");
      return this.list(userId).find((a) => a.id === i.id)!;
    }
    const max = this.allowed(await this.holdingOf(userId));
    const have = this.count("SELECT count(*) AS n FROM agents WHERE user_id = ?", userId);
    if (have >= max) throw new AgentsError(403, max === 1 ? "You have your one agent. Edit it, or delete it to make another. Holding $PUSHD allows more." : `Your holding allows ${max} agents. Delete one, or hold more for the next tier.`);
    const id = randomBytes(8).toString("hex");
    this.d.db.prepare("INSERT INTO agents (id, user_id, name, text, spec, paused, proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)").run(id, userId, spec.name, text, JSON.stringify(spec), now, now);
    return this.list(userId).find((a) => a.id === id)!;
  }

  private view(r: AgentRow): AgentView {
    const st = this.d.db.prepare("SELECT count(*) AS n, max(created_at) AS last FROM agent_runs WHERE agent_id = ?").get(r.id) as { n: number; last: number | null };
    return { id: r.id, name: r.name, text: r.text, spec: JSON.parse(r.spec) as AgentSpec, paused: r.paused === 1, proof: r.proof === 1, createdAt: r.created_at, updatedAt: r.updated_at, runs: st.n, lastRunAt: st.last, scout: r.scout };
  }

  list(userId: number): AgentView[] {
    return (this.d.db.prepare("SELECT * FROM agents WHERE user_id = ? ORDER BY created_at").all(userId) as AgentRow[]).map((r) => this.view(r));
  }

  private agentRow(id: string): AgentRow | null {
    return (this.d.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined) ?? null;
  }

  one(userId: number, id: string): { agent: AgentView; runs: RunView[] } {
    const r = this.agentRow(id);
    if (!r || r.user_id !== userId) throw new AgentsError(404, "No such agent of yours.");
    return { agent: this.view(r), runs: this.runs({ agentId: id, limit: 60 }) };
  }

  /** Pause, the public page, or both. */
  settings(userId: number, id: string, input: unknown): AgentView {
    const i = (input ?? {}) as Record<string, unknown>;
    const r = this.agentRow(id);
    if (!r || r.user_id !== userId) throw new AgentsError(404, "No such agent of yours.");
    if (i.paused !== undefined && typeof i.paused !== "boolean") throw new AgentsError(400, "Paused is on or off.");
    if (i.proof !== undefined && typeof i.proof !== "boolean") throw new AgentsError(400, "The public page is on or off.");
    const paused = i.paused === undefined ? r.paused : i.paused ? 1 : 0;
    const proof = i.proof === undefined ? r.proof : i.proof ? 1 : 0;
    this.d.db.prepare("UPDATE agents SET paused = ?, proof = ?, updated_at = ? WHERE id = ?").run(paused, proof, this.now(), id);
    if (proof !== r.proof) this.d.db.prepare("UPDATE agent_runs SET public = ? WHERE agent_id = ? AND public <> -1").run(proof, id);
    return this.view(this.agentRow(id)!);
  }

  /** Deletes an agent. Its receipts stay (they are the record of what it did) but leave the public page. */
  remove(userId: number, id: string): { ok: true } {
    const r = this.d.db.prepare("DELETE FROM agents WHERE id = ? AND user_id = ? AND scout IS NULL").run(id, userId);
    if (!r.changes) throw new AgentsError(404, "No such agent of yours.");
    this.d.db.prepare("UPDATE agent_runs SET public = 0, status = CASE WHEN status IN ('queued', 'waiting_payment') THEN 'cancelled' ELSE status END WHERE agent_id = ?").run(id);
    this.d.db.prepare("DELETE FROM agent_schedule WHERE agent_id = ?").run(id);
    return { ok: true };
  }

  // ---- runs ----

  /**
   * A run as a trigger asks for it. Checks, in order: the agent and the job (whitelist and the agent's own spec), the
   * repo (in the agent's spec and installed by its owner), then the limits. Answers the run (queued, waiting for a
   * payment, paused, skipped) or throws for a request that cannot be made at all.
   */
  async createRun(o: { agentId: string; job: string; trigger: Trigger; repo: string; input: RunInput; origin: "webhook" | "schedule" | "request"; dedupe?: string }): Promise<RunView | null> {
    const a = this.agentRow(o.agentId);
    const req = o.origin === "request";
    const fail = (status: number, msg: string, body: Record<string, unknown> = {}) => {
      if (req) throw new AgentsError(status, msg, body);
      return null;
    };
    if (!a) return fail(404, "No such agent.");
    if (a.paused) return fail(409, "This agent is paused. Switch it on first.");
    const spec = JSON.parse(a.spec) as AgentSpec;
    const scoutJob = a.scout != null && o.job === "scout_build";
    if (!scoutJob) {
      if (!isJobId(o.job)) return fail(400, "Not a job agents do.");
      const js = spec.jobs.find((j) => j.job === o.job && (req ? JOBS[o.job as JobId].triggers.includes("request") : j.trigger === o.trigger));
      if (!js) return fail(400, req ? `This agent does not do ${JOBS[o.job as JobId].title.toLowerCase()} on request.` : "Not this agent's job.");
    }
    if (!isRepo(o.repo) || !spec.repos.some((r) => r.toLowerCase() === o.repo.toLowerCase())) return fail(400, "That repo is not one of this agent's.");
    if (!this.installFor(a.user_id, o.repo)) return fail(409, "The PUSHD GitHub App is not installed on that repo for you any more.");
    if (o.dedupe && this.d.db.prepare("SELECT 1 FROM agent_runs WHERE dedupe = ?").get(o.dedupe)) return null;
    const free = !scoutJob && JOBS[o.job as JobId].free === true;
    let status = "queued";
    let billing = free || scoutJob || a.user_id === SYSTEM_USER ? "none" : "";
    if (!free && this.paused) {
      if (req) throw new AgentsError(503, PAUSED, { paused: true });
      status = "paused";
      billing = "none";
    }
    if (!billing) {
      const h = await this.holdingOf(a.user_id);
      const since = dayStart(this.now());
      if (h.holder) {
        const hour = this.count("SELECT count(*) AS n FROM agent_runs WHERE user_id = ? AND billing = 'holder' AND created_at >= ?", a.user_id, this.now() - HOUR);
        const day = this.count("SELECT count(*) AS n FROM agent_runs WHERE user_id = ? AND billing = 'holder' AND created_at >= ?", a.user_id, since);
        if (hour >= this.d.config.holderPerHour || day >= this.d.config.holderPerDay) {
          if (req) throw new AgentsError(429, hour >= this.d.config.holderPerHour ? "That is a lot of runs this hour. Try again in a little while." : "That is a lot of runs today. They open again at 00:00 UTC.");
          status = "skipped";
          billing = "none";
        } else billing = "holder";
      } else if (this.freeUsed(a.user_id) < this.d.config.freePerDay) billing = "free";
      else {
        // past the free runs: pay for this one, or wait for tomorrow
        if (req && !this.d.payments.open) throw new AgentsError(409, `Your ${this.d.config.freePerDay} free runs for today are used. Paid runs open at launch; the free ones come back at 00:00 UTC.`);
        const waiting = this.count("SELECT count(*) AS n FROM agent_runs WHERE user_id = ? AND status = 'waiting_payment'", a.user_id);
        if (!this.d.payments.open || waiting >= 3) {
          status = "skipped";
          billing = "none";
        } else {
          status = "waiting_payment";
          billing = "paid";
        }
      }
    }
    const id = randomBytes(8).toString("hex");
    const input = JSON.stringify(this.cleanInput(o.input));
    const pub = a.proof;
    this.d.db
      .prepare("INSERT OR IGNORE INTO agent_runs (id, agent_id, user_id, job, trigger, repo, input, status, billing, created_at, public, dedupe, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.id, a.user_id, o.job, o.trigger, o.repo, input, status, billing, this.now(), pub, o.dedupe ?? null, status === "paused" ? PAUSED : status === "skipped" ? "Not run: the limit for today is reached." : null);
    const run = this.runs({ id })[0] ?? null;
    if (run && status === "waiting_payment" && req) throw new AgentsError(402, "Payment required.", { ...this.d.payments.required(`/v1/build/runs/${id}/pay`, RUN_TOOL, this.d.config.runPriceWei), runId: id });
    if (run && status === "waiting_payment") this.notify(a.user_id, id, `A run waits for payment`, `${JOBS[o.job as JobId]?.title ?? o.job} on ${o.repo}: your free runs for today are used. Pay ${ethString(this.d.config.runPriceWei)} ETH to run it, or let it lapse.`, false);
    return run;
  }

  /** The owner's own words and the numbers a run needs; nothing else is kept. */
  private cleanInput(i: RunInput): RunInput {
    const out: RunInput = {};
    if (typeof i.before === "string" && /^[0-9a-f]{40}$/.test(i.before)) out.before = i.before;
    if (typeof i.after === "string" && /^[0-9a-f]{40}$/.test(i.after)) out.after = i.after;
    if (typeof i.ref === "string" && /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(i.ref)) out.ref = i.ref;
    if (Number.isInteger(i.pr) && (i.pr as number) > 0) out.pr = i.pr;
    if (Number.isInteger(i.issue) && (i.issue as number) > 0) out.issue = i.issue;
    if (typeof i.request === "string" && i.request.trim()) out.request = maskSecrets(i.request.trim()).slice(0, SPEC_LIMITS.text);
    if (i.kind === "fix" || i.kind === "docs" || i.kind === "readme" || i.kind === "tests") out.kind = i.kind;
    return out;
  }

  /** A run on request, from the agent's page. */
  async request(userId: number, agentId: string, input: unknown): Promise<RunView> {
    const a = this.agentRow(agentId);
    if (!a || a.user_id !== userId) throw new AgentsError(404, "No such agent of yours.");
    const i = (input ?? {}) as Record<string, unknown>;
    this.act(`request:${userId}`, 60, "Too many requests this hour. Try again later.");
    const run = await this.createRun({
      agentId,
      job: String(i.job ?? ""),
      trigger: "request",
      repo: String(i.repo ?? ""),
      input: { pr: Number(i.pr) || undefined, issue: Number(i.issue) || undefined, request: typeof i.request === "string" ? i.request : undefined, kind: i.kind as RunInput["kind"] },
      origin: "request",
    });
    return run!;
  }

  /** Pays for a run that waits for a payment: an ETH transfer to the burn pot, checked on the chain. */
  async pay(userId: number, runId: string, proofInput: unknown): Promise<RunView> {
    const r = this.d.db.prepare("SELECT * FROM agent_runs WHERE id = ? AND user_id = ?").get(runId, userId) as RunRow | undefined;
    if (!r) throw new AgentsError(404, "No such run of yours.");
    if (r.status !== "waiting_payment") throw new AgentsError(409, "This run does not wait for a payment.");
    const p = (proofInput ?? {}) as { tx?: unknown; signature?: unknown };
    const lim = this.limiter.take(`pay:${userId}`, 20, 600_000);
    if (!lim.ok) throw new AgentsError(429, "Too many payment checks. Wait a few minutes.");
    let proof;
    try {
      proof = Payments.proofFrom(p.tx, p.signature);
    } catch (e) {
      if (e instanceof PaymentError) throw new AgentsError(e.status, e.message, { code: e.code });
      throw e;
    }
    if (!proof) throw new AgentsError(400, "Send the payment's transaction hash and signature.");
    if (this.paused) throw new AgentsError(503, PAUSED, { paused: true });
    let v;
    try {
      v = await this.d.payments.verifyAndClaim(proof, RUN_TOOL, this.d.config.runPriceWei);
    } catch (e) {
      if (e instanceof PaymentError) throw new AgentsError(e.status, e.message, { code: e.code });
      throw e;
    }
    this.d.db.prepare("UPDATE agent_runs SET status = 'queued', payment_tx = ? WHERE id = ? AND status = 'waiting_payment'").run(v.tx, runId);
    return this.runs({ id: runId })[0];
  }

  /** The owner approves (posts) or dismisses a reply a run drafted. */
  async approve(userId: number, runId: string, input: unknown): Promise<RunView> {
    const r = this.d.db.prepare("SELECT * FROM agent_runs WHERE id = ? AND user_id = ?").get(runId, userId) as RunRow | undefined;
    if (!r) throw new AgentsError(404, "No such run of yours.");
    const i = (input ?? {}) as { index?: unknown; post?: unknown };
    const outputs = JSON.parse(r.outputs) as Output[];
    const idx = Number(i.index);
    const o = outputs[idx];
    if (!o || o.type !== "approval" || o.state !== "waiting") throw new AgentsError(409, "Nothing waits for approval there.");
    if (i.post !== true) {
      o.state = "dismissed";
    } else {
      const inst = this.installFor(userId, r.repo);
      if (!inst || !this.d.app) throw new AgentsError(409, "The PUSHD GitHub App is not installed on that repo for you any more.");
      const repo = this.d.app.repo(inst, r.repo);
      const cm = await repo.comment(o.issue, maskSecrets(o.text)).catch((e: unknown) => {
        throw e instanceof GhAppError ? new AgentsError(e.status === 403 ? 403 : 502, e.message) : e;
      });
      this.record(r.id, r.repo, { action: "comment", url: cm.url, note: `reply on #${o.issue}, approved by the owner` });
      o.state = "posted";
      o.url = cm.url;
    }
    this.d.db.prepare("UPDATE agent_runs SET outputs = ? WHERE id = ?").run(JSON.stringify(outputs), r.id);
    return this.runs({ id: r.id })[0];
  }

  runs(q: { id?: string; agentId?: string; userId?: number; repo?: string; publicOnly?: boolean; limit?: number }): RunView[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      where.push(sql);
      args.push(v);
    };
    if (q.id) add("id = ?", q.id);
    if (q.agentId) add("agent_id = ?", q.agentId);
    if (q.userId != null) add("user_id = ?", q.userId);
    if (q.repo) add("lower(repo) = lower(?)", q.repo);
    if (q.publicOnly) where.push("public = 1 AND status = 'done'");
    const rows = this.d.db.prepare(`SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.max(1, Math.min(200, q.limit ?? 50))) as RunRow[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      job: r.job,
      jobTitle: isJobId(r.job) ? JOBS[r.job].title : r.job === "scout_build" ? "Daily build" : r.job,
      trigger: r.trigger,
      repo: r.repo,
      status: r.status,
      billing: r.billing,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      model: r.model,
      usd: Math.round(r.usd * 1e6) / 1e6,
      summary: r.summary,
      outputs: JSON.parse(r.outputs) as Output[],
      flags: JSON.parse(r.flags) as string[],
      error: r.error,
      actions: (this.d.db.prepare("SELECT action, url, note, at FROM agent_actions WHERE run_id = ? ORDER BY n").all(r.id) as { action: string; url: string | null; note: string | null; at: number }[]),
      payment: r.payment_tx ? { tx: r.payment_tx } : null,
    }));
  }

  /** One action of a run: written once, and its commit or link marked for the feed's tag. */
  record(runId: string, repo: string, a: Action) {
    this.d.db.prepare("INSERT INTO agent_actions (run_id, at, action, repo, url, sha, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(runId, this.now(), a.action, repo, a.url ?? null, a.sha ?? null, a.note ? maskSecrets(a.note).slice(0, 200) : null);
    if (a.sha && (a.action === "commit" || a.action === "merge")) this.mark(markSha(repo, a.sha), runId);
    if (a.url && (a.action === "release" || a.action === "pull_request")) this.mark(markUrl(a.url), runId);
  }

  private mark(k: string, runId: string) {
    this.d.db.prepare("INSERT OR IGNORE INTO agent_marks (k, run_id, at) VALUES (?, ?, ?)").run(k, runId, this.now());
  }

  /** Whether a feed line is something an agent shipped: a commit it made, a merge of its pull request, its release. */
  shipped(it: { url: string | null; kind: string }): boolean {
    if (!it.url) return false;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/commit\/([0-9a-f]{40})/.exec(it.url);
    const keys = m ? [markSha(m[1], m[2])] : [markUrl(it.url)];
    return keys.some((k) => !!this.d.db.prepare("SELECT 1 FROM agent_marks WHERE k = ?").get(k));
  }

  // ---- the worker ----

  /** Runs the oldest queued run, if any. One at a time. Answers whether it ran one. */
  async work(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.d.db.prepare("UPDATE agent_runs SET status = 'lapsed', summary = 'Not paid within a day.' WHERE status = 'waiting_payment' AND created_at < ?").run(this.now() - DAY);
      const r = this.d.db.prepare("SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as RunRow | undefined;
      if (!r) return false;
      await this.runOne(r);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async runOne(r: RunRow) {
    const db = this.d.db;
    db.prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?").run(this.now(), r.id);
    const finish = (status: string, patch: { summary?: string | null; outputs?: Output[]; flags?: string[]; error?: string | null; usd?: number; model?: string | null; billing?: string }) => {
      db.prepare("UPDATE agent_runs SET status = ?, finished_at = ?, summary = coalesce(?, summary), outputs = ?, flags = ?, error = ?, usd = ?, model = coalesce(?, model), billing = coalesce(?, billing) WHERE id = ?").run(
        status,
        this.now(),
        patch.summary != null ? maskSecrets(patch.summary).slice(0, 400) : null,
        JSON.stringify(patch.outputs ?? []),
        JSON.stringify(patch.flags ?? []),
        patch.error ? maskSecrets(patch.error).slice(0, 300) : null,
        patch.usd ?? 0,
        patch.model ?? null,
        patch.billing ?? null,
        r.id,
      );
    };
    const a = this.agentRow(r.agent_id);
    const owner = this.user(r.user_id) ?? (r.user_id === SYSTEM_USER ? { id: SYSTEM_USER, login: this.d.config.scoutsOrg, wallet: null } : null);
    const inst = this.installFor(r.user_id, r.repo);
    if (!a || !owner || !inst || !this.d.app) {
      finish("failed", { error: !a ? "The agent was deleted." : !this.d.app ? "The GitHub App is not set up here." : "The app is not installed on that repo any more.", billing: "none" });
      if (r.payment_tx) this.d.payments.giveBack(r.payment_tx);
      return;
    }
    const spec = JSON.parse(a.spec) as AgentSpec;
    const jobSpec = spec.jobs.find((j) => j.job === r.job) ?? { job: r.job as JobId, trigger: r.trigger as Trigger };
    const scout = SCOUT_BY_ID.get(spec.model) ?? SCOUTS[0];
    const allowMerge = a.scout != null && this.d.config.scoutAutomerge && r.repo.toLowerCase() === `${this.d.config.scoutsOrg}/pushd-scout-${a.scout}`.toLowerCase();
    const repo: RepoClient = this.d.app.repo(inst, r.repo, { allowMerge });
    let usd = 0;
    let model: string | null = null;
    const ctx: RunCtx = {
      run: { id: r.id, job: r.job as JobId, trigger: r.trigger as Trigger, repo: r.repo, input: JSON.parse(r.input) as RunInput },
      spec,
      jobSpec,
      owner: { id: owner.id, login: owner.login },
      repo,
      ask: async (o) => {
        const ans = await ask({ provider: this.d.provider, budget: this.budget, model: scout.model, ref: r.id }, o);
        usd += ans.usd;
        model = ans.model;
        return ans;
      },
      act: (x) => this.record(r.id, r.repo, x),
      outside: this.d.outside,
      proofUrl: `${this.d.siteUrl.replace(/\/+$/, "")}/shipped/${r.repo}`,
      now: this.now,
    };
    try {
      const out = r.job === "scout_build" && a.scout && this.scoutRunner ? await this.scoutRunner({ ...ctx, scout: a.scout }) : await RUNNERS[r.job as JobId](ctx);
      // a private repo's receipts never reach the public page
      const priv = await repo.meta().then((m) => m.private).catch(() => true);
      if (priv) db.prepare("UPDATE agent_runs SET public = -1 WHERE id = ?").run(r.id);
      finish("done", { summary: out.summary, outputs: out.outputs, flags: out.flags, usd, model });
      if (r.payment_tx) this.d.payments.served(r.payment_tx);
      if (r.user_id !== SYSTEM_USER) this.notify(r.user_id, r.id, `${a.name}: ${isJobId(r.job) ? JOBS[r.job].title : "run"} on ${r.repo}`, out.summary, out.outputs.some((o) => o.type === "warning"));
    } catch (e) {
      const cap = e instanceof JobError && e.kind === "cap";
      const msg = e instanceof JobError || e instanceof GhAppError ? e.message : "Something went wrong on PUSHD's side. Nothing more was changed.";
      if (!(e instanceof JobError || e instanceof GhAppError)) this.log(`run ${r.id}: ${maskSecrets(String((e as Error)?.message ?? e)).slice(0, 200)}`);
      // a run the cap stopped is not counted and not charged; a paid run that failed on our side may use its payment once more
      finish(cap ? "paused" : "failed", { error: msg, usd, model, billing: cap ? "none" : undefined, summary: cap ? PAUSED : null });
      if (r.payment_tx && (cap || !(e instanceof GhAppError))) this.d.payments.giveBack(r.payment_tx);
      else if (r.payment_tx) this.d.payments.served(r.payment_tx);
      if (r.user_id !== SYSTEM_USER && !cap) this.notify(r.user_id, r.id, `${a.name}: a run did not finish`, `${isJobId(r.job) ? JOBS[r.job].title : "Run"} on ${r.repo}: ${msg}`, false);
    }
  }

  // ---- the inbox and alerts ----

  notify(userId: number, runId: string | null, title: string, body: string, urgent: boolean) {
    const t = maskSecrets(title).slice(0, 120);
    const b = maskSecrets(body).slice(0, 400);
    this.d.db.prepare("INSERT INTO agent_inbox (user_id, run_id, at, title, body) VALUES (?, ?, ?, ?, ?)").run(userId, runId, this.now(), t, b);
    const w = this.user(userId)?.wallet;
    if (w && this.d.push?.on) {
      const agentId = runId ? (this.d.db.prepare("SELECT agent_id FROM agent_runs WHERE id = ?").get(runId) as { agent_id: string } | undefined)?.agent_id : undefined;
      void this.d.push.sendTo(w, JSON.stringify({ id: runId ?? "agents", title: t, body: b, url: agentId ? `/build/${agentId}` : "/build", tag: `pushd-agent-${runId ?? "x"}` }), urgent).catch(() => 0);
    }
  }

  inbox(userId: number, limit = 30) {
    return (this.d.db.prepare("SELECT n, run_id, at, title, body, seen FROM agent_inbox WHERE user_id = ? ORDER BY n DESC LIMIT ?").all(userId, limit) as { n: number; run_id: string | null; at: number; title: string; body: string; seen: number }[]).map((x) => ({
      n: x.n,
      runId: x.run_id,
      at: x.at,
      title: x.title,
      body: x.body,
      seen: x.seen === 1,
    }));
  }

  seen(userId: number) {
    this.d.db.prepare("UPDATE agent_inbox SET seen = 1 WHERE user_id = ?").run(userId);
  }

  // ---- the webhook ----

  /**
   * One delivery from GitHub. The signature is checked over the raw body before anything is read; a delivery id seen
   * before is answered and not handled again. Only repos an owner installed the app on, and only that owner's agents.
   */
  async webhook(headers: Record<string, string | undefined>, raw: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!verifyWebhook(this.d.config.app.webhookSecret, raw, headers["x-hub-signature-256"])) return { status: 401, body: { error: "bad signature" } };
    const id = headers["x-github-delivery"] ?? "";
    const event = headers["x-github-event"] ?? "";
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id) || !/^[a-z_]{2,40}$/.test(event)) return { status: 400, body: { error: "not a delivery" } };
    let p: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      p = JSON.parse(raw.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "not JSON" } };
    }
    const installId = Number(p.installation?.id);
    const lim = this.limiter.take(`hook:${Number.isInteger(installId) ? installId : "none"}`, this.d.config.webhooksPerMin, 60_000);
    if (!lim.ok) return { status: 429, body: { error: "too many deliveries" } };
    const first = this.d.db.prepare("INSERT OR IGNORE INTO gh_deliveries (id, event, at, outcome) VALUES (?, ?, ?, 'handling')").run(id, event, this.now()).changes === 1;
    if (!first) return { status: 200, body: { ok: true, duplicate: true } };
    this.d.db.prepare("DELETE FROM gh_deliveries WHERE at < ?").run(this.now() - 14 * DAY);
    let outcome: string;
    try {
      outcome = await this.handleEvent(event, p, installId);
    } catch (e) {
      outcome = `error: ${maskSecrets((e as Error).message).slice(0, 100)}`;
    }
    this.d.db.prepare("UPDATE gh_deliveries SET outcome = ? WHERE id = ?").run(outcome, id);
    return { status: 200, body: { ok: true, outcome } };
  }

  /** The scouts' builds (scoutbuilds.ts) run their own job through the same worker. */
  scoutRunner: ((c: RunCtx & { scout: string }) => Promise<JobResult>) | null = null;

  /** The scouts' builds (scoutbuilds.ts) hear about pushes to their own repos. */
  onScoutPush: ((p: Record<string, any>) => void) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleEvent(event: string, p: Record<string, any>, installId: number): Promise<string> {
    const db = this.d.db;
    const now = this.now();
    const botLogin = this.d.config.app.slug ? `${this.d.config.app.slug}[bot]` : null;
    const fromBot = p.sender?.type === "Bot" || (botLogin && p.sender?.login === botLogin);
    const scoutRepo = (full: string) => new RegExp(`^${this.d.config.scoutsOrg}/pushd-scout-[a-z]+$`, "i").test(full);
    if (event === "ping") return "pong";
    if (event === "installation") {
      const acc = p.installation?.account ?? {};
      if (p.action === "deleted") {
        db.prepare("DELETE FROM gh_user_repos WHERE install_id = ?").run(installId);
        db.prepare("DELETE FROM gh_installs WHERE id = ?").run(installId);
        this.d.app?.forget(installId);
        return "installation removed";
      }
      if (p.action === "suspend" || p.action === "unsuspend") {
        db.prepare("UPDATE gh_installs SET suspended = ?, updated_at = ? WHERE id = ?").run(p.action === "suspend" ? 1 : 0, now, installId);
        return `installation ${p.action}ed`;
      }
      db.prepare("INSERT INTO gh_installs (id, account, account_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account = excluded.account, updated_at = excluded.updated_at").run(installId, String(acc.login ?? ""), Number(acc.id ?? 0), now);
      this.addRepos(Number(p.sender?.id), installId, (p.repositories ?? []).map((r: { full_name: string }) => r.full_name));
      return "installation saved";
    }
    if (event === "installation_repositories") {
      for (const r of p.repositories_removed ?? []) db.prepare("DELETE FROM gh_user_repos WHERE install_id = ? AND lower(full_name) = lower(?)").run(installId, String(r.full_name));
      this.addRepos(Number(p.sender?.id), installId, (p.repositories_added ?? []).map((r: { full_name: string }) => r.full_name));
      return "repos updated";
    }
    const full = String(p.repository?.full_name ?? "");
    if (!isRepo(full) || !Number.isInteger(installId)) return "no repo";
    // only repos someone installed the app on, through this very installation
    const owners = (db.prepare("SELECT user_id FROM gh_user_repos WHERE install_id = ? AND lower(full_name) = lower(?)").all(installId, full) as { user_id: number }[]).map((x) => x.user_id);
    if (!owners.length) return "repo not installed";
    const agents = (db.prepare(`SELECT * FROM agents WHERE paused = 0 AND user_id IN (${owners.map(() => "?").join(",")})`).all(...owners) as AgentRow[]).filter((a) => (JSON.parse(a.spec) as AgentSpec).repos.some((r) => r.toLowerCase() === full.toLowerCase()));
    let n = 0;
    const start = async (a: AgentRow, job: JobId, trigger: Trigger, input: RunInput, dedupe: string) => {
      const run = await this.createRun({ agentId: a.id, job, trigger, repo: full, input, origin: "webhook", dedupe });
      if (run) n++;
    };
    if (event === "push") {
      const ref = String(p.ref ?? "");
      const after = String(p.after ?? "");
      if (p.deleted === true || !/^[0-9a-f]{40}$/.test(after) || /^0+$/.test(after)) return "nothing pushed";
      const isDefault = ref === `refs/heads/${p.repository?.default_branch}`;
      if (scoutRepo(full) && isDefault) this.onScoutPush?.(p);
      if (ref.startsWith("refs/heads/pushd/") || fromBot) return "an agent's own push";
      for (const a of agents)
        for (const j of (JSON.parse(a.spec) as AgentSpec).jobs) {
          if (j.trigger !== "push") continue;
          if (j.job !== "secret_check" && !isDefault) continue;
          await start(a, j.job, "push", { before: String(p.before ?? ""), after, ref }, `push:${a.id}:${j.job}:${after}`);
        }
      return `${n} run(s)`;
    }
    if (event === "pull_request") {
      const pr = p.pull_request ?? {};
      if (p.action === "closed" && pr.merged === true && String(pr.head?.ref ?? "").startsWith("pushd/") && /^[0-9a-f]{40}$/.test(String(pr.merge_commit_sha ?? ""))) {
        const run = db.prepare("SELECT run_id FROM agent_marks WHERE k = ?").get(markUrl(String(pr.html_url ?? ""))) as { run_id: string } | undefined;
        if (run) this.mark(markSha(full, pr.merge_commit_sha), run.run_id);
        return run ? "an agent's pull request was merged" : "merged";
      }
      if (p.action !== "opened" && p.action !== "reopened" && p.action !== "ready_for_review") return "ignored";
      if (pr.draft === true || fromBot || String(pr.head?.ref ?? "").startsWith("pushd/")) return "ignored";
      for (const a of agents) {
        if (Number(pr.user?.id) !== a.user_id) continue; // only the owner's own pull requests
        if (!(JSON.parse(a.spec) as AgentSpec).jobs.some((j) => j.job === "pr_review" && j.trigger === "pr_opened")) continue;
        await start(a, "pr_review", "pr_opened", { pr: Number(pr.number) }, `pr:${a.id}:${full}:${pr.number}:${p.action === "reopened" ? now : "open"}`);
      }
      return `${n} run(s)`;
    }
    if (event === "issues") {
      if (p.action !== "opened" || fromBot) return "ignored";
      for (const a of agents) {
        if (!(JSON.parse(a.spec) as AgentSpec).jobs.some((j) => j.job === "issue_helper" && j.trigger === "issue_opened")) continue;
        await start(a, "issue_helper", "issue_opened", { issue: Number(p.issue?.number) }, `issue:${a.id}:${full}:${p.issue?.number}`);
      }
      return `${n} run(s)`;
    }
    return "ignored";
  }

  /** Repos an installation reaches, for the person who installed it (and the scouts' account for their own repos). */
  private addRepos(senderId: number, installId: number, repos: string[]) {
    const ok = repos.filter(isRepo);
    if (Number.isInteger(senderId) && this.user(senderId)) for (const r of ok) this.d.db.prepare("INSERT OR IGNORE INTO gh_user_repos (user_id, install_id, full_name) VALUES (?, ?, ?)").run(senderId, installId, r);
    const scoutRe = new RegExp(`^${this.d.config.scoutsOrg}/pushd-scout-(claude|gpt|grok|gemini|deepseek)$`, "i");
    for (const r of ok.filter((x) => scoutRe.test(x))) this.d.db.prepare("INSERT OR IGNORE INTO gh_user_repos (user_id, install_id, full_name) VALUES (?, ?, ?)").run(SYSTEM_USER, installId, r);
  }

  // ---- schedules ----

  /** Daily and weekly jobs: the first run one period after the agent was made, then every period. */
  async schedule(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const a of this.d.db.prepare("SELECT * FROM agents WHERE paused = 0 AND scout IS NULL").all() as AgentRow[]) {
      const spec = JSON.parse(a.spec) as AgentSpec;
      for (const j of spec.jobs) {
        const period = j.trigger === "schedule_daily" ? DAY : j.trigger === "schedule_weekly" ? 7 * DAY : 0;
        if (!period) continue;
        for (const repo of spec.repos) {
          const row = this.d.db.prepare("SELECT last_at FROM agent_schedule WHERE agent_id = ? AND job = ? AND repo = ?").get(a.id, j.job, repo) as { last_at: number } | undefined;
          if (!row) {
            this.d.db.prepare("INSERT INTO agent_schedule (agent_id, job, repo, last_at) VALUES (?, ?, ?, ?)").run(a.id, j.job, repo, Math.max(a.created_at, now - period + HOUR));
            continue;
          }
          if (now - row.last_at < period) continue;
          this.d.db.prepare("UPDATE agent_schedule SET last_at = ? WHERE agent_id = ? AND job = ? AND repo = ?").run(now, a.id, j.job, repo);
          const run = await this.createRun({ agentId: a.id, job: j.job, trigger: j.trigger, repo, input: {}, origin: "schedule", dedupe: `sched:${a.id}:${j.job}:${repo}:${Math.floor(now / period)}` });
          if (run) n++;
        }
      }
    }
    return n;
  }

  /** The schedules every minute and the worker every few seconds. Returns a stop function. */
  start(o: { workMs?: number; scheduleMs?: number; extra?: () => Promise<unknown> } = {}): () => void {
    const w = setInterval(() => void this.work().catch((e) => this.log(maskSecrets(String((e as Error).message)))), o.workMs ?? 3_000);
    const s = setInterval(() => void Promise.all([this.schedule(), o.extra?.()]).catch((e) => this.log(maskSecrets(String((e as Error).message)))), o.scheduleMs ?? 60_000);
    w.unref?.();
    s.unref?.();
    return () => (clearInterval(w), clearInterval(s));
  }

  // ---- the public page of a project ----

  /** What agents shipped on one public repo: the receipts of runs on public pages, newest first. */
  shippedOn(repo: string): { repo: string; runs: RunView[]; counts: { runs: number; pullRequests: number; commits: number; releases: number; last30d: number }; reports: { at: number; text: string }[]; since: number | null } | null {
    if (!isRepo(repo)) return null;
    const runs = this.runs({ repo, publicOnly: true, limit: 100 });
    if (!runs.length) return null;
    const acts = runs.flatMap((r) => r.actions);
    const reports = runs.flatMap((r) => r.outputs.filter((o): o is Extract<Output, { type: "report" }> => o.type === "report").map((o) => ({ at: r.createdAt, text: o.text }))).slice(0, 8);
    // only what may be public: no drafts waiting for the owner, no findings, no paid details
    const clean = runs.map((r) => ({ ...r, billing: "", usd: 0, payment: null, outputs: r.outputs.filter((o) => o.type === "link" || o.type === "report"), flags: [] }));
    return {
      repo: runs[0].repo,
      runs: clean,
      counts: {
        runs: runs.length,
        pullRequests: acts.filter((a) => a.action === "pull_request").length,
        commits: acts.filter((a) => a.action === "commit").length,
        releases: acts.filter((a) => a.action === "release").length,
        last30d: runs.filter((r) => r.createdAt > this.now() - 30 * DAY).length,
      },
      reports,
      since: runs[runs.length - 1]?.createdAt ?? null,
    };
  }

  /** The open counters for the docs page. No caps, no spend. */
  stats() {
    return {
      agents: this.count("SELECT count(*) AS n FROM agents WHERE scout IS NULL"),
      runs: this.count("SELECT count(*) AS n FROM agent_runs WHERE status = 'done'"),
      pullRequests: this.count("SELECT count(*) AS n FROM agent_actions WHERE action = 'pull_request'"),
      paidRuns: this.count("SELECT count(*) AS n FROM agent_runs WHERE billing = 'paid' AND status = 'done'"),
    };
  }
}
