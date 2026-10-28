// $PUSHD's services for this process: the settings, the chain reader, the /v1/token panel with its cache, holder
// sign-in, and the keeper on a timer. With no burn pot set nothing reads the chain: the panel says "soon" and holder
// sign-in says it opens at launch.
import type { DB } from "../db.ts";
import { viemReader, scrub, type TokenReader } from "./chain.ts";
import { keeperStatus, tokenConfigFromEnv, type TokenConfig } from "./config.ts";
import { Holders } from "./holders.ts";
import { keeperChainFromEnv } from "./keeper-chain.ts";
import { keeperRecord, runKeeper, sqliteKeeperStore, type KeeperResult } from "./keeper.ts";
import { TokenPanels } from "./panel.ts";

export type TokenServices = {
  config: TokenConfig;
  reader: TokenReader;
  panels: TokenPanels;
  holders: Holders;
};

export function tokenServices(o: { db: DB; handles: string[] | (() => string[]); env?: Record<string, string | undefined>; reader?: TokenReader; now?: () => number; log?: (msg: string) => void }): TokenServices {
  const config = tokenConfigFromEnv(o.env);
  const reader = o.reader ?? viemReader(config.rpcUrl);
  const panels = new TokenPanels({ config, reader, db: o.db, now: o.now, log: o.log });
  const holders = new Holders({ db: o.db, config, reader, tokenAddress: () => panels.tokenAddress(), handles: o.handles, now: o.now });
  return { config, reader, panels, holders };
}

let stopping = false;
export const markStopping = () => {
  stopping = true;
};

/** One keeper run as the engine does it. Never throws; an error comes back scrubbed of anything like a key or a node. */
export async function keeperOnce(db: DB, config: TokenConfig, env: Record<string, string | undefined> = process.env): Promise<KeeperResult | { done: "off"; missing: string[] } | { done: "error"; reason: string }> {
  const st = keeperStatus(config);
  if (!st.on) return { done: "off", missing: st.missing };
  const chain = keeperChainFromEnv(config, env);
  if (!chain) return { done: "off", missing: ["A keeper key (PUSHD_KEEPER_KEY)."] };
  const store = sqliteKeeperStore(db);
  try {
    return await runKeeper({ chain, store, dailyGas: config.keeper.dailyGas, maxGwei: config.keeper.maxGwei, minGasWei: config.keeper.minGasWei, minSweepWei: config.keeper.minSweepWei, stopping: () => stopping });
  } catch (err) {
    const reason = scrub(String((err as Error)?.message ?? err));
    const k = keeperRecord(store);
    store.put({ ...k, failures: k.failures + 1, lastError: reason, lastRunAt: Date.now() });
    return { done: "error", reason };
  }
}

/** The keeper every PUSHD_KEEPER_EVERY_MINUTES, one run at a time, when it is on. Returns a stop function. */
export function startKeeper(db: DB, config: TokenConfig, log: (msg: string) => void): () => void {
  const st = keeperStatus(config);
  if (!st.on) {
    if (config.pot) log(`keeper off: ${st.missing.join(" ")}`);
    return () => undefined;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await keeperOnce(db, config);
      if (r.done === "error") log(`keeper: ${r.reason}`);
      else if (r.done === "ran" && (r.sweep || r.burn)) log(`keeper: sent ${[r.sweep && `a sweep (${r.sweep.tx})`, r.burn && `a burn (${r.burn.tx})`].filter(Boolean).join(" and ")}`);
      else if (r.done === "refused") log(`keeper: ${r.reason}`);
    } catch (err) {
      log(`keeper: ${scrub(String((err as Error)?.message ?? err))}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 30_000);
  const t = setInterval(tick, config.keeper.everyMinutes * 60_000);
  first.unref?.();
  t.unref?.();
  log(`keeper on, every ${config.keeper.everyMinutes} minutes`);
  return () => {
    markStopping();
    clearTimeout(first);
    clearInterval(t);
  };
}
