// The settings of the agent layer: the scouts, the holders' own scouts and the agent API. All from the environment
// (or engine/.env); nothing is required. With no OpenRouter key the scouts write from templates (labelled as such)
// and no model is ever called.
//
//   PUSHD_OPENROUTER_KEY            the model key (secret). Locally, ~/.pushd-openrouter-key is read when the variable
//                                   is empty and that file exists. Never logged or shown.
//   PUSHD_SCOUTS                    off: no scout calls at all (the template ones neither)
//   PUSHD_SCOUT_MODEL               the model for holders' own scouts (drafting a rule, the note on a hit); each of the five
//                                   scouts runs on its own model, set in scouts/roster.ts (anthropic/claude-haiku-5.5)
//   PUSHD_SCOUT_DEEP_MODEL          a fallback deep model (anthropic/claude-sonnet-5.5)
//   PUSHD_SCOUT_MODEL_PRICE         "in,out" USD per million tokens of the cheap model, for the estimate before a call (0.10,0.40)
//   PUSHD_SCOUT_DEEP_MODEL_PRICE    the same for the deep model (0.30,2.50)
//   PUSHD_SCOUT_DAILY_USD           a hard cap on model spend a UTC day, every scout call counted (2)
//   PUSHD_SCOUT_CALL_MAX_USD        a cap on one call's estimated cost; a call over it is not made (0.03)
//   PUSHD_SCOUT_GAP_MS              the queue's pause between two model calls (1500)
//   PUSHD_SCOUT_README_BYTES        how much of a README a deep read takes (12000)
//   PUSHD_SCOUT_FILES               how many main files a deep read opens (3), each at most PUSHD_SCOUT_FILE_BYTES (6000)
//   PUSHD_SCOUT_TREE                how many paths of the file tree a deep read lists (300)
//   PUSHD_SCOUT_CATCHUP             how many stored lines without a call get a model call on start (20); the rest a template
//   PUSHD_SCOUT_HOURLY_USD          a hard cap on model spend in any one hour (0.4)
//   PUSHD_SCOUT_MODEL_CALLS_PER_DAY at most this many calls to any one model a UTC day (150)
//   PUSHD_SCOUT_MIN_HEAT            the quality gate: a line under this watcher score gets a template call, no model (4)
//   PUSHD_SCOUT_DEEP_MIN_HEAT       deep reads only for new repos and releases at this score or more (6)
//   PUSHD_SCOUT_DEDUPE_HOURS        no second model call on the same repo within this many hours (12)
//
//   PUSHD_MY_SCOUT_TIERS            holders' own scouts by holding: "min whole $PUSHD:scouts,..." (1000000:1,5000000:3,20000000:5)
//   PUSHD_MY_SCOUT_DRAFTS_PER_HOUR  plain-words drafts a holder may ask for an hour (12)
//   PUSHD_MY_SCOUT_SAVES_PER_HOUR   saves and edits a holder may make an hour (30)
//
//   PUSHD_AGENT_PAID                off: the paid tools stay closed even with the burn pot set
//   PUSHD_AGENT_PRICE_LIVE_ETH      the live feed tool, per call (0.00002)
//   PUSHD_AGENT_PRICE_DEEP_READ_ETH the deep read tool, per call (0.0003)
//   PUSHD_AGENT_PAY_MAX_AGE_MIN     how recent a payment must be (30)
//   PUSHD_AGENT_FREE_PER_MIN        free calls a minute per client without a key (30)
//   PUSHD_AGENT_KEY_PER_MIN         free calls a minute with an API key (120)
//   PUSHD_AGENT_PAID_PER_HOUR       paid calls an hour per paying wallet (600)
//   PUSHD_AGENT_TRUST_PROXY         1: trust X-Forwarded-For from any peer (the site's proxy on another host); loopback peers are always trusted
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toWei } from "../token/config.ts";
import { SCOUTS } from "./roster.ts";

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const price = (v: string | undefined, d: [number, number]): [number, number] => {
  const p = (v ?? "").split(",").map((x) => Number(x.trim()));
  return p.length === 2 && p.every((x) => Number.isFinite(x) && x >= 0 && x < 1000) ? [p[0], p[1]] : d;
};
const modelId = (v: string | undefined, d: string) => (/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v?.trim() ?? "") ? v!.trim() : d);

export type Tier = { minWhole: bigint; scouts: number };

/** "1000000:1,5000000:3" to tiers, lowest first; the default when it does not read. */
export function parseTiers(v: string | undefined): Tier[] {
  const d: Tier[] = [
    { minWhole: 1_000_000n, scouts: 1 },
    { minWhole: 5_000_000n, scouts: 3 },
    { minWhole: 20_000_000n, scouts: 5 },
  ];
  if (!v?.trim()) return d;
  const out: Tier[] = [];
  for (const part of v.split(",")) {
    const m = /^\s*(\d{1,24})\s*:\s*(\d{1,2})\s*$/.exec(part);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 20) return d;
    out.push({ minWhole: BigInt(m[1]), scouts: Number(m[2]) });
  }
  return out.sort((a, b) => (a.minWhole < b.minWhole ? -1 : 1));
}

/** The key: the environment first, then (local runs) the key file in the home folder. Never logged. */
export function openRouterKey(env: Env = process.env, keyFile = join(homedir(), ".pushd-openrouter-key")): string | null {
  const v = env.PUSHD_OPENROUTER_KEY?.trim();
  if (v) return v;
  if (!keyFile || !existsSync(keyFile)) return null;
  try {
    const k = readFileSync(keyFile, "utf8").trim();
    return k.length >= 10 && k.length < 300 && !/\s/.test(k) ? k : null;
  } catch {
    return null;
  }
}

