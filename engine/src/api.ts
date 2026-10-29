// The feed API, on node:http. It answers in the website's shapes (src/types.ts), newest first.
//   GET /v1/feed            { items }   ?group= ?heat= (that heat and up) ?person= ?limit=
//   GET /v1/feed/:id        { item }    404 when there is no such line, or it is still inside the delay
//   GET /v1/watchlist       { groups }   ?all=1 lists every member, not just the first few
//   GET /v1/stats           Stats
//   GET /v1/catches         { items }   the catches log: high heat and up, kept for good
//   GET /v1/stream          server-sent events, one `item` event per new line
//   GET /v1/media/:id       a repo's preview picture (src/media.ts), cached for a year; a line's mediaUrl points here
//   GET /v1/feed/:id/more   { more }   the repo's facts, README lines, commits, the builder's other lines (src/enrich.ts)
//   GET /v1/pulse           Pulse      the watchlist's activity added up: hours, days, groups, leaders (src/insights.ts)
//   GET /v1/builders        { builders }   every watched account with what PUSHD has seen of it
//   GET /v1/builders/:handle { builder }  one account's page; 404 when it is not on the watchlist
//   GET /v1/search?q=       { items, builders }
//   GET /v1/days            { days }   the last 84 days with activity, newest first (src/days.ts)
//   GET /v1/day/:date       DayDetail  one day: every own event, the lines, by group and hour; 400 on a bad date
//   GET /v1/avatar/:handle  a watched account's GitHub picture (src/avatars.ts), cached for a day
//   GET /health             the watcher's last poll and the rate limit
//   GET /v1/token           $PUSHD as the site's /token page shows it (src/token/panel.ts): soon, deployed or live
//   POST /v1/holders/challenge   { address }                   -> { message, nonce, expiresAt }   (src/token/holders.ts)
//   POST /v1/holders/session     { address, nonce, signature } -> { session, expiresAt, status }  403 under the threshold
//   GET /v1/holders/me           Bearer session -> { status, prefs, expiresAt }
//   PUT /v1/holders/prefs        Bearer session, { follow, mute, alertHeat, alertMine } -> { prefs }
//   DELETE /v1/holders/session   Bearer session -> 204
//   GET /v1/holders/push/key     the VAPID public key for web push (src/push.ts); 409 while push is not switched on
//   PUT /v1/holders/push         Bearer session, a browser's push subscription -> { ok, devices }  403 under the threshold
//   DELETE /v1/holders/push      Bearer session, { endpoint? } -> { ok }   one device, or all of them
//   GET /v1/scouts               ScoutsView   the five scouts and their records (src/scouts)
//   GET /v1/scouts/:id           { scout: ScoutProfile }   one scout, its record and its latest calls
//   GET /v1/holders/scouts       Bearer session -> the holder's own scouts, how many the holding allows
//   POST /v1/holders/scouts/draft    { text } -> a rule drafted from plain words (model or template)
//   POST /v1/holders/scouts/preview  { rule } -> what the rule would have matched lately (no model)
//   POST /v1/holders/scouts          { id?, name, text, rule } -> { scout }   save new, or an edit
//   DELETE /v1/holders/scouts/:id    -> { ok }
//   GET /v1/holders/scouts/hits      ?after= ?limit= -> { hits }   the "my scout" inbox
//   POST /mcp, GET /v1/agent/*   PUSHD for AI agents: MCP and REST, free and paid tools (src/agent)
//   GET /v1/top                  TopView      the Top N most active token projects, movement, breakdown (src/rank)
//   GET /v1/top/:handle          { project: ProjectRank }   one project's place; 404 outside the pool
//   GET /v1/lookup?q=            LookupResult the watched first, then anything on GitHub (src/lookup.ts)
//   GET /v1/gh/users/:login      { page: GhUserPage } or { redirect }   any account; 404; 503 busy with retryInSec
//   GET /v1/gh/repos/:owner/:name      { page: GhRepoPage }   any public repo (Bearer optional: the holder's reads)
//   POST /v1/gh/repos/:owner/:name/read { read, allowance }   a scout reads it, within the day's allowances
//   GET|POST /v1/holders/watch, DELETE /v1/holders/watch/:login   a holder's added accounts (src/holderwatch.ts)
//   POST /v1/suggestions         { login, camp, why } -> { ok, already, message }   (src/suggest.ts)
//   GET /v1/admin/suggestions, POST /v1/admin/suggestions/:id, GET /v1/admin/status   x-pushd-admin-key only
//   /v1/build/*                  PUSHD Agents (src/agents/routes.ts): only with PUSHD_AGENTS=on, otherwise 404
// Every list runs the public delay (5 minutes) by default. ?delay=0 (or any delay under the public one) needs either
// the x-pushd-live-key header matching PUSHD_LIVE_KEY, or `Authorization: Bearer <session>` for a signed-in wallet that
// holds $PUSHD at the threshold right now; without one the answer is 401.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Avatars } from "./avatars.ts";
import type { Push } from "./push.ts";
import { Days, validDay } from "./days.ts";
import { Enricher } from "./enrich.ts";
import { Insights } from "./insights.ts";
import { mediaFile, mediaUrlFor } from "./media.ts";
import { getItemById, isHidden, getMeta, itemsAfterSeq, lastSeqShownBy, queryCatches, queryItems, toFeedItem, totalCost, type DB, type StoredItem } from "./db.ts";
import { scrub } from "./token/chain.ts";
import { tokenConfigFromEnv } from "./token/config.ts";
import { HolderError } from "./token/holders.ts";
import type { TokenServices } from "./token/local.ts";
import type { TokenPanel } from "./token/panel.ts";
import type { FeedItem, GroupKey, Heat, Stats, WatchEntry, WatchGroup } from "./types.ts";
import { Agent } from "./agent/agent.ts";
import type { Payments } from "./agent/payments.ts";
import type { ScoutConfig } from "./scouts/config.ts";
import { MyScoutError, type MyScouts } from "./scouts/myscouts.ts";
import { ScoutError, type Scouts } from "./scouts/scouts.ts";
import { WatchError, type HolderWatch } from "./holderwatch.ts";
import { LookupError, type Lookup } from "./lookup.ts";
import { schedulePlan } from "./plan.ts";
import type { Ranker } from "./rank/ranker.ts";
import type { BuildServices } from "./agents/index.ts";
import { whoOf } from "./registry.ts";
import { adminOk, SuggestError, type Suggestions } from "./suggest.ts";
import { sourceCalls } from "./rank/store.ts";
import { spendSince } from "./db.ts";

