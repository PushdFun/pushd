import "server-only";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { isCatch } from "./groups";
import { SAMPLE_AS_OF, SAMPLE_ITEMS, SAMPLE_PREVIEW_IDS, SAMPLE_STATS, SAMPLE_WATCHLIST } from "./sample";
import { sampleBuilders, sampleMore, sampleProfile, samplePulse, searchSample } from "./sample-insights";
import { ponsPage, siteTokenConfig } from "./token/config";
import { sampleScouts, SCOUT_BY_ID } from "./scouts";
import { sampleTop } from "./sample-top";
import { parseQuery, validLogin, validRepo } from "./lookup";
import type { AgentStats, BuilderProfile, BuilderStats, Feed, FeedItem, GhRepoPage, GhUserPage, HolderView, HolderWatchView, ItemMore, LookupResult, MyHit, MyScoutsView, ProjectRank, Pulse, ScoutProfile, ScoutsView, SearchResult, Stats, Suggestion, TokenPanel, TopView, WatchGroup } from "./types";

// Where every page gets its lines. With PUSHD_ENGINE_URL set, the watcher's API answers (read on the server, 12 s at
// most, never cached); without it, the sample in ./sample.ts does. When the engine is set but does not answer, the
// pages show nothing rather than the sample: a sample line must never pass for a real one.
//
// The engine's API, as this site reads it:
//   GET /v1/feed?view=public       { items: FeedItem[] }   newest first
//   GET /v1/feed/:id?view=public   { item: FeedItem }      404 when there is no such line
//   GET /v1/watchlist              { groups: WatchGroup[] }
//   GET /v1/stats                  Stats
//   GET /v1/catches?view=public    { items: FeedItem[] }   the catches log, kept for good, newest shown first
//   GET /v1/media/:id              a repo's preview picture; this site serves it as its own /media/:id (src/app/media)
//   GET /v1/token                  TokenPanel: $PUSHD read from the chain (soon, deployed or live)
//   GET /v1/holders/me             HolderView, with `Authorization: Bearer <session>`; 401 when not signed in
//
// A signed-in holder (the pushd_holder cookie, set by src/app/api/holder) gets every list with ?delay=0 and their
// session as a Bearer token: the engine checks the session and the wallet's $PUSHD balance on each request and answers
// 401 when either fails, and then the page falls back to the public view.

const TIMEOUT_MS = 12_000;

export const engineUrl = () => process.env.PUSHD_ENGINE_URL?.trim().replace(/\/+$/, "") || null;

/** The holder's session cookie (httpOnly) and the plain hint beside it that only says one exists. */
export const HOLDER_COOKIE = "pushd_holder";
export const HOLDER_HINT = "pushd_holder_on";
const SESSION_RE = /^[A-Za-z0-9_-]{20,100}$/;

class NotFound extends Error {}
class NotLive extends Error {}