export type ScoutConfig = {
  on: boolean;
  key: string | null;
  model: string;
  deepModel: string;
  /** USD per million tokens, [in, out] */
  prices: Record<string, [number, number]>;
  dailyUsd: number;
  callMaxUsd: number;
  gapMs: number;
  readmeBytes: number;
  files: number;
  fileBytes: number;
  tree: number;
  catchup: number;
  hourlyUsd: number;
  modelCallsPerDay: number;
  minHeat: number;
  deepMinHeat: number;
  dedupeHours: number;
  my: { tiers: Tier[]; draftsPerHour: number; savesPerHour: number };
  agent: {
    paidSwitch: boolean;
    priceLiveWei: bigint;
    priceDeepWei: bigint;
    payMaxAgeMs: number;
    freePerMin: number;
    keyPerMin: number;
    paidPerHour: number;
    trustProxy: boolean;
  };
};

export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_DEEP_MODEL = "anthropic/claude-sonnet-5.5";

/**
 * The settings. The key is the environment's only, unless the caller hands one in: the commands hand in
 * openRouterKey() (which also reads the local key file); the tests never do, so no test can reach a real model.
 */
export function scoutConfigFromEnv(env: Env = process.env, o: { key?: string | null } = {}): ScoutConfig {
  const model = modelId(env.PUSHD_SCOUT_MODEL, DEFAULT_MODEL);
  const deepModel = modelId(env.PUSHD_SCOUT_DEEP_MODEL, DEFAULT_DEEP_MODEL);
  const prices: Record<string, [number, number]> = {};
  prices[model] = price(env.PUSHD_SCOUT_MODEL_PRICE, [0.1, 0.4]);
  prices[deepModel] = price(env.PUSHD_SCOUT_DEEP_MODEL_PRICE, model === deepModel ? prices[model] : [2, 10]);
  // each scout runs on its own models (scouts/roster.ts); their prices join the table the budget estimates from
  for (const s of SCOUTS) {
    prices[s.model] ??= s.price;
    prices[s.deepModel] ??= s.deepPrice;
  }
  return {
    on: env.PUSHD_SCOUTS?.trim().toLowerCase() !== "off",
    key: o.key !== undefined ? o.key : env.PUSHD_OPENROUTER_KEY?.trim() || null,
    model,
    deepModel,
    prices,
    dailyUsd: num(env.PUSHD_SCOUT_DAILY_USD, 2, 0, 1000),
    callMaxUsd: num(env.PUSHD_SCOUT_CALL_MAX_USD, 0.03, 0, 10),
    gapMs: num(env.PUSHD_SCOUT_GAP_MS, 1500, 0, 600_000),
    readmeBytes: num(env.PUSHD_SCOUT_README_BYTES, 12_000, 500, 64_000),
    files: num(env.PUSHD_SCOUT_FILES, 3, 0, 8),
    fileBytes: num(env.PUSHD_SCOUT_FILE_BYTES, 6_000, 500, 32_000),
    tree: num(env.PUSHD_SCOUT_TREE, 300, 0, 2_000),
    catchup: num(env.PUSHD_SCOUT_CATCHUP, 20, 0, 500),
    hourlyUsd: num(env.PUSHD_SCOUT_HOURLY_USD, 0.4, 0, 1000),
    modelCallsPerDay: num(env.PUSHD_SCOUT_MODEL_CALLS_PER_DAY, 150, 0, 100_000),
    minHeat: num(env.PUSHD_SCOUT_MIN_HEAT, 4, 0, 10),
    deepMinHeat: num(env.PUSHD_SCOUT_DEEP_MIN_HEAT, 6, 0, 10),
    dedupeHours: num(env.PUSHD_SCOUT_DEDUPE_HOURS, 12, 0, 24 * 30),
    my: {
      tiers: parseTiers(env.PUSHD_MY_SCOUT_TIERS),
      draftsPerHour: num(env.PUSHD_MY_SCOUT_DRAFTS_PER_HOUR, 12, 1, 1000),
      savesPerHour: num(env.PUSHD_MY_SCOUT_SAVES_PER_HOUR, 30, 1, 1000),
    },
    agent: {
      paidSwitch: env.PUSHD_AGENT_PAID?.trim().toLowerCase() !== "off",
      priceLiveWei: toWei(env.PUSHD_AGENT_PRICE_LIVE_ETH) ?? toWei("0.00002")!,
      priceDeepWei: toWei(env.PUSHD_AGENT_PRICE_DEEP_READ_ETH) ?? toWei("0.0003")!,
      payMaxAgeMs: num(env.PUSHD_AGENT_PAY_MAX_AGE_MIN, 30, 1, 24 * 60) * 60_000,
      freePerMin: num(env.PUSHD_AGENT_FREE_PER_MIN, 30, 1, 10_000),
      keyPerMin: num(env.PUSHD_AGENT_KEY_PER_MIN, 120, 1, 100_000),
      paidPerHour: num(env.PUSHD_AGENT_PAID_PER_HOUR, 600, 1, 1_000_000),
      trustProxy: env.PUSHD_AGENT_TRUST_PROXY?.trim() === "1",
    },
  };
}
