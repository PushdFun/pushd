/**
 * SERVER ONLY. The launch page's pieces for this server: the settings, the
 * reader on the configured node and contracts/launch.json, read from disk on
 * every call so the page and contracts/token-launch.sh always see the same
 * file. No Next.js imports, so the fork rehearsal (scripts/launch-rehearsal.ts)
 * runs exactly these.
 *
 *   PUSHD_LAUNCH_PAGE              on: /token/launch exists. Anything else: 404
 *   PUSHD_LAUNCH_OPENING_BUY_WEI   the opening buy, whole wei, digits only (10000000000000000 is 0.01 ETH)
 *   PUSHD_LAUNCH_FILE              the launch file; contracts/launch.json next to web/ by default
 *   PUSHD_BURN_POT_ADDRESS, PUSHD_SPLITTER_ADDRESS, PUSHD_TOKEN_RPC_URL, PUSHD_EXPLORER_URL
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { siteTokenConfig } from "./config";
import { launchSettingsFromEnv, type LaunchDeps } from "./launch";
import { viemLaunchReader } from "./launch-chain";

/** The launch file: PUSHD_LAUNCH_FILE, else the repo's contracts/launch.json (the site runs from web/). */
export const LAUNCH_FILE = (env: Record<string, string | undefined> = process.env) => {
  const set = env.PUSHD_LAUNCH_FILE?.trim();
  if (set) return isAbsolute(set) ? set : resolve(/*turbopackIgnore: true*/ process.cwd(), set);
  return join(/*turbopackIgnore: true*/ process.cwd(), "..", "contracts", "launch.json");
};

/** contracts/launch.json as parsed JSON, or a marker the checks turn into a sentence. Read at request time, never bundled. */
export function readLaunchFile(path = LAUNCH_FILE()): unknown {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8"));
  } catch {
    return null;
  }
}

export function launchDeps(env: Record<string, string | undefined> = process.env): LaunchDeps {
  const config = siteTokenConfig(env);
  return { reader: viemLaunchReader(config.rpcUrl), settings: launchSettingsFromEnv(env, config.explorer), launchFile: readLaunchFile(LAUNCH_FILE(env)) };
}