async function engine<T>(path: string, session?: string | null): Promise<T> {
  const res = await fetch(engineUrl() + path, {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
  });
  if (res.status === 404) throw new NotFound(path);
  if (res.status === 401 && session) throw new NotLive(path);
  if (!res.ok) throw new Error(`engine ${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** This request's holder session, when there is one that looks like a session. */
export async function holderSession(): Promise<string | null> {
  if (!engineUrl()) return null;
  const v = (await cookies()).get(HOLDER_COOKIE)?.value ?? "";
  return SESSION_RE.test(v) ? v : null;
}

/** The signed-in holder: their wallet, balance and own choices. Null when not signed in (or the engine is silent). */
export async function getHolder(): Promise<HolderView | null> {
  await connection();
  const session = await holderSession();
  if (!session) return null;
  try {
    return await engine<HolderView>("/v1/holders/me", session);
  } catch {
    return null;
  }
}

/** A list in the holder's live view when this request has a holder session the engine accepts; null otherwise. */
async function liveList(path: string): Promise<FeedItem[] | null> {
  const session = await holderSession();
  if (!session) return null;
  try {
    const { items } = await engine<{ items: FeedItem[] }>(`${path}${path.includes("?") ? "&" : "?"}delay=0`, session);
    return items;
  } catch {
    return null;
  }
}

/** The engine's picture path (/v1/media/<id>) as this site's own address; anything else is no picture. */
export function siteMediaUrl(engineMediaUrl: string | null | undefined): string | null {
  const m = engineMediaUrl?.match(/^\/v1\/media\/([a-f0-9]{24})$/);
  return m ? `/media/${m[1]}` : null;
}
const fromEngine = (it: FeedItem): FeedItem => ({ ...it, mediaUrl: siteMediaUrl(it.mediaUrl) });
// sample lines never have a picture: their cards are always drawn
const fromSample = (it: FeedItem): FeedItem => ({ ...it, mediaUrl: null });

const byNewest = (a: FeedItem, b: FeedItem) => Date.parse(b.githubAt) - Date.parse(a.githubAt);

/** The public view runs this many minutes behind; signed-in holders see it live (liveList above). */
function publicOnly(items: FeedItem[], now: number, delayMinutes: number): FeedItem[] {
  const cutoff = now - delayMinutes * 60_000;
  return items.filter((it) => Date.parse(it.shownAt ?? it.githubAt) <= cutoff);
}

export async function getStats(): Promise<Stats> {
  await connection();
  if (!engineUrl()) return SAMPLE_STATS;
  try {
    return await engine<Stats>("/v1/stats");
  } catch {
    return SAMPLE_STATS;
  }
}

/** Every line of the feed, newest first: live for a signed-in holder, the public view for everyone else. */
export async function getFeed(): Promise<Feed> {
  await connection();
  if (!engineUrl()) return { items: SAMPLE_ITEMS.map(fromSample).sort(byNewest), asOf: SAMPLE_AS_OF, source: "sample" };
  const now = Date.now();
  const live = await liveList("/v1/feed");
  if (live) return { items: live.map(fromEngine).sort(byNewest), asOf: new Date(now).toISOString(), source: "engine", live: true };
  try {
    const [{ items }, stats] = await Promise.all([engine<{ items: FeedItem[] }>("/v1/feed?view=public"), getStats()]);
    return { items: publicOnly(items, now, stats.publicDelayMinutes).map(fromEngine).sort(byNewest), asOf: new Date(now).toISOString(), source: "engine" };
  } catch {
    return { items: [], asOf: new Date(now).toISOString(), source: "offline" };
  }
}

/** The public feed only, never a holder's live one: for the RSS and JSON feeds and the widget, which anyone may copy. */
export async function getPublicFeed(): Promise<Feed> {
  await connection();
  if (!engineUrl()) return { items: SAMPLE_ITEMS.map(fromSample).sort(byNewest), asOf: SAMPLE_AS_OF, source: "sample" };
  const now = Date.now();
  try {
    const [{ items }, stats] = await Promise.all([engine<{ items: FeedItem[] }>("/v1/feed?view=public"), getStats()]);
    return { items: publicOnly(items, now, stats.publicDelayMinutes).map(fromEngine).sort(byNewest), asOf: new Date(now).toISOString(), source: "engine" };
  } catch {
    return { items: [], asOf: new Date(now).toISOString(), source: "offline" };
  }
}

/** The catches log: the hot lines, with the time PUSHD showed each one. Newest shown first. */
export async function getCatches(): Promise<Feed> {
  await connection();
  if (!engineUrl()) return { items: SAMPLE_ITEMS.filter((it) => isCatch(it.heat)).map(fromSample).sort(byNewest), asOf: SAMPLE_AS_OF, source: "sample" };
  const now = Date.now();
  const live = await liveList("/v1/catches");
  if (live) return { items: live.map(fromEngine), asOf: new Date(now).toISOString(), source: "engine", live: true };
  try {
    const [{ items }, stats] = await Promise.all([engine<{ items: FeedItem[] }>("/v1/catches?view=public"), getStats()]);
    return { items: publicOnly(items, now, stats.publicDelayMinutes).map(fromEngine), asOf: new Date(now).toISOString(), source: "engine" };
  } catch {
    return { items: [], asOf: new Date(now).toISOString(), source: "offline" };
  }
}

/** One line, for its own page; null when there is none (or it is still inside the public delay). */
export async function getItem(id: string): Promise<{ item: FeedItem; asOf: string } | null> {
  await connection();
  if (!engineUrl()) {
    const item = SAMPLE_ITEMS.find((it) => it.id === id);
    return item ? { item: fromSample(item), asOf: SAMPLE_AS_OF } : null;
  }
  const now = Date.now();
  const session = await holderSession();
  if (session) {
    try {
      const { item } = await engine<{ item: FeedItem }>(`/v1/feed/${encodeURIComponent(id)}?delay=0`, session);
      return { item: fromEngine(item), asOf: new Date(now).toISOString() };
    } catch (e) {
      if (e instanceof NotFound) return null;
      // not live any more: the public view below
    }
  }
  try {
    const [{ item }, stats] = await Promise.all([
      engine<{ item: FeedItem }>(`/v1/feed/${encodeURIComponent(id)}?view=public`),
      getStats(),
    ]);
    return publicOnly([item], now, stats.publicDelayMinutes).length ? { item: fromEngine(item), asOf: new Date(now).toISOString() } : null;
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

/** The home page's terminal: five lines. */
export async function getPreview(): Promise<Feed> {
  const feed = await getFeed();
  if (feed.source !== "sample") return { ...feed, items: feed.items.slice(0, 5) };
  const pick = SAMPLE_PREVIEW_IDS.map((id) => feed.items.find((it) => it.id === id)).filter((it): it is FeedItem => !!it);
  return { ...feed, items: pick };
}

export async function getWatchlist(opts: { all?: boolean } = {}): Promise<{ groups: WatchGroup[]; sample: boolean }> {
  await connection();
  if (!engineUrl()) return { groups: SAMPLE_WATCHLIST, sample: true };
  try {
    const { groups } = await engine<{ groups: WatchGroup[] }>(opts.all ? "/v1/watchlist?all=1" : "/v1/watchlist");
    return { groups, sample: false };
  } catch {
    return { groups: [], sample: false };
  }
}

/** A repo's preview picture from the engine, for /media/:id. null when there is no engine or no such picture. */
export async function getMedia(id: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  if (!engineUrl() || !/^[a-f0-9]{24}$/.test(id)) return null;
  try {
    const res = await fetch(`${engineUrl()}/v1/media/${id}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    return { body: await res.arrayBuffer(), type };
  } catch {
    return null;
  }
}