export type ApiOptions = {
  db: DB;
  /** everyone known by name (a live list: src/registry.ts) */
  accounts: WatchEntry[];
  /** the watched list now: the Top N (a live list); defaults to `accounts` */
  top?: WatchEntry[];
  /** the ranking's views; without it /v1/top answers 503 */
  ranker?: Ranker | null;
  /** look up anyone; without it /v1/lookup and /v1/gh answer 503 */
  lookup?: Lookup | null;
  /** holders' added accounts */
  holderWatch?: HolderWatch | null;
  suggestions?: Suggestions | null;
  /** x-pushd-admin-key; the admin routes answer 404 without one */
  adminKey?: string | null;
  /** GitHub requests are made with a token (the schedule the site shows) */
  authenticated?: boolean;
  publicDelayMinutes: number;
  liveKey: string | null;
  now?: () => number;
  /** how often the stream looks for new lines */
  streamTickMs?: number;
  /** where the preview pictures are (data/media); without it /v1/media answers 404 and no line has a mediaUrl */
  mediaDir?: string;
  /** $PUSHD: the token panel and holder sign-in. Without it /v1/token says "soon" and holder sign-in is closed. */
  token?: TokenServices;
  /** fetches what an item's page is missing; without it the page gets stored data only */
  enricher?: Enricher | null;
  /** the watched accounts' pictures; without it /v1/avatar answers 404 */
  avatars?: Avatars | null;
  /** web push for holders (src/push.ts); without it the push routes answer 409 */
  push?: Push | null;
  /** the five scouts (src/scouts); without them no line carries a call and /v1/scouts answers 503 */
  scouts?: Scouts | null;
  /** holders' own scouts; made here (they need the API's item shape) when scouts and token are given */
  myScouts?: ((toItem: (it: StoredItem) => FeedItem) => MyScouts) | null;
  /** PUSHD for AI agents (src/agent): MCP, REST and pay per call; without it /mcp and /v1/agent answer 404 */
  agent?: { payments: Payments; config: ScoutConfig["agent"]; siteUrl: string } | null;
  /** PUSHD Agents (src/agents): anyone's own agent on GitHub; null (every /v1/build route a 404) unless switched on */
  build?: Pick<BuildServices, "routes" | "shipped"> | null;
};

