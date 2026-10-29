// Watcher and feed API together: `npm start [-- --only a,b --for 10m]`.
import { createApi } from "../api.ts";
import { config } from "../config.ts";
import { startKeeper, tokenServices } from "../token/local.ts";
import { Watcher } from "../watcher.ts";
import { GitHub } from "../github.ts";
import type { HolderWatch } from "../holderwatch.ts";
import { agentServices, arg, duration, extrasStore, log, lookupServices, mediaQueue, pageServices, pushService, rankServices, setup } from "./common.ts";

const { db, gh, accounts, all, registry } = setup();
const stopRegistry = registry.follow(60_000, () => log(`the Top list changed: ${registry.top.length} watched`));
const extrasDb = extrasStore();
// $PUSHD: the token panel, holder sign-in and the keeper (off until the addresses and its key are set)
const token = tokenServices({ db, handles: () => all.map((a) => a.handle), log });
const stopKeeper = startKeeper(db, token.config, log);
// web push for holders: off until the VAPID keys are set
const { push, stopPush } = pushService(db, token.holders);
if (!config.githubToken) log("no PUSHD_GITHUB_TOKEN: unauthenticated, 60 requests an hour, so fewer reads, in turn");
else log("GitHub: with a token (5,000 requests an hour, shared out by part)");
if (!config.openRouterKey) log("no PUSHD_OPENROUTER_KEY: summaries come from the repo's own description or README (no model calls, no cost)");
// the scouts, holders' own scouts and the agent API (MCP, REST, pay per call)
let hw: HolderWatch | null = null;
const ag = agentServices(db, all, gh, token, push, { db: extrasDb, watch: () => hw });
// the ranking: its passes run here, on their schedule (an hourly pass, a deeper daily one)
const noRank = arg("no-rank") !== undefined;
const { rc, ranker } = rankServices(db, !noRank);
const stopRank = noRank ? () => undefined : ranker.start();
const lk = lookupServices(db, extrasDb, registry, ranker, rc, ag.scouts);
hw = lk.holderWatch;
const server = createApi({
  db,
  accounts: all,
  top: registry.top,
  ranker,
  lookup: lk.lookup,
  holderWatch: lk.holderWatch,
  suggestions: lk.suggestions,
  adminKey: config.adminKey,
  authenticated: !!config.githubToken,
  publicDelayMinutes: config.publicDelayMinutes,
  liveKey: config.liveKey,
  mediaDir: config.mediaDir,
  token,
  push,
  scouts: ag.scouts,
  myScouts: ag.myScouts,
  agent: ag.agent,
  build: ag.build,
  ...pageServices(db, all, (h) => lk.lookup.lookedUp(h)),
});
const media = mediaQueue(db);
server.listen(config.port, config.host, () => log(`feed API on http://${config.host}:${config.port}`));
const extras = { db: extrasDb, gh: new GitHub({ db: extrasDb, spendDb: db, token: config.githubToken, log, part: "extra" }), list: () => lk.holderWatch.entries() };
const w = new Watcher({ db, gh, accounts, openRouterKey: config.openRouterKey, openRouterModel: config.openRouterModel, backfillHours: config.backfillHours, log, minGapMs: duration(arg("min-gap")), media, extras });
const forMs = duration(arg("for"));
let signalled = false;
const shutdown = () => {
  if (signalled) process.exit(0);
  signalled = true;
  stopKeeper();
  stopPush();
  stopRank();
  stopRegistry();
  ag.stop();
  w.stop();
  media?.stop();
  server.close();
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const until = forMs ? Date.now() + forMs : undefined;
// the picture queue works beside the watcher, and stops with it
const mediaDone = media?.run({ until });
await w.run({ until });
media?.stop();
await mediaDone;
// --serve-after keeps the API up once the watcher's time is over (for a local check of the site); a signal stops all
if (signalled || arg("serve-after") === undefined) {
  stopKeeper();
  server.close();
  server.closeAllConnections();
  db.close();
  log(`stopped after ${gh.requests} request(s), ${gh.notModified} unchanged (304)`);
} else log(`watcher stopped after ${gh.requests} request(s); the API stays up until stopped`);