/** $PUSHD as the chain has it, through the engine. With no engine, or a silent one: launching soon. */
export async function getToken(): Promise<TokenPanel> {
  await connection();
  const soon: TokenPanel = { stage: "soon", token: null, pot: null, explorer: siteTokenConfig().explorer, supply: null, launchSupply: null, burned: null, ethSpent: null, count: 0, latest: [], next: null, lastBurnAt: null, startedAt: null, holderMin: "1000000", readAt: Date.now(), stale: false, problem: null };
  if (!engineUrl()) return soon;
  try {
    return await engine<TokenPanel>("/v1/token");
  } catch {
    return { ...soon, stale: true, problem: "The token numbers could not be read just now. They come back on the next look." };
  }
}

let linkCache: { at: number; token: string | null } | null = null;

/**
 * Where "Buy $PUSHD" leads: nowhere until $PUSHD exists, then PUSHD_BUY_URL or the token's Pons page. The address is
 * PUSHD_TOKEN_ADDRESS, else what the engine reads from the burn pot (asked at most once a minute, 3 s at most).
 */
export async function getBuyLink(): Promise<{ token: string | null; href: string | null }> {
  const c = siteTokenConfig();
  let token = c.token;
  if (!token && engineUrl()) {
    if (linkCache && Date.now() - linkCache.at < 60_000) token = linkCache.token;
    else {
      try {
        const res = await fetch(`${engineUrl()}/v1/token`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
        token = res.ok ? ((await res.json()) as TokenPanel).token : null;
      } catch {
        token = null;
      }
      linkCache = { at: Date.now(), token };
    }
  }
  return { token, href: token ? (c.buyUrl ?? ponsPage(token)) : null };
}

// ---- the insight pages: the pulse, the builders, an item's extras, search (engine: src/insights.ts, src/enrich.ts) ----
//   GET /v1/pulse                Pulse
//   GET /v1/builders             { builders: BuilderStats[] }
//   GET /v1/builders/:handle     { builder: BuilderProfile }   404 when not on the watchlist
//   GET /v1/feed/:id/more        { more: ItemMore }
//   GET /v1/search?q=            SearchResult
// A signed-in holder's builder page and item extras run live (?delay=0), like the feed.

/** The engine with a holder's session and no delay when there is one the engine accepts; the public view otherwise. */
async function liveOrPublic<T>(path: string): Promise<T> {
  const session = await holderSession();
  if (session) {
    try {
      return await engine<T>(`${path}${path.includes("?") ? "&" : "?"}delay=0`, session);
    } catch (e) {
      if (e instanceof NotFound) throw e;
    }
  }
  return engine<T>(path);
}

const pulseItems = (p: Pulse): Pulse => ({ ...p, hottest: p.hottest.map(fromEngine) });

/** The watchlist's activity added up. null when the engine is set but silent (the page says so). */
export async function getPulse(): Promise<Pulse | null> {
  await connection();
  if (!engineUrl()) return samplePulse();
  try {
    return pulseItems(await engine<Pulse>("/v1/pulse"));
  } catch {
    return null;
  }
}

export async function getBuilders(): Promise<{ builders: BuilderStats[]; source: Feed["source"] }> {
  await connection();
  if (!engineUrl()) return { builders: sampleBuilders(), source: "sample" };
  try {
    return { builders: (await engine<{ builders: BuilderStats[] }>("/v1/builders")).builders, source: "engine" };
  } catch {
    return { builders: [], source: "offline" };
  }
}

/** One builder's page; null when not on the watchlist. Throws when the engine is silent. */
export async function getBuilder(handle: string): Promise<BuilderProfile | null> {
  await connection();
  if (!engineUrl()) return sampleProfile(handle);
  if (!/^@?[A-Za-z0-9-]{1,39}$/.test(handle)) return null;
  try {
    const { builder } = await liveOrPublic<{ builder: BuilderProfile }>(`/v1/builders/${encodeURIComponent(handle.replace(/^@/, ""))}`);
    return { ...builder, lines: builder.lines.map(fromEngine), hottest: builder.hottest.map(fromEngine) };
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

/** What an item's page shows beside the line. Empty (nothing stored) when the engine does not answer. */
export async function getItemMore(item: FeedItem): Promise<ItemMore> {
  await connection();
  const none: ItemMore = { repo: null, text: null, commits: null, change: null, related: [], pending: [] };
  if (!engineUrl()) return sampleMore(item);
  try {
    const { more } = await liveOrPublic<{ more: ItemMore }>(`/v1/feed/${encodeURIComponent(item.id)}/more`);
    return { ...more, related: more.related.map(fromEngine) };
  } catch {
    return none;
  }
}

/** Lines and builders matching a few words (the public view). */
export async function searchAll(q: string): Promise<SearchResult> {
  const text = q.trim().slice(0, 80);
  if (!text) return { items: [], builders: [] };
  if (!engineUrl()) return searchSample(text);
  try {
    const r = await engine<SearchResult>(`/v1/search?q=${encodeURIComponent(text)}&limit=12`);
    return { items: r.items.map(fromEngine), builders: r.builders };
  } catch {
    return { items: [], builders: [] };
  }
}

/** A builder's GitHub picture from the engine, for /avatar/:handle. null when there is none. */
export async function getAvatar(handle: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  if (!engineUrl() || !/^[A-Za-z0-9-]{1,39}$/.test(handle)) return null;
  try {
    const res = await fetch(`${engineUrl()}/v1/avatar/${handle}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    return { body: await res.arrayBuffer(), type };
  } catch {
    return null;
  }
}

// ---- the scouts and the agent API (engine: src/scouts, src/agent) ----
//   GET /v1/scouts               ScoutsView     the leaderboard (live for a signed-in holder)
//   GET /v1/scouts/:id           { scout: ScoutProfile }
//   GET /v1/agent/stats          AgentStats     agent calls and the ETH agents sent to the burn
//   GET /v1/holders/scouts       MyScoutsView   a holder's own scouts (session)
//   GET /v1/holders/scouts/hits  { hits }       the "my scout" inbox (session)

/** The five scouts and their records. The sample (no calls) without an engine; null when the engine is silent. */
export async function getScouts(): Promise<ScoutsView | null> {
  await connection();
  if (!engineUrl()) return sampleScouts();
  try {
    return await liveOrPublic<ScoutsView>("/v1/scouts");
  } catch {
    return null;
  }
}

/** One scout's page; null for an unknown scout. Throws when the engine is silent. */
export async function getScout(id: string): Promise<ScoutProfile | null> {
  await connection();
  if (!(id in SCOUT_BY_ID)) return null;
  if (!engineUrl()) {
    const v = sampleScouts();
    const record = v.scouts.find((r) => r.id === id)!;
    return { record, calls: [], mode: v.mode, model: null, deepModel: null, asOf: v.asOf };
  }
  try {
    const { scout } = await liveOrPublic<{ scout: ScoutProfile }>(`/v1/scouts/${id}`);
    return { ...scout, calls: scout.calls.map(fromEngine) };
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

/** The public counters on /agents. Null without an engine or when it is silent. */
export async function getAgentStats(): Promise<AgentStats | null> {
  await connection();
  if (!engineUrl()) return null;
  try {
    return await engine<AgentStats>("/v1/agent/stats");
  } catch {
    return null;
  }
}

/** A signed-in holder's own scouts and inbox. Null when not signed in, not a holder, or the engine is silent. */
export async function getMyScouts(): Promise<{ view: MyScoutsView; hits: MyHit[] } | null> {
  await connection();
  const session = await holderSession();
  if (!session) return null;
  try {
    const [view, { hits }] = await Promise.all([engine<MyScoutsView>("/v1/holders/scouts", session), engine<{ hits: MyHit[] }>("/v1/holders/scouts/hits?limit=60", session)]);
    return { view, hits: hits.map((h) => ({ ...h, item: fromEngine(h.item) })) };
  } catch {
    return null;
  }
}

// ---- the list, looking up anyone, holders' added accounts, suggestions and admin (engine: src/rank, src/lookup) ----
//   GET /v1/top                    TopView
//   GET /v1/top/:handle            { project: ProjectRank }   404 when not in the pool
//   GET /v1/lookup?q=              LookupResult
//   GET /v1/gh/users/:login        { page: GhUserPage } or { redirect }   404 no such account, 503 busy
//   GET /v1/gh/repos/:owner/:name  { page: GhRepoPage }                    404 no such repo, 503 busy
//   GET /v1/holders/watch          HolderWatchView (session)
//   GET /v1/admin/suggestions      { suggestions } (x-pushd-admin-key)
//   GET /v1/admin/status           the internal budgets (x-pushd-admin-key)
// The visitor's address goes along as x-forwarded-for, so the engine's limits count per visitor, not per site.

/** The visitor's address as this site was told it: the first x-forwarded-for entry, else x-real-ip. */
export async function visitorIp(): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, 64) : null;
}

/** One call to the engine with its status and body, whatever the status. 0 when it did not answer. */
export async function engineCall(path: string, o: { method?: string; body?: unknown; session?: string | null; ip?: string | null; admin?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = o.admin ? process.env.PUSHD_ADMIN_KEY?.trim() : null;
  if (o.admin && !key) return { status: 403, body: { error: "Admin is off: PUSHD_ADMIN_KEY is not set." } };
  try {
    const res = await fetch(engineUrl() + path, {
      method: o.method ?? "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(o.method === "POST" ? 90_000 : TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(o.session ? { authorization: `Bearer ${o.session}` } : {}),
        ...(o.ip ? { "x-forwarded-for": o.ip } : {}),
        ...(key ? { "x-pushd-admin-key": key } : {}),
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch {
    return { status: 0, body: { error: "PUSHD's server did not answer. Try again in a minute." } };
  }
}

/** The list now: the sample without an engine, null when the engine is silent. */
export async function getTop(): Promise<TopView | null> {
  await connection();
  if (!engineUrl()) return sampleTop();
  try {
    return await engine<TopView>("/v1/top");
  } catch {
    return null;
  }
}

/** One project's place in the ranking; null when it is not in the pool (or there is no engine). */
export async function getProjectRank(handle: string): Promise<ProjectRank | null> {
  await connection();
  if (!engineUrl() || !validLogin(handle.replace(/^@/, ""))) return null;
  try {
    return (await engine<{ project: ProjectRank }>(`/v1/top/${encodeURIComponent(handle.replace(/^@/, ""))}`)).project;
  } catch {
    return null;
  }
}

/** Search for the search page and the palette: the watched first, then anything on GitHub. */
export async function lookupAll(q: string, ip: string | null): Promise<{ result: LookupResult; offline: boolean }> {
  const text = q.trim().slice(0, 100);
  const p = parseQuery(text);
  const direct: LookupResult["direct"] = p.kind === "user" ? { kind: "user", href: p.href, label: p.login } : p.kind === "repo" ? { kind: "repo", href: p.href, label: `${p.owner}/${p.repo}` } : null;
  const empty: LookupResult = { q: text, direct, watch: { items: [], builders: [] }, github: { users: [], repos: [], busy: false, retryInSec: null } };
  if (!text) return { result: empty, offline: false };
  if (!engineUrl()) return { result: { ...empty, watch: searchSample(text) }, offline: true };
  const r = await engineCall(`/v1/lookup?q=${encodeURIComponent(text)}`, { ip });
  if (r.status !== 200) return { result: empty, offline: true };
  const res = r.body as unknown as LookupResult;
  return { result: { ...res, watch: { items: (res.watch?.items ?? []).map(fromEngine), builders: res.watch?.builders ?? [] } }, offline: false };
}

/** A page built on demand: there, a redirect to the builder's page, no such thing, busy (with when to try), or no engine. */
export type GhLoad<T> =
  | { state: "ok"; page: T }
  | { state: "redirect"; to: string }
  | { state: "missing"; error: string }
  | { state: "busy"; error: string; retryInSec: number }
  | { state: "offline"; error: string };

function ghLoad<T>(r: { status: number; body: Record<string, unknown> }): GhLoad<T> {
  if (r.status === 200 && typeof r.body.redirect === "string" && /^\/builders\/[A-Za-z0-9-]{1,39}$/.test(r.body.redirect)) return { state: "redirect", to: r.body.redirect };
  if (r.status === 200 && r.body.page) return { state: "ok", page: r.body.page as T };
  const error = typeof r.body.error === "string" ? r.body.error : "";
  if (r.status === 404 || r.status === 400) return { state: "missing", error: error || "GitHub has no such account or repo." };
  if (r.status === 503 || r.status === 429) {
    const s = Number(r.body.retryInSec);
    return { state: "busy", error: error || "GitHub is busy right now.", retryInSec: Number.isFinite(s) && s > 0 ? Math.min(3600, Math.round(s)) : 60 };
  }
  return { state: "offline", error: error || "PUSHD's server did not answer." };
}

const noEngine = { state: "offline" as const, error: "Looking up GitHub needs PUSHD's engine, which is not connected here." };

/** Any GitHub account's page. */
export async function getGhUser(login: string): Promise<GhLoad<GhUserPage>> {
  await connection();
  if (!validLogin(login)) return { state: "missing", error: "That is not a GitHub username." };
  if (!engineUrl()) return noEngine;
  return ghLoad<GhUserPage>(await engineCall(`/v1/gh/users/${encodeURIComponent(login)}`, { ip: await visitorIp() }));
}

/** Any public repo's page; a signed-in holder's free reads left come with it. */
export async function getGhRepo(owner: string, repo: string): Promise<GhLoad<GhRepoPage>> {
  await connection();
  if (!validLogin(owner) || !validRepo(repo)) return { state: "missing", error: "That is not a GitHub repo." };
  if (!engineUrl()) return noEngine;
  return ghLoad<GhRepoPage>(await engineCall(`/v1/gh/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { ip: await visitorIp(), session: await holderSession() }));
}

/** A signed-in holder's added accounts; null when not signed in, not a holder, or the engine is silent. */
export async function getHolderWatch(): Promise<HolderWatchView | null> {
  await connection();
  const session = await holderSession();
  if (!session) return null;
  const r = await engineCall("/v1/holders/watch", { session });
  return r.status === 200 ? (r.body as unknown as HolderWatchView) : null;
}

/** The suggestions, for the admin page (which checks its own lock first). null when the engine refuses or is silent. */
export async function getAdminSuggestions(): Promise<Suggestion[] | null> {
  if (!engineUrl()) return null;
  const r = await engineCall("/v1/admin/suggestions", { admin: true });
  return r.status === 200 && Array.isArray(r.body.suggestions) ? (r.body.suggestions as Suggestion[]) : null;
}

/** The engine's internal budgets and spend, for the admin page. */
export async function getAdminStatus(): Promise<Record<string, unknown> | null> {
  if (!engineUrl()) return null;
  const r = await engineCall("/v1/admin/status", { admin: true });
  return r.status === 200 ? r.body : null;
}
