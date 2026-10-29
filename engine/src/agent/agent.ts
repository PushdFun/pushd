// PUSHD for AI agents: the same tools as an MCP server (Streamable HTTP, POST /mcp) and as a plain REST API
// (GET /v1/agent/<tool>), with an OpenAPI document (GET /v1/agent/openapi.json).
//
//   free, delayed like the public site:  feed, search, builder, item (with the scout's read), scouts
//   paid per call (payments.ts):          live (the feed with no delay), deep-read (a scout reads any public repo)
//
// Free tools need no key; an optional API key (X-PUSHD-Key, made at POST /v1/agent/keys) raises the rate limit. Paid
// tools answer 402 with the price, the pay-to address (the $PUSHD burn pot) and the chain id; they stay closed
// ("open at launch") until the burn pot is set. Every call is counted (agent_calls) for the public counters.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "../db.ts";
import type { ScoutConfig } from "../scouts/config.ts";
import { ScoutError, type RepoReadResult } from "../scouts/scouts.ts";
import { ROBINHOOD_CHAIN_ID } from "../token/config.ts";
import type { BuilderProfile, FeedItem, GroupKey, Heat, ScoutProfile, ScoutsView, SearchResult } from "../types.ts";
import { Gate, Limiter } from "./limits.ts";
import { ethString, PaymentError, Payments, type PaymentProof } from "./payments.ts";

