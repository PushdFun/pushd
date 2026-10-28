// The ranking by hand: `npm run rank -- --deep` (gather the pool again and rank), `--hourly` (the archive, the markets
// and a rank), `--show` (the current Top N). The watcher's process runs the same passes on their schedule.
import { config } from "../config.ts";
import { GitHub } from "../github.ts";
import { shareRoom } from "../plan.ts";
import { rankConfigFromEnv } from "../rank/config.ts";
import { Pool } from "../rank/pool.ts";
import { Ranker } from "../rank/ranker.ts";
import { arg, log, setup } from "./common.ts";

const { db } = setup();
const auth = !!config.githubToken;
const rc = rankConfigFromEnv(process.env, auth);
const search = new GitHub({ db, token: config.githubToken, log, part: "search" });
const core = new GitHub({ db, token: config.githubToken, log, part: "rank", wait: false });
const pool = new Pool({ db, config: rc, search, core, log, coreRoom: () => shareRoom(db, "rank", auth) });
const ranker = new Ranker({ db, config: rc, pool, authenticated: auth, log });
if (arg("deep") !== undefined) await ranker.deep();
else if (arg("hourly") !== undefined) await ranker.hourly();
else if (arg("rank") !== undefined) ranker.rank("manual");
const v = ranker.top();
console.log(`pool ${v.pool}, Top ${v.rows.length}, camps ${JSON.stringify(v.byCamp)}`);
for (const r of v.rows) console.log(`${String(r.rank).padStart(3)}  ${r.score.toFixed(1).padStart(5)}  ${r.group.padEnd(10)} ${r.handle.padEnd(28)} ${(r.org ?? "").padEnd(12)} ${r.token?.chain ?? ""} ${r.token?.pairDays ?? ""}d`);
db.close();