const GROUPS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];
const GROUP_ALIASES: Record<string, GroupKey> = { "ai-labs": "ai", "open-source": "oss", robinhood: "chain", "base-evm": "wallets", solana: "launchpads", "ai-agents": "ai", tools: "oss" };
const HEATS: Record<string, Heat> = { low: "low", medium: "medium", high: "high", veryhigh: "veryHigh", "very-high": "veryHigh", vhigh: "veryHigh" };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Is this key the live key? Constant time, and never when no key is set. */
export function liveKeyOk(given: string | undefined | null, expected: string | null): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The delay this request runs at, in minutes: the public one, unless a valid live key asks for less. */
export function delayFor(param: string | null, keyHeader: string | undefined, o: Pick<ApiOptions, "publicDelayMinutes" | "liveKey">): number {
  if (param == null || param === "") return o.publicDelayMinutes;
  const d = Number(param);
  if (!Number.isFinite(d) || d < 0) throw new HttpError(400, "delay must be a number of minutes");
  if (d >= o.publicDelayMinutes) return d;
  if (!liveKeyOk(keyHeader, o.liveKey)) throw new HttpError(401, "a shorter delay than the public one needs a live key");
  return d;
}

/** How many handles each group shows by name; the rest are counted ("+19 more"), as the site draws it. */
export const MEMBERS_SHOWN = 8;

export function watchGroups(accounts: WatchEntry[], shown = MEMBERS_SHOWN): WatchGroup[] {
  return GROUPS.map((g) => {
    const all = accounts.filter((a) => a.group === g);
    const members = all.slice(0, shown).map((a) => ({ handle: a.handle, name: a.name, org: a.org, group: a.group, sample: false, ...(a.token ? { token: a.token } : {}) }));
    return { group: g, count: all.length, members };
  });
}

