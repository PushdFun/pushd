// One keeper run now, as the engine's timer does it: `npm run keeper`. A sweep and a burn when they are due, nothing
// otherwise. Prints what it did and the keeper's numbers; never the key. Off unless PUSHD_KEEPER_KEY and both
// addresses are set (and PUSHD_KEEPER is not off).
import { config as engineConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { tokenConfigFromEnv } from "../token/config.ts";
import { keeperRecord, sqliteKeeperStore } from "../token/keeper.ts";
import { keeperOnce } from "../token/local.ts";
import { log } from "./common.ts";

const db = openDb(engineConfig.dbPath);
const c = tokenConfigFromEnv();
const r = await keeperOnce(db, c);
if (r.done === "off") log(`keeper off: ${r.missing.join(" ")}`);
else if (r.done === "error") log(`keeper failed: ${r.reason}`);
else if (r.done === "refused") log(`keeper refused: ${r.reason}`);
else if (r.done === "waiting") log(`keeper waiting for ${r.tx}`);
else if (r.done === "busy") log("keeper busy");
else log(`keeper ran: ${r.sweep ? `sweep ${r.sweep.tx} (${r.sweep.split} wei)` : "no sweep"}; ${r.burn ? `burn ${r.burn.tx}` : "no burn"}${r.notes.length ? `; ${r.notes.join(" ")}` : ""}`);
const k = keeperRecord(sqliteKeeperStore(db));
log(`keeper ${k.account ?? "?"}: ${k.runs} runs, ${k.sweeps} sweeps, ${k.burns} burns, ${k.failures} failures${k.lastError ? ` (last: ${k.lastError})` : ""}`);
db.close();
process.exit(r.done === "error" ? 1 : 0);
