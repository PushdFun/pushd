// The watcher alone: `npm run watch [-- --only a,b --for 10m]`. It reads the Top N (live, as the ranking moves it) and
// holders' added accounts, and runs the ranking's passes on their schedule (src/rank).
import { config } from "../config.ts";
import { GitHub } from "../github.ts";
import { HolderWatch, watchConfigFromEnv } from "../holderwatch.ts";
import { Watcher } from "../watcher.ts";
import { arg, duration, extrasStore, log, mediaQueue, rankServices, setup } from "./common.ts";

const { db, gh, accounts, registry } = setup();
const stopRegistry = registry.follow(60_000, () => log(`the Top list changed: ${registry.top.length} watched`));
const media = mediaQueue(db);
const extrasDb = extrasStore();
const hw = new HolderWatch({ db, config: watchConfigFromEnv(), authenticated: !!config.githubToken, inTop: (l) => registry.inTop(l), account: async () => null });
const extras = { db: extrasDb, gh: new GitHub({ db: extrasDb, spendDb: db, token: config.githubToken, log, part: "extra" }), list: () => hw.entries() };
const { ranker } = rankServices(db, arg("no-rank") === undefined);
const stopRank = arg("no-rank") === undefined ? ranker.start() : () => undefined;
const w = new Watcher({ db, gh, accounts, openRouterKey: config.openRouterKey, openRouterModel: config.openRouterModel, backfillHours: config.backfillHours, log, minGapMs: duration(arg("min-gap")), media, extras });
const forMs = duration(arg("for"));
const stop = () => (stopRegistry(), stopRank(), w.stop(), media?.stop());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const until = forMs ? Date.now() + forMs : undefined;
const mediaDone = media?.run({ until });
await w.run({ until });
media?.stop();
await mediaDone;
stopRank();
stopRegistry();
log(`stopped after ${gh.requests} request(s), ${gh.notModified} unchanged (304)`);
db.close();
extrasDb.close();