export function createApi(o: ApiOptions): Server {
  const now = o.now ?? Date.now;
  const top = o.top ?? o.accounts;
  const feedItem = (it: StoredItem): FeedItem => {
    const a = whoOf(o.accounts).get(it.handle.toLowerCase());
    // an org's name is enough; "what they are known for" only when it says something more
    const f = toFeedItem(it, a ? { name: a.name, org: a.org !== a.name ? a.org : undefined } : undefined, o.mediaDir ? mediaUrlFor(o.db, it) : null);
    const call = o.scouts?.callOf(it.id);
    const withToken = a?.token ? { ...f, token: a.token } : f;
    // shipped with a PUSHD agent: a commit, a merge or a release an agent made
    const tagged = o.build?.shipped(it) ? { ...withToken, agent: true } : withToken;
    return call ? { ...tagged, call } : tagged;
  };
  const myScouts = o.myScouts ? o.myScouts(feedItem) : null;
  const cutoff = (delayMin: number) => new Date(now() - delayMin * 60_000).toISOString();
  const insights = new Insights({ db: o.db, accounts: top, known: o.accounts, toItem: feedItem, now });
  const days = new Days({ db: o.db, accounts: top, known: o.accounts, toItem: feedItem });
  const enricher = o.enricher ?? new Enricher({ db: o.db, enabled: false, now });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  };

  const bearerOf = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    return m ? m[1] : null;
  };

  /** The delay a request runs at: the public one, or less with the live key or a holder's session. */
  const delayOf = async (req: IncomingMessage, param: string | null, keyHeader: string | undefined): Promise<number> => {
    try {
      return delayFor(param, keyHeader, o);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      const bearer = bearerOf(req);
      if (bearer && o.token && (await o.token.holders.liveAllowed(bearer))) return Number(param);
      throw new HttpError(401, "a shorter delay than the public one needs a live key or a holder's sign-in");
    }
  };

  const soonPanel = (): TokenPanel => {
    const c = tokenConfigFromEnv({});
    return { stage: "soon", token: null, pot: null, explorer: c.explorer, supply: null, launchSupply: null, burned: null, ethSpent: null, count: 0, latest: [], next: null, lastBurnAt: null, startedAt: null, holderMin: c.holder.minWhole, readAt: now(), stale: false, problem: null };
  };

  /** A JSON body of at most 8 KB (or `max`). */
  const anyBody = (req: IncomingMessage, max = 8192): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          reject(new HttpError(413, "too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => {
        try {
          resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {});
        } catch {
          reject(new HttpError(400, "the body is not JSON"));
        }
      });
      req.on("error", reject);
    });
  const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const v = await anyBody(req);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };

  // PUSHD for AI agents: the same views as the site, through the tools
  const agent = o.agent
    ? new Agent({
        db: o.db,
        payments: o.agent.payments,
        config: o.agent.config,
        siteUrl: o.agent.siteUrl,
        now,
        data: {
          publicDelayMinutes: o.publicDelayMinutes,
          feed: (x) => queryItems(o.db, { shownBefore: cutoff(x.delayMinutes), group: x.camp, minHeat: x.minHeat, limit: x.limit }).map(feedItem),
          search: (text, limit) => insights.search(text, cutoff(o.publicDelayMinutes), limit),
          builder: (handle) => insights.profile(handle, cutoff(o.publicDelayMinutes)),
          item: (id) => {
            const it = getItemById(o.db, id);
            return it && it.shownAt <= cutoff(o.publicDelayMinutes) ? feedItem(it) : null;
          },
          scouts: () => o.scouts?.view(cutoff(o.publicDelayMinutes)) ?? null,
          scout: (id) => o.scouts?.profile(id, cutoff(o.publicDelayMinutes), feedItem) ?? null,
          deepRead: (repo) => {
            if (!o.scouts) throw new ScoutError(503, "The scouts are not running here.");
            return o.scouts.readOnDemand(repo);
          },
          deepReadOpen: () => (o.scouts ? o.scouts.deepReadOpen() : { ok: false, why: "The scouts are not running here." }),
        },
      })
    : null;

  /** The holder routes. Answers true when it handled the request. */
  const holderRoutes = async (req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> => {
    if (!p.startsWith("/v1/holders/")) return false;
    const m = req.method ?? "GET";
    const h = o.token?.holders;
    if (!h) throw new HttpError(409, "Holder sign-in opens at launch, once $PUSHD exists.");
    if (p === "/v1/holders/challenge" && m === "POST") {
      const b = await body(req);
      return (send(res, 200, await h.challenge(b.address)), true);
    }
    if (p === "/v1/holders/session" && m === "POST") {
      const b = await body(req);
      return (send(res, 200, await h.signIn(b.address, b.nonce, b.signature)), true);
    }
    const pushOff = () => new HttpError(409, "Alerts with PUSHD closed are not switched on yet.");
    if (p === "/v1/holders/push/key" && (m === "GET" || m === "HEAD")) {
      if (!o.push?.on) throw pushOff();
      return (send(res, 200, { key: o.push.key() }), true);
    }
    const s = h.session(bearerOf(req));
    if (p === "/v1/holders/session" && m === "DELETE") {
      h.signOut(bearerOf(req));
      res.writeHead(204, { "cache-control": "no-store" });
      return (res.end(), true);
    }
    if (!s) throw new HttpError(401, "not signed in");
    if (p === "/v1/holders/me" && (m === "GET" || m === "HEAD")) return (send(res, 200, { status: await h.status(s.address), prefs: h.prefs(s.address), expiresAt: s.expiresAt }), true);
    if (p === "/v1/holders/prefs" && m === "PUT") return (send(res, 200, { prefs: h.setPrefs(s.address, await body(req)) }), true);
    if (p === "/v1/holders/push" && m === "PUT") {
      if (!o.push?.on) throw pushOff();
      const b = await body(req);
      if (!(await h.status(s.address)).holder) throw new HttpError(403, "Alerts need a wallet that holds $PUSHD.");
      return (send(res, 200, o.push.subscribe(s.address, b)), true);
    }
    if (p === "/v1/holders/push" && m === "DELETE") {
      const b = await body(req);
      return (send(res, 200, o.push ? o.push.unsubscribe(s.address, b.endpoint) : { ok: true }), true);
    }
    if (p === "/v1/holders/watch" || p.startsWith("/v1/holders/watch/")) {
      const hw = o.holderWatch;
      if (!hw) throw new HttpError(409, "Watching any account is not switched on here.");
      const st = await h.status(s.address);
      const balance = st.balanceWei == null ? null : BigInt(st.balanceWei);
      if (!st.holder) throw new HttpError(403, "Watching any account needs a wallet that holds $PUSHD.");
      if (p === "/v1/holders/watch" && (m === "GET" || m === "HEAD")) return (send(res, 200, hw.view(s.address, balance)), true);
      if (p === "/v1/holders/watch" && m === "POST") return (send(res, 200, await hw.add(s.address, balance, (await body(req)).login, o.lookup?.visitor(req) ?? "site")), true);
      const one = /^\/v1\/holders\/watch\/([A-Za-z0-9-]{1,39})$/.exec(p);
      if (one && m === "DELETE") return (send(res, 200, hw.remove(s.address, balance, one[1])), true);
      throw new HttpError(404, "not found");
    }
    if (p === "/v1/holders/scouts" || p.startsWith("/v1/holders/scouts/")) {
      if (!myScouts) throw new HttpError(409, "Your own scouts are not switched on here.");
      const st = await h.status(s.address);
      const balance = st.balanceWei == null ? null : BigInt(st.balanceWei);
      if (!st.holder) throw new HttpError(403, "Your own scouts need a wallet that holds $PUSHD.");
      if (p === "/v1/holders/scouts" && (m === "GET" || m === "HEAD")) {
        const list = myScouts.list(s.address);
        return (send(res, 200, { scouts: list, allowed: myScouts.allowed(balance), tiers: myScouts.tiers(), mode: o.scouts?.mode ?? "template" }), true);
      }
      if (p === "/v1/holders/scouts/draft" && m === "POST") return (send(res, 200, await myScouts.draft(s.address, (await body(req)).text)), true);
      if (p === "/v1/holders/scouts/preview" && m === "POST") return (send(res, 200, myScouts.preview((await body(req)).rule, new Date(now()).toISOString(), 200, s.address)), true);
      if (p === "/v1/holders/scouts" && m === "POST") return (send(res, 200, { scout: myScouts.save(s.address, balance, await body(req)) }), true);
      if (p === "/v1/holders/scouts/hits" && (m === "GET" || m === "HEAD")) {
        const u = new URL(req.url ?? "/", "http://engine").searchParams;
        const after = Number(u.get("after") ?? 0);
        const limit = Number(u.get("limit") ?? 50);
        return (send(res, 200, { hits: myScouts.hits(s.address, { after: Number.isInteger(after) && after >= 0 ? after : 0, limit: Number.isInteger(limit) ? limit : 50 }) }), true);
      }
      const one = /^\/v1\/holders\/scouts\/([a-f0-9]{16})$/.exec(p);
      if (one && m === "DELETE") return (send(res, 200, myScouts.remove(s.address, one[1])), true);
    }
    throw new HttpError(404, "not found");
  };

  const admin = (req: IncomingMessage) => {
    const k = req.headers["x-pushd-admin-key"];
    if (!adminOk(Array.isArray(k) ? k[0] : k, o.adminKey ?? null)) throw new HttpError(404, "not found");
  };

  /** The Top N, lookups, suggestions and the admin routes. True when it handled the request. */
  const moreRoutes = async (req: IncomingMessage, res: ServerResponse, p: string, q: URLSearchParams): Promise<boolean> => {
    const m = req.method ?? "GET";
    if (p === "/v1/top" && (m === "GET" || m === "HEAD")) {
      if (!o.ranker) throw new HttpError(503, "The ranking is not running here.");
      return (send(res, 200, o.ranker.top()), true);
    }
    const tp = /^\/v1\/top\/([A-Za-z0-9-]{1,39})$/.exec(p);
    if (tp && (m === "GET" || m === "HEAD")) {
      if (!o.ranker) throw new HttpError(503, "The ranking is not running here.");
      const project = o.ranker.project(tp[1]);
      if (!project) throw new HttpError(404, "not in the pool");
      return (send(res, 200, { project }), true);
    }
    if (p === "/v1/lookup" || p.startsWith("/v1/gh/")) {
      const lk = o.lookup;
      if (!lk) throw new HttpError(503, "Lookups are not running here.");
      const visitor = lk.visitor(req);
      const holder = o.token?.holders.session(bearerOf(req))?.address ?? null;
      if (p === "/v1/lookup" && m === "GET") {
        const text = (q.get("q") ?? "").slice(0, 80);
        return (send(res, 200, await lk.search(text, visitor, (t) => insights.search(t, cutoff(o.publicDelayMinutes), 12))), true);
      }
      const u = /^\/v1\/gh\/users\/([^/]+)$/.exec(p);
      if (u && m === "GET") return (send(res, 200, await lk.user(decodeURIComponent(u[1]), visitor)), true);
      const r = /^\/v1\/gh\/repos\/([^/]+)\/([^/]+)$/.exec(p);
      if (r && m === "GET") return (send(res, 200, await lk.repo(decodeURIComponent(r[1]), decodeURIComponent(r[2]), visitor, holder)), true);
      const rd = /^\/v1\/gh\/repos\/([^/]+)\/([^/]+)\/read$/.exec(p);
      if (rd && m === "POST") {
        // a holder's reads count only while the wallet still holds at the threshold
        const h = holder && o.token && (await o.token.holders.status(holder)).holder ? holder : null;
        return (send(res, 200, await lk.read(decodeURIComponent(rd[1]), decodeURIComponent(rd[2]), visitor, h)), true);
      }
      throw new HttpError(404, "not found");
    }
    if (p === "/v1/suggestions" && m === "POST") {
      if (!o.suggestions) throw new HttpError(503, "Suggestions are not open here.");
      return (send(res, 200, o.suggestions.add(await body(req), o.lookup?.visitor(req) ?? req.socket.remoteAddress ?? "?")), true);
    }
    if (p.startsWith("/v1/admin/")) {
      admin(req);
      if (p === "/v1/admin/suggestions" && m === "GET") return (send(res, 200, { suggestions: o.suggestions?.list() ?? [] }), true);
      const sid = /^\/v1\/admin\/suggestions\/(\d{1,9})$/.exec(p);
      if (sid && m === "POST") {
        if (!o.suggestions) throw new HttpError(503, "Suggestions are not open here.");
        return (send(res, 200, { suggestion: o.suggestions.decide(Number(sid[1]), (await body(req)).status) }), true);
      }
      if (p === "/v1/admin/status" && m === "GET") {
        const t = now();
        const hour = spendSince(o.db, t - 3_600_000);
        const day = spendSince(o.db, t - 86_400_000);
        const src = (since: number) => {
          try {
            return sourceCalls(o.db, since);
          } catch {
            return [];
          }
        };
        return (
          send(res, 200, {
            at: new Date(t).toISOString(),
            github: { authenticated: !!o.authenticated, rate: getMeta(o.db, "gh_rate") ? JSON.parse(getMeta(o.db, "gh_rate")!) : null, lastHour: hour, lastDay: day, plan: schedulePlan(o.db, top.length || 100, !!o.authenticated, process.env, t) },
            sources: { lastHour: src(t - 3_600_000), lastDay: src(t - 86_400_000) },
            scouts: o.scouts?.status() ?? null,
            ranking: o.ranker?.status() ?? null,
            watched: top.length,
            known: o.accounts.length,
          }),
          true
        );
      }
      throw new HttpError(404, "not found");
    }
    return false;
  };

  const routes = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    const key = req.headers["x-pushd-live-key"];
    const keyHeader = Array.isArray(key) ? key[0] : key;

    if (agent && (p === "/mcp" || p.startsWith("/v1/agent")) && (await agent.handle(req, res, p, url, (max) => anyBody(req, max)))) return;
    if (p === "/v1/build" || p.startsWith("/v1/build/")) {
      if (o.build && (await o.build.routes.handle(req, res, p, url))) return;
      throw new HttpError(404, "not found");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "x-pushd-live-key", "access-control-allow-methods": "GET" });
      return res.end();
    }
    if (await holderRoutes(req, res, p)) return;
    if (await moreRoutes(req, res, p, q)) return;
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only");

    if (p === "/v1/token") return send(res, 200, o.token ? await o.token.panels.panel() : soonPanel());
    if (p === "/health") {
      const w = getMeta(o.db, "watcher");
      const counts = o.db.prepare("SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM catches) AS catches, (SELECT count(*) FROM events) AS events").get();
      return send(res, 200, { ok: true, now: new Date(now()).toISOString(), accounts: top.length, known: o.accounts.length, ...(counts as object), watcher: w ? JSON.parse(w) : null, summaryCost: totalCost(o.db), scouts: o.scouts?.status() ?? null });
    }
    if (p === "/v1/scouts") {
      if (!o.scouts) throw new HttpError(503, "the scouts are not running");
      return send(res, 200, o.scouts.view(cutoff(await delayOf(req, q.get("delay"), keyHeader))));
    }
    const sc = p.match(/^\/v1\/scouts\/([a-z]+)$/);
    if (sc) {
      if (!o.scouts) throw new HttpError(503, "the scouts are not running");
      const prof = o.scouts.profile(sc[1], cutoff(await delayOf(req, q.get("delay"), keyHeader)), feedItem);
      if (!prof) throw new HttpError(404, "no such scout");
      return send(res, 200, { scout: prof });
    }
    if (p === "/v1/stats") {
      const { pool, last } = (() => {
        try {
          const n = (o.db.prepare("SELECT count(*) AS n FROM pool").get() as { n: number }).n;
          const t = (o.db.prepare("SELECT max(at) AS t FROM rank_passes").get() as { t: number | null }).t;
          return { pool: n, last: t ? new Date(t).toISOString() : null };
        } catch {
          return { pool: 0, last: null };
        }
      })();
      const stats: Stats = { builders: top.length, groups: GROUPS.length, publicDelayMinutes: o.publicDelayMinutes, pool, lastPass: last, schedule: schedulePlan(o.db, top.length || 100, !!o.authenticated, process.env, now()) };
      return send(res, 200, stats);
    }
    if (p === "/v1/watchlist") return send(res, 200, { groups: watchGroups(top, q.get("all") === "1" ? Infinity : MEMBERS_SHOWN) });

    if (p === "/v1/feed") {
      const delay = await delayOf(req, q.get("delay"), keyHeader);
      const g = q.get("group");
      const group = g ? (GROUPS.includes(g as GroupKey) ? (g as GroupKey) : GROUP_ALIASES[g]) : undefined;
      if (g && !group) throw new HttpError(400, `unknown group ${g}`);
      const h = q.get("heat");
      const minHeat = h ? HEATS[h.toLowerCase()] : undefined;
      if (h && !minHeat) throw new HttpError(400, `unknown heat ${h}`);
      const limit = q.has("limit") ? Number(q.get("limit")) : 100;
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, "limit must be a whole number from 1");
      const items = queryItems(o.db, { shownBefore: cutoff(delay), group, minHeat, handle: q.get("person") ?? undefined, limit: Math.min(limit, 500) }).map(feedItem);
      return send(res, 200, { items });
    }
    if (p === "/v1/pulse") return send(res, 200, insights.pulse(cutoff(await delayOf(req, q.get("delay"), keyHeader))));
    if (p === "/v1/builders") return send(res, 200, { builders: insights.builders(cutoff(await delayOf(req, q.get("delay"), keyHeader))) });
    const bld = p.match(/^\/v1\/builders\/([^/]+)$/);
    if (bld) {
      const prof = insights.profile(decodeURIComponent(bld[1]), cutoff(await delayOf(req, q.get("delay"), keyHeader)));
      if (!prof) throw new HttpError(404, "not on the watchlist");
      return send(res, 200, { builder: prof });
    }
    if (p === "/v1/search") {
      const text = (q.get("q") ?? "").slice(0, 80);
      const limit = q.has("limit") ? Number(q.get("limit")) : 20;
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, "limit must be a whole number from 1");
      return send(res, 200, insights.search(text, cutoff(await delayOf(req, q.get("delay"), keyHeader)), limit));
    }
    const av = p.match(/^\/v1\/avatar\/([^/]+)$/);
    if (av) {
      const f = o.avatars ? await o.avatars.get(decodeURIComponent(av[1])) : null;
      if (!f) throw new HttpError(404, "no such picture");
      const body = readFileSync(f.path);
      res.writeHead(200, {
        "content-type": f.type,
        "content-length": String(body.length),
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    const more = p.match(/^\/v1\/feed\/([^/]+)\/more$/);
    if (more) {
      const c = cutoff(await delayOf(req, q.get("delay"), keyHeader));
      const it = getItemById(o.db, decodeURIComponent(more[1]));
      if (!it || it.shownAt > c) throw new HttpError(404, "no such line");
      return send(res, 200, { more: enricher.more(it, c, feedItem) });
    }
    // one day at a time (src/days.ts): the replay and the daily brief
    if (p === "/v1/days") return send(res, 200, { days: days.list(cutoff(await delayOf(req, q.get("delay"), keyHeader))) });
    const oneDay = p.match(/^\/v1\/day\/([^/]+)$/);
    if (oneDay) {
      const d = decodeURIComponent(oneDay[1]);
      if (!validDay(d)) throw new HttpError(400, "day must be YYYY-MM-DD");
      return send(res, 200, days.day(d, cutoff(await delayOf(req, q.get("delay"), keyHeader))));
    }
    const one = p.match(/^\/v1\/feed\/([^/]+)$/);
    if (one) {
      const delay = await delayOf(req, q.get("delay"), keyHeader);
      const it = getItemById(o.db, decodeURIComponent(one[1]));
      if (!it || it.shownAt > cutoff(delay) || isHidden(o.db, it.id)) throw new HttpError(404, "no such line");
      return send(res, 200, { item: feedItem(it) });
    }
    if (p === "/v1/catches") {
      const delay = await delayOf(req, q.get("delay"), keyHeader);
      const limit = q.has("limit") ? Number(q.get("limit")) : 200;
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, "limit must be a whole number from 1");
      const items = queryCatches(o.db, cutoff(delay), limit).map(feedItem);
      return send(res, 200, { items });
    }
    if (p === "/v1/stream") return stream(req, res, await delayOf(req, q.get("delay"), keyHeader));
    const pic = p.match(/^\/v1\/media\/([^/]+)$/);
    if (pic) {
      const f = o.mediaDir ? mediaFile(o.db, o.mediaDir, pic[1]) : null;
      if (!f) throw new HttpError(404, "no such picture");
      // a picture is fetched once and never changes: its id is its version
      const etag = `"${pic[1]}"`;
      const headers = {
        "content-type": f.type,
        "cache-control": "public, max-age=31536000, immutable",
        etag,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      const body = readFileSync(f.path);
      res.writeHead(200, { ...headers, "content-length": String(body.length) });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    throw new HttpError(404, "not found");
  };

  /** Server-sent events: each line once, when it clears this request's delay. */
  const stream = (req: IncomingMessage, res: ServerResponse, delayMin: number) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 5000\n: pushd stream, ${delayMin} min behind\n\n`);
    // the cursor is the store's sequence number, so no line is skipped or sent twice; a reconnect resumes from
    // the Last-Event-ID it sends
    const last = Number(req.headers["last-event-id"]);
    let cursor = Number.isInteger(last) && last >= 0 ? last : lastSeqShownBy(o.db, cutoff(delayMin));
    const tick = () => {
      const upTo = cutoff(delayMin);
      for (const it of itemsAfterSeq(o.db, cursor)) {
        if (it.shownAt > upTo) break; // not out of its delay yet: next tick
        res.write(`id: ${it.seq}\nevent: item\ndata: ${JSON.stringify(feedItem(it))}\n\n`);
        cursor = it.seq;
      }
    };
    const t = setInterval(tick, o.streamTickMs ?? 2_000);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => (clearInterval(t), clearInterval(ping)));
  };

  return createServer((req, res) => {
    routes(req, res).catch((e) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HolderError) return send(res, e.status, { error: e.message, ...e.detail });
      if (e instanceof MyScoutError || e instanceof ScoutError || e instanceof WatchError || e instanceof SuggestError) return send(res, e.status, { error: e.message });
      if (e instanceof LookupError) return send(res, e.status, { error: e.message, ...(e.retryInSec != null ? { busy: e.status === 503, retryInSec: e.retryInSec } : {}) });
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: e instanceof HttpError ? e.message : "server error" });
      // node addresses can carry a key: never logged as they are
      if (!(e instanceof HttpError)) console.error(scrub(String((e as Error)?.stack ?? e)));
    });
  });
}
