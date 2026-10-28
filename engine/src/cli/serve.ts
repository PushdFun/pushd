// The feed API alone: `npm run serve`. It reads the store the watcher writes (the feed, the ranking) and follows the
// ranking's Top N as it changes.
import { createApi } from "../api.ts";
import { config } from "../config.ts";
import { startKeeper, tokenServices } from "../token/local.ts";
import { agentServices, extrasStore, log, lookupServices, pageServices, pushService, rankServices, setup } from "./common.ts";
import type { HolderWatch } from "../holderwatch.ts";

const { db, all, gh, registry } = setup();
const stopRegistry = registry.follow(60_000, () => log(`the Top list changed: ${registry.top.length} watched`));
const extrasDb = extrasStore();
// $PUSHD: the token panel, holder sign-in and the keeper (off until the addresses and its key are set)
const token = tokenServices({ db, handles: () => all.map((a) => a.handle), log });
const stopKeeper = startKeeper(db, token.config, log);
// web push for holders: off until the VAPID keys are set
const { push, stopPush } = pushService(db, token.holders);
let hw: HolderWatch | null = null;
// the scouts, holders' own scouts and the agent API (MCP, REST, pay per call)
const ag = agentServices(db, all, gh, token, push, { db: extrasDb, watch: () => hw });
const { rc, ranker } = rankServices(db, false);
const lk = lookupServices(db, extrasDb, registry, ranker, rc, ag.scouts);
hw = lk.holderWatch;
log(config.githubToken ? "GitHub: with a token (5,000 requests an hour, shared out by part)" : "GitHub: no token (60 requests an hour): lookups are slow and few");
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
  ...pageServices(db, all, (h) => lk.lookup.lookedUp(h)),
});
server.listen(config.port, config.host, () => log(`feed API on http://${config.host}:${config.port} (public delay ${config.publicDelayMinutes} min, ${registry.top.length} watched)`));
const stop = () => (stopRegistry(), stopKeeper(), stopPush(), ag.stop(), server.close(() => (db.close(), extrasDb.close(), process.exit(0))));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
