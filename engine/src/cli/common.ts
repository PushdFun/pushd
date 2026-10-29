// What every command shares: the settings, the store, the GitHub client, and a few argument helpers.
import { join } from "node:path";
import { Avatars } from "../avatars.ts";
import { config, loadWatchlist } from "../config.ts";
import { openDb, type StoredItem } from "../db.ts";
import { Enricher } from "../enrich.ts";
import { GitHub } from "../github.ts";
import { MediaQueue } from "../media.ts";
import { Push, pushConfigFromEnv } from "../push.ts";
import type { Holders } from "../token/holders.ts";
import type { TokenServices } from "../token/local.ts";
import { Payments, viemPaymentChain } from "../agent/payments.ts";
import { openRouterKey, scoutConfigFromEnv } from "../scouts/config.ts";
import { MyScouts } from "../scouts/myscouts.ts";
import { openRouterProvider } from "../scouts/provider.ts";
import { Scouts } from "../scouts/scouts.ts";
import type { GitHub as GitHubClient } from "../github.ts";
import type { FeedItem, WatchEntry } from "../types.ts";
import { HolderWatch, watchConfigFromEnv } from "../holderwatch.ts";
import { Lookup, lookupConfigFromEnv } from "../lookup.ts";
import { shareRoom } from "../plan.ts";
import { denied, rankConfigFromEnv, type RankConfig } from "../rank/config.ts";
import { Pool } from "../rank/pool.ts";
import { Ranker } from "../rank/ranker.ts";
import { Registry } from "../registry.ts";
import { Suggestions } from "../suggest.ts";
import { agentsConfigFromEnv } from "../agents/config.ts";
import { buildServices } from "../agents/index.ts";

export const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

/** "90s", "10m", "2h" -> milliseconds */
export function duration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) throw new Error(`not a duration: ${s}`);
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"]);
}

export function setup(dbPath = config.dbPath) {
  const wl = loadWatchlist();
  const db = openDb(dbPath);
  // the watcher's client: booked to the "watch" share of the hour (src/plan.ts)
  const gh = new GitHub({ db, token: config.githubToken, log, part: "watch" });
  // the live lists: the Top N now, and everyone known by name (the old hand-made list keeps its lines' names). With
  // PUSHD Agents on, the scouts' own account keeps its lines in view (their daily builds, src/agents/scoutbuilds.ts)
  const ac = agentsConfigFromEnv();
  const registry = new Registry(db, wl.accounts, ac.on && ac.scoutBuilds ? [ac.scoutsOrg] : []);
  // --only a,b,c watches just those handles (from the known list), for a short local check
  const only = arg("only");
  let accounts: WatchEntry[] = registry.top;
  if (only) {
    const want = only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    accounts = registry.known.filter((a) => want.includes(a.handle.toLowerCase()));
    const missing = want.filter((w) => !accounts.some((a) => a.handle.toLowerCase() === w));
    if (missing.length) throw new Error(`not known: ${missing.join(", ")}`);
  }
  return { wl, db, gh, registry, accounts, all: registry.known };
}

/** The ranking (src/rank): its pool and passes in the watcher's process (`withPool`), its views everywhere. */
export function rankServices(db: ReturnType<typeof openDb>, withPool: boolean) {
  const auth = !!config.githubToken;
  const rc = rankConfigFromEnv(process.env, auth);
  const pool = withPool
    ? new Pool({
        db,
        config: rc,
        search: new GitHub({ db, token: config.githubToken, log, part: "search" }),
        core: new GitHub({ db, token: config.githubToken, log, part: "rank", wait: false }),
        log,
        coreRoom: () => shareRoom(db, "rank", auth),
      })
    : null;
  const ranker = new Ranker({ db, config: rc, pool, authenticated: auth, log });
  return { rc, ranker };
}

/** The extras store: lines of accounts holders added (never the public feed). */
export function extrasStore() {
  return openDb(config.extrasDbPath);
}