export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_calls (
  at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  transport TEXT NOT NULL,
  paid INTEGER NOT NULL,
  status INTEGER NOT NULL,
  client TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_calls_at ON agent_calls(at);
CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
`;

/** What the agent tools read: the API's own views, already held to the public delay where they should be. */
export type AgentData = {
  publicDelayMinutes: number;
  feed(o: { limit: number; camp?: GroupKey; minHeat?: Heat; delayMinutes: number }): FeedItem[];
  search(q: string, limit: number): SearchResult;
  builder(handle: string): BuilderProfile | null;
  item(id: string): FeedItem | null;
  scouts(): ScoutsView | null;
  scout(id: string): ScoutProfile | null;
  /** a deep read of any public repo by a scout's model; throws ScoutError when it cannot be made */
  deepRead(repo: string): Promise<RepoReadResult>;
  deepReadOpen(): { ok: true } | { ok: false; why: string };
};

export type AgentDeps = {
  db: DB;
  data: AgentData;
  payments: Payments;
  config: ScoutConfig["agent"];
  /** the site's address, for the OpenAPI servers and the MCP origin check */
  siteUrl: string;
  now?: () => number;
};

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Schema = Record<string, unknown>;
type Paid = "live" | "deep";
type Tool = {
  name: string;
  rest: string;
  title: string;
  description: string;
  input: { properties: Record<string, Schema>; required?: string[] };
  paid: Paid | null;
  run(args: Record<string, unknown>): Promise<unknown>;
};

const CAMPS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];
const HEATS: Heat[] = ["low", "medium", "high", "veryHigh"];
const NOT_ADVICE = "Information, not advice: heat and scout calls describe public GitHub activity and are never a signal to trade.";

const int = (v: unknown, d: number, min: number, max: number, what: string) => {
  if (v === undefined || v === null || v === "") return d;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new AgentError(400, `${what} must be a whole number from ${min} to ${max}.`);
  return n;
};
const str = (v: unknown, what: string, re: RegExp, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new AgentError(400, `${what} is needed.`);
  const s = v.trim();
  if (s.length > max || !re.test(s)) throw new AgentError(400, `${what} is not valid.`);
  return s;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !list.includes(v as T)) throw new AgentError(400, `${what} must be one of: ${list.join(", ")}.`);
  return v as T;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class Agent {
  readonly tools: Tool[];
  private readonly limiter: Limiter;
  private readonly deepGate = new Gate(1, 4);

  constructor(private readonly d: AgentDeps) {
    d.db.exec(AGENT_SCHEMA);
    this.limiter = new Limiter(d.now);
    this.tools = this.makeTools();
  }

  private now = () => (this.d.now ?? Date.now)();

  private makeTools(): Tool[] {
    const data = this.d.data;
    const delay = data.publicDelayMinutes;
    return [
      {
        name: "pushd_latest",
        rest: "feed",
        title: "Latest feed (delayed)",
        description: `The newest lines of PUSHD's feed: what every crypto project on PUSHD's list just published (new repos, releases, pushes, gists), each with a plain one-line summary, a heat mark and the camp scout's call. Runs ${delay} minutes behind, like the public site. Free. ${NOT_ADVICE}`,
        input: {
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "How many lines, newest first." },
            camp: { type: "string", enum: CAMPS, description: "Only one camp of the watchlist." },
            min_heat: { type: "string", enum: HEATS, description: "Only lines at this heat or hotter." },
          },
        },
        paid: null,
        run: async (a) => ({ items: data.feed({ limit: int(a.limit, 20, 1, 50, "limit"), camp: oneOf(a.camp, CAMPS, "camp"), minHeat: oneOf(a.min_heat, HEATS, "min_heat"), delayMinutes: delay }), delayMinutes: delay, note: NOT_ADVICE }),
      },
      {
        name: "pushd_search",
        rest: "search",
        title: "Search",
        description: `Search PUSHD's feed lines and watched projects by words (repo names, handles, summaries). Public view, ${delay} minutes behind. Free.`,
        input: { properties: { q: { type: "string", minLength: 1, maxLength: 80, description: "A few words." }, limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } }, required: ["q"] },
        paid: null,
        run: async (a) => data.search(str(a.q, "q", /^[\s\S]+$/, 80), int(a.limit, 10, 1, 30, "limit")),
      },
      {
        name: "pushd_builder",
        rest: "builder",
        title: "Builder profile",
        description: "One watched builder: who they are, their camp, their recent public activity as PUSHD saw it, their latest feed lines and repos. Free.",
        input: { properties: { handle: { type: "string", pattern: "^@?[A-Za-z0-9-]{1,39}$", description: "The GitHub handle, for example aeyakovenko." } }, required: ["handle"] },
        paid: null,
        run: async (a) => {
          const p = data.builder(str(a.handle, "handle", /^@?[A-Za-z0-9-]{1,39}$/, 40).replace(/^@/, ""));
          if (!p) throw new AgentError(404, "Not on PUSHD's watchlist.");
          return {
            builder: {
              handle: p.handle,
              name: p.name ?? null,
              knownFor: p.org ?? null,
              camp: p.group,
              type: p.type,
              followers: p.followers,
              source: p.source,
              lastActiveAt: p.lastActiveAt,
              events7d: p.events7d,
              events30d: p.events30d,
              lines: p.items,
              catches: p.catches,
              latest: p.lines.slice(0, 10),
              repos: p.repos.slice(0, 10).map((r) => ({ name: r.fullName, description: r.description, language: r.language, stars: r.stars, createdAt: r.createdAt })),
            },
          };
        },
      },
      {
        name: "pushd_item",
        rest: "item",
        title: "Item with the scout's read",
        description: "One feed line by its id, with its heat signals and the camp scout's call: the line, why it matters, what the repo really is (new repos and releases) and the scout's heat call with its reason. Public view. Free.",
        input: { properties: { id: { type: "string", pattern: "^[a-z0-9-]{1,120}$", description: "The line's id, as in pushd.fun/feed/<id>." } }, required: ["id"] },
        paid: null,
        run: async (a) => {
          const it = data.item(str(a.id, "id", /^[a-z0-9-]{1,120}$/, 120));
          if (!it) throw new AgentError(404, "No such line (or it is still inside the public delay).");
          return { item: it, note: NOT_ADVICE };
        },
      },
      {
        name: "pushd_scouts",
        rest: "scouts",
        title: "Scout records",
        description: "PUSHD's five scouts (one AI agent per camp) and their public track records: calls made, model and template calls, hot calls that became catches, median time from push to call, best and worst calls. With `scout`, one scout and its latest calls. Free.",
        input: { properties: { scout: { type: "string", enum: ["claude", "gpt", "grok", "gemini", "deepseek"], description: "One scout's page." }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } } },
        paid: null,
        run: async (a) => {
          const id = oneOf(a.scout, ["claude", "gpt", "grok", "gemini", "deepseek"] as const, "scout");
          if (id) {
            const p = data.scout(id);
            if (!p) throw new AgentError(503, "The scouts are not running here.");
            return { ...p, calls: p.calls.slice(0, int(a.limit, 20, 1, 50, "limit")), note: NOT_ADVICE };
          }
          const v = data.scouts();
          if (!v) throw new AgentError(503, "The scouts are not running here.");
          return { ...v, note: NOT_ADVICE };
        },
      },
      {
        name: "pushd_live",
        rest: "live",
        title: "Live feed (paid)",
        description: `The feed with no delay: lines the moment PUSHD shows them to holders, with the scouts' calls. Paid per call in ETH; every payment goes to the $PUSHD burn pot, which buys $PUSHD and burns it. Without a payment the tool answers with the price, the pay-to address and chain id ${ROBINHOOD_CHAIN_ID}. ${NOT_ADVICE}`,
        input: {
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
            camp: { type: "string", enum: CAMPS },
            min_heat: { type: "string", enum: HEATS },
            payment: PAYMENT_ARG,
          },
        },
        paid: "live",
        run: async (a) => ({ items: data.feed({ limit: int(a.limit, 30, 1, 100, "limit"), camp: oneOf(a.camp, CAMPS, "camp"), minHeat: oneOf(a.min_heat, HEATS, "min_heat"), delayMinutes: 0 }), delayMinutes: 0, note: NOT_ADVICE }),
      },
      {
        name: "pushd_deep_read",
        rest: "deep-read",
        title: "Deep read of a repo (paid)",
        description: `A PUSHD scout reads any public GitHub repo (README, file tree, main files, within strict limits) with the stronger model and says plainly what it actually is (tool, experiment, fork, joke, docs only, unclear), why it matters and a heat call. Repo text is treated as untrusted. Paid per call in ETH to the $PUSHD burn pot. ${NOT_ADVICE}`,
        input: { properties: { repo: { type: "string", pattern: "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$", description: "owner/name" }, payment: PAYMENT_ARG }, required: ["repo"] },
        paid: "deep",
        run: async (a) => {
          const repo = str(a.repo, "repo", /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 141);
          try {
            return { read: await this.deepGate.run(() => data.deepRead(repo)), note: NOT_ADVICE };
          } catch (e) {
            if (e instanceof ScoutError) throw new AgentError(e.status, e.message);
            if ((e as Error).message === "busy") throw new AgentError(429, "Deep reads are busy. Retry in a minute with the same payment.", {}, { "retry-after": "60" });
            throw e;
          }
        },
      },
    ];
  }

  price(p: Paid): bigint {
    return p === "live" ? this.d.config.priceLiveWei : this.d.config.priceDeepWei;
  }

  // ---- clients, keys, limits, counters ----

  /** Who is calling: an API key's id, or a hash of the address (never the address itself). */
  client(req: IncomingMessage): { id: string; keyed: boolean } {
    const key = req.headers["x-pushd-key"];
    const k = Array.isArray(key) ? key[0] : key;
    if (typeof k === "string" && /^pushd_[A-Za-z0-9_-]{20,80}$/.test(k)) {
      const row = this.d.db.prepare("SELECT id FROM agent_keys WHERE key_hash = ?").get(sha(k)) as { id: string } | undefined;
      if (!row) throw new AgentError(401, "That API key is not known. Make one at POST /v1/agent/keys, or call without a key.");
      return { id: `key:${row.id}`, keyed: true };
    }
    return { id: `ip:${sha(`pushd-agent:${this.ip(req)}`).slice(0, 16)}`, keyed: false };
  }

  private ip(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "";
    const loop = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const fwd = req.headers["x-forwarded-for"];
    const f = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    return (loop || this.d.config.trustProxy) && f ? f : peer;
  }

  private limit(c: { id: string; keyed: boolean }) {
    const r = this.limiter.take(`call:${c.id}`, c.keyed ? this.d.config.keyPerMin : this.d.config.freePerMin, 60_000);
    if (!r.ok) throw new AgentError(429, `Too many calls. Wait ${r.retryAfter} s${c.keyed ? "" : ", or use a free API key for a higher limit"}.`, {}, { "retry-after": String(r.retryAfter) });
  }

  private count(tool: string, transport: "mcp" | "rest", paid: boolean, status: number, client: string) {
    this.d.db.prepare("INSERT INTO agent_calls (at, tool, transport, paid, status, client) VALUES (?, ?, ?, ?, ?, ?)").run(this.now(), tool, transport, paid ? 1 : 0, status, client);
  }

  makeKey(req: IncomingMessage, label: unknown): { key: string; id: string; note: string } {
    const c = `ip:${sha(`pushd-agent:${this.ip(req)}`).slice(0, 16)}`;
    const r = this.limiter.take(`keys:${c}`, 3, 86_400_000);
    if (!r.ok) throw new AgentError(429, "At most 3 keys a day from one address.", {}, { "retry-after": String(r.retryAfter) });
    const id = randomBytes(6).toString("hex");
    const key = `pushd_${randomBytes(24).toString("base64url")}`;
    const l = typeof label === "string" ? label.trim().replace(/[^\w .-]/g, "").slice(0, 40) || null : null;
    this.d.db.prepare("INSERT INTO agent_keys (id, key_hash, client, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, sha(key), c, l, this.now());
    return { key, id, note: "Send it as X-PUSHD-Key. It raises the free rate limit; it is never needed. It is shown once; PUSHD keeps only a hash." };
  }

  /** The public counters: agent calls, and the ETH agents sent to the burn as verified on the chain. */
  stats() {
    const now = this.now();
    const q = (sql: string, ...a: unknown[]) => this.d.db.prepare(sql).get(...a) as Record<string, number>;
    const all = q("SELECT count(*) AS n, coalesce(sum(paid), 0) AS paid FROM agent_calls WHERE status < 400");
    const day = q("SELECT count(*) AS n FROM agent_calls WHERE status < 400 AND at > ?", now - 86_400_000);
    const clients = q("SELECT count(DISTINCT client) AS n FROM agent_calls WHERE status < 400 AND at > ?", now - 30 * 86_400_000);
    const byTool = this.d.db.prepare("SELECT tool, count(*) AS n FROM agent_calls WHERE status < 400 GROUP BY tool ORDER BY n DESC").all() as { tool: string; n: number }[];
    const mcp = q("SELECT count(*) AS n FROM agent_calls WHERE status < 400 AND transport = 'mcp'");
    return {
      calls: all.n,
      calls24h: day.n,
      paidCalls: all.paid,
      mcpCalls: mcp.n,
      clients30d: clients.n,
      byTool,
      burn: this.d.payments.totals(),
      paid: this.pricing(),
      asOf: new Date(now).toISOString(),
    };
  }

  pricing() {
    return {
      open: this.d.payments.open,
      payTo: this.d.payments.payTo,
      chainId: ROBINHOOD_CHAIN_ID,
      asset: "ETH",
      tools: this.tools.filter((t) => t.paid).map((t) => ({ tool: t.name, rest: `/v1/agent/${t.rest}`, priceWei: this.price(t.paid!).toString(), priceEth: ethString(this.price(t.paid!)) })),
      limits: { freePerMinute: this.d.config.freePerMin, keyPerMinute: this.d.config.keyPerMin, paidPerHourPerWallet: this.d.config.paidPerHour, paymentMaxAgeMinutes: Math.round(this.d.config.payMaxAgeMs / 60_000) },
      note: this.d.payments.open ? "Every payment goes to the $PUSHD burn pot, which buys $PUSHD and burns it." : "Paid tools open at launch.",
    };
  }

  // ---- calling a tool ----

  /** Runs one tool for a client; paid tools check and claim the payment first. */
  async call(name: string, args: Record<string, unknown>, c: { id: string; keyed: boolean }, transport: "mcp" | "rest", proof: PaymentProof | null): Promise<{ result: unknown; payment?: { tx: string; wallet: string; valueEth: string } }> {
    const tool = this.tools.find((t) => t.name === name || t.rest === name);
    if (!tool) throw new AgentError(404, "No such tool.");
    try {
      if (!tool.paid) {
        const result = await tool.run(args);
        this.count(tool.name, transport, false, 200, c.id);
        return { result };
      }
      const out = await this.paid(tool, args, c, proof);
      this.count(tool.name, transport, true, 200, c.id);
      return out;
    } catch (e) {
      const status = e instanceof AgentError ? e.status : e instanceof PaymentError ? e.status : 500;
      this.count(tool.name, transport, !!tool.paid, status, c.id);
      throw e;
    }
  }

  private async paid(tool: Tool, args: Record<string, unknown>, c: { id: string }, proof: PaymentProof | null) {
    const p = this.d.payments;
    if (!p.open) throw new AgentError(409, "Paid tools open at launch.", { opensAtLaunch: true });
    if (tool.paid === "deep") {
      const open = this.d.data.deepReadOpen();
      if (!open.ok) throw new AgentError(503, open.why);
    }
    const price = this.price(tool.paid!);
    if (!proof) throw new AgentError(402, "Payment required.", p.required(`/v1/agent/${tool.rest}`, tool.name, price), { "x-pushd-payment-required": "pushd-burn/1" });
    const tries = this.limiter.take(`pay:${c.id}`, 20, 600_000);
    if (!tries.ok) throw new AgentError(429, "Too many payment checks. Wait a few minutes.", {}, { "retry-after": String(tries.retryAfter) });
    const v = await p.verifyAndClaim(proof, tool.name, price);
    if (p.paidInHour(v.wallet) > this.d.config.paidPerHour) {
      p.giveBack(v.tx);
      throw new AgentError(429, `At most ${this.d.config.paidPerHour} paid calls an hour per wallet. The payment can be used once more later.`);
    }
    try {
      const result = await tool.run(args);
      p.served(v.tx);
      return { result, payment: { tx: v.tx, wallet: v.wallet, valueEth: ethString(v.valueWei) } };
    } catch (e) {
      p.giveBack(v.tx);
      throw e;
    }
  }

  // ---- the routes ----

  /** Handles /mcp and /v1/agent/*. Answers false when the path is not the agent API's. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL, readBody: (max: number) => Promise<unknown>): Promise<boolean> {
    if (path === "/mcp") return (await this.mcp(req, res, readBody), true);
    if (!path.startsWith("/v1/agent")) return false;
    const m = req.method ?? "GET";
    const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      if (path === "/v1/agent/openapi.json") return (sendJson(200, openApi(this, this.d.siteUrl)), true);
      if (path === "/v1/agent/stats") return (sendJson(200, this.stats()), true);
      if (path === "/v1/agent/pricing") return (sendJson(200, this.pricing()), true);
      if (path === "/v1/agent/tools") return (sendJson(200, { tools: this.tools.map((t) => ({ name: t.name, rest: `/v1/agent/${t.rest}`, title: t.title, description: t.description, paid: !!t.paid })) }), true);
      if (path === "/v1/agent/keys" && m === "POST") {
        const b = (await readBody(2048)) as Record<string, unknown>;
        return (sendJson(201, this.makeKey(req, b?.label)), true);
      }
      const tm = /^\/v1\/agent\/([a-z-]+)$/.exec(path);
      if (!tm) throw new AgentError(404, "No such tool. See /v1/agent/openapi.json.");
      if (m !== "GET" && m !== "HEAD") throw new AgentError(405, "GET only.");
      const c = this.client(req);
      this.limit(c);
      const args: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
      const h = (n: string) => {
        const v = req.headers[n];
        return Array.isArray(v) ? v[0] : v;
      };
      const proof = Payments.proofFrom(h("x-pushd-payment-tx"), h("x-pushd-payment-signature"));
      const out = await this.call(tm[1], args, c, "rest", proof);
      sendJson(200, out.payment ? { ...(out.result as object), payment: out.payment } : out.result);
    } catch (e) {
      if (e instanceof AgentError) sendJson(e.status, { error: e.message, ...e.body }, e.headers);
      else if (e instanceof PaymentError) sendJson(e.status, { error: e.message, code: e.code });
      else throw e;
    }
    return true;
  }

  private allowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      const o = new URL(origin);
      if (o.hostname === "localhost" || o.hostname === "127.0.0.1") return true;
      return o.host === new URL(this.d.siteUrl).host;
    } catch {
      return false;
    }
  }

  /** MCP over Streamable HTTP: JSON-RPC 2.0 in a POST, one JSON answer back (no server-sent stream is offered). */
  private async mcp(req: IncomingMessage, res: ServerResponse, readBody: (max: number) => Promise<unknown>) {
    const base = { "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    const origin = req.headers.origin;
    if (!this.allowedOrigin(typeof origin === "string" ? origin : undefined)) {
      res.writeHead(403, { ...base, "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed." } }));
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...base, "access-control-allow-methods": "POST, GET, DELETE", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, x-pushd-key" });
      return res.end();
    }
    if (req.method !== "POST") {
      res.writeHead(405, { ...base, allow: "POST", "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "POST JSON-RPC messages to this endpoint. This server offers no server-sent stream." } }));
    }
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let c: { id: string; keyed: boolean };
    try {
      c = this.client(req);
      this.limit(c);
    } catch (e) {
      const ae = e as AgentError;
      return reply(ae.status ?? 429, { jsonrpc: "2.0", id: null, error: { code: -32000, message: ae.message } }, ae.headers ?? {});
    }
    let msg: unknown;
    try {
      msg = await readBody(65_536);
    } catch {
      return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const batch = Array.isArray(msg);
    const list = (batch ? msg : [msg]) as unknown[];
    if (!list.length || list.length > 20) return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    const answers: unknown[] = [];
    for (const one of list) {
      const a = await this.rpc(one, c);
      if (a) answers.push(a);
    }
    if (!answers.length) return reply(202, undefined);
    reply(200, batch ? answers : answers[0]);
  }

  private async rpc(m: unknown, c: { id: string; keyed: boolean }): Promise<unknown | null> {
    if (!m || typeof m !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
    const r = m as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const isNote = r.id === undefined;
    if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return isNote ? null : { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32600, message: "Invalid request." } };
    if (isNote) return null; // notifications/initialized and the like: nothing to answer
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
    const fail = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: r.id, error: { code, message, ...(data ? { data } : {}) } });
    switch (r.method) {
      case "initialize": {
        const asked = typeof r.params?.protocolVersion === "string" ? r.params.protocolVersion : "";
        return ok({
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pushd", title: "PUSHD", version: "1.0.0" },
          instructions: `PUSHD watches the public GitHub activity of every crypto token project it finds with a live market and code pushed in the last 30 days (a list ranked every hour; GET /v1/top). Free tools run ${this.d.data.publicDelayMinutes} minutes behind. pushd_live and pushd_deep_read are paid per call in ETH to the $PUSHD burn pot: call them without a payment to get the price, pay, then call again with payment {tx, signature}. ${NOT_ADVICE}`,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: this.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: { type: "object", properties: t.input.properties, ...(t.input.required ? { required: t.input.required } : {}), additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: !t.paid },
          })),
        });
      case "tools/call": {
        const name = r.params?.name;
        const args = (r.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== "string" || !this.tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name).slice(0, 40)}`);
        if (typeof args !== "object" || Array.isArray(args)) return fail(-32602, "arguments must be an object");
        try {
          const pay = args.payment as { tx?: unknown; signature?: unknown } | undefined;
          const proof = pay ? Payments.proofFrom(pay.tx, pay.signature) : null;
          const { payment: _drop, ...rest } = args;
          void _drop;
          const out = await this.call(name, rest, c, "mcp", proof);
          const structured = out.payment ? { ...(out.result as object), payment: out.payment } : (out.result as object);
          return ok({ content: [{ type: "text", text: JSON.stringify(structured, null, 1) }], structuredContent: structured, isError: false });
        } catch (e) {
          if (e instanceof AgentError || e instanceof PaymentError) {
            const body = e instanceof AgentError ? { error: e.message, status: e.status, ...e.body } : { error: e.message, status: e.status, code: e.code };
            const text = e.status === 402 && e instanceof AgentError ? `Payment required: send ${String(e.body.priceEth)} ETH to ${String(e.body.payTo)} on chain ${ROBINHOOD_CHAIN_ID}, sign "PUSHD payment <tx hash>" with the paying wallet, then call again with payment {tx, signature}. ${JSON.stringify(body)}` : JSON.stringify(body);
            return ok({ content: [{ type: "text", text }], structuredContent: body, isError: true });
          }
          return fail(-32603, "Internal error.");
        }
      }
      default:
        return fail(-32601, `Method not found: ${r.method.slice(0, 60)}`);
    }
  }
}

export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PAYMENT_ARG: Schema = {
  type: "object",
  description: "For a paid call: the hash of an ETH transfer to the burn pot and the paying wallet's personal_sign over the text: PUSHD payment <tx hash in lower case>.",
  properties: { tx: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" } },
  required: ["tx", "signature"],
};

/** The OpenAPI 3.1 document for the REST side, from the same tool list. */
export function openApi(agent: Agent, siteUrl: string) {
  const paths: Record<string, unknown> = {};
  for (const t of agent.tools) {
    const params = Object.entries(t.input.properties)
      .filter(([k]) => k !== "payment")
      .map(([k, s]) => ({ name: k, in: "query", required: t.input.required?.includes(k) ?? false, schema: s, ...(s.description ? { description: s.description } : {}) }));
    const paid = t.paid
      ? [
          { name: "X-PUSHD-Payment-Tx", in: "header", required: false, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, description: "The hash of an ETH transfer of at least the price to the burn pot." },
          { name: "X-PUSHD-Payment-Signature", in: "header", required: false, schema: { type: "string" }, description: "The paying wallet's personal_sign over: PUSHD payment <tx hash in lower case>." },
        ]
      : [];
    paths[`/${t.rest}`] = {
      get: {
        operationId: t.name,
        summary: t.title,
        description: t.description,
        parameters: [...params, ...paid, { name: "X-PUSHD-Key", in: "header", required: false, schema: { type: "string" }, description: "Optional API key: a higher rate limit." }],
        responses: {
          "200": { description: "The answer, as JSON." },
          "400": { description: "A parameter is not valid." },
          ...(t.paid
            ? {
                "402": { description: `Payment required: the body states the price in ETH (${ethString(agent.price(t.paid))} now), payTo (the $PUSHD burn pot) and chainId ${ROBINHOOD_CHAIN_ID}.` },
                "409": { description: "Paid tools are not open yet (they open at launch), or the payment was already used." },
              }
            : {}),
          "429": { description: "Too many calls; see Retry-After." },
        },
      },
    };
  }
  paths["/keys"] = { post: { operationId: "make_key", summary: "Make a free API key", description: "An optional key for a higher free rate limit. Shown once.", responses: { "201": { description: "{ key, id }" } } } };
  paths["/stats"] = { get: { operationId: "stats", summary: "Agent calls and ETH sent to the burn by agents", responses: { "200": { description: "Counters." } } } };
  paths["/pricing"] = { get: { operationId: "pricing", summary: "Prices, pay-to address and chain id", responses: { "200": { description: "Pricing." } } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "PUSHD for agents",
      version: "1.0.0",
      description: `What every crypto project that keeps shipping publishes on GitHub, with PUSHD's scouts' calls. Free tools run behind the live feed; paid tools are paid per call in ETH to the $PUSHD burn pot (chain id ${ROBINHOOD_CHAIN_ID}), which buys $PUSHD and burns it. ${NOT_ADVICE}`,
    },
    servers: [{ url: `${siteUrl.replace(/\/+$/, "")}/api/agent` }],
    paths,
  };
}