/** Look up anyone, holders watching any account, suggestions (src/lookup.ts, src/holderwatch.ts, src/suggest.ts). */
export function lookupServices(db: ReturnType<typeof openDb>, extrasDb: ReturnType<typeof openDb>, registry: Registry, ranker: Ranker, rc: RankConfig, scouts: Scouts | null) {
  const auth = !!config.githubToken;
  const lookup = new Lookup({
    db,
    gh: new GitHub({ db, token: config.githubToken, log, part: "lookup", wait: false }),
    registry,
    ranker,
    scouts,
    rank: rc,
    searchWatch: () => ({ items: [], builders: [] }),
    config: lookupConfigFromEnv(process.env, auth),
    log,
  });
  const holderWatch = new HolderWatch({
    db,
    config: watchConfigFromEnv(),
    authenticated: auth,
    inTop: (l) => registry.inTop(l),
    account: (l, v) => lookup.account(l, v),
    linesOf: (l) => (extrasDb.prepare("SELECT count(*) AS n FROM items WHERE lower(handle) = lower(?)").get(l) as { n: number }).n,
    lastReadOf: (l) => (extrasDb.prepare("SELECT last_poll_at AS t FROM accounts WHERE lower(handle) = lower(?)").get(l) as { t: string | null } | undefined)?.t ?? null,
  });
  const suggestions = new Suggestions({ db, inTop: (l) => registry.inTop(l), rankOf: (l) => ranker.rowOf(l)?.rank ?? null, hidden: (l) => denied(rc, l, { privateOnly: true }) });
  return { lookup, holderWatch, suggestions };
}

/** The preview picture queue (null when PUSHD_MEDIA=off), with the lines already stored put in it. */
export function mediaQueue(db: ReturnType<typeof openDb>): MediaQueue | null {
  if (!config.media) return null;
  const q = new MediaQueue({ db, dir: config.mediaDir, perHour: config.mediaPerHour, log });
  const n = q.enqueueExisting();
  if (n) log(`media: ${n} repo preview(s) queued from lines already stored`);
  return q;
}

/** What the feed API adds to an item's page and the builders' pages: the extra-facts fetcher and the pictures. */
export function pageServices(db: ReturnType<typeof openDb>, all: WatchEntry[], lookedUp?: (h: string) => string | null) {
  const enricher = new Enricher({ db, token: config.githubToken, enabled: config.enrich, perHour: config.enrichPerHour, log });
  const avatars = config.avatars ? new Avatars({ db, dir: join(config.mediaDir, "avatars"), handles: () => all.map((a) => a.handle), allow: lookedUp, log }) : null;
  return { enricher, avatars };
}

/** Web push for holders (src/push.ts): on only with the VAPID keys set; it follows new lines in this process. */
export function pushService(db: ReturnType<typeof openDb>, holders: Holders) {
  const push = new Push({ db, config: pushConfigFromEnv(), holders, log });
  if (!push.on) log("push alerts off: PUSHD_VAPID_PUBLIC_KEY and PUSHD_VAPID_PRIVATE_KEY are not set");
  return { push, stopPush: push.start() };
}

/**
 * The agent layer (src/scouts, src/agent): the five scouts, holders' own scouts and the agent API with pay per call.
 * The model key comes from PUSHD_OPENROUTER_KEY, or locally from ~/.pushd-openrouter-key; without one every call is a
 * template call and no model is ever asked.
 */
export function agentServices(db: ReturnType<typeof openDb>, all: WatchEntry[], gh: GitHubClient, token: TokenServices, push: Push, extras?: { db: ReturnType<typeof openDb>; watch: () => HolderWatch | null }) {
  const sc = scoutConfigFromEnv(process.env, { key: openRouterKey() });
  const provider = sc.key ? openRouterProvider(sc.key) : null;
  const scouts = new Scouts({ db, accounts: all, config: sc, provider, gh, log });
  const stopScouts = scouts.start();
  let stopMine: () => void = () => undefined;
  const myScouts = (toItem: (it: StoredItem) => FeedItem) => {
    const m = new MyScouts({
      db,
      accounts: all,
      config: sc,
      provider: sc.on ? provider : null,
      budget: scouts.budget,
      toItem,
      push,
      isHolder: async (a) => (await token.holders.status(a)).holder,
      extras: extras ? { db: extras.db, watchers: (l) => extras.watch()?.watchers(l) ?? [], accountsOf: (a) => extras.watch()?.accountsOf(a) ?? [] } : null,
      log,
    });
    stopMine = m.start();
    return m;
  };
  const payments = new Payments({ db, chain: viemPaymentChain(token.config.rpcUrl), payTo: token.config.pot, switchOn: sc.agent.paidSwitch, maxAgeMs: sc.agent.payMaxAgeMs });
  log(payments.open ? "agent API: paid tools open, payments go to the burn pot" : "agent API: free tools on; paid tools open at launch (no burn pot set)");
  // PUSHD Agents: anyone's own agent on GitHub (src/agents); off unless PUSHD_AGENTS=on. Paid runs go to the same burn pot
  const build = buildServices({ db, token, payments, provider, push, trustProxy: sc.agent.trustProxy, log });
  return { scouts, myScouts, agent: { payments, config: sc.agent, siteUrl: token.config.holder.siteUrl }, build, stop: () => (stopScouts(), stopMine(), build?.stop()) };
}
