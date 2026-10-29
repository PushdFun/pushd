// The settings of PUSHD Agents: anyone's own agent that helps them ship on GitHub (src/agents). Not the agent API in
// src/agent, which lets AI agents read PUSHD. All from the environment (or engine/.env); off unless PUSHD_AGENTS=on.
//
//   PUSHD_AGENTS                     on: the builder, the GitHub App's webhook and the runs. Anything else: all off,
//                                    every /v1/build route answers 404 and nothing is followed or run
//   PUSHD_GH_APP_ID                  the PUSHD GitHub App (engine/scripts/github-app.ts makes it from a manifest)
//   PUSHD_GH_APP_SLUG                its name in GitHub's addresses (github.com/apps/<slug>)
//   PUSHD_GH_APP_PRIVATE_KEY         its private key, PEM (secret); "\n" written as two characters is read as a new line
//   PUSHD_GH_APP_WEBHOOK_SECRET      the webhook's secret (secret): every delivery's signature is checked against it
//   PUSHD_GH_APP_CLIENT_ID           sign-in with GitHub (the app's own user-to-server OAuth)
//   PUSHD_GH_APP_CLIENT_SECRET       (secret)
//
//   PUSHD_AGENTS_FREE_PER_DAY        runs a day without holding $PUSHD (5)
//   PUSHD_AGENTS_HOLDER_PER_HOUR     the fair-use guard for holders: runs an hour (30)
//   PUSHD_AGENTS_HOLDER_PER_DAY      and runs a UTC day (300)
//   PUSHD_AGENTS_DAILY_USD           a hard cap on all agents' model spend a UTC day (5); runs pause when it is reached
//   PUSHD_AGENTS_CALL_MAX_USD        one model call's worst-case estimate may not be over this (0.08)
//   PUSHD_AGENTS_RUN_PRICE_ETH       one paid run, in ETH, paid to the burn pot (0.00003, about $0.10)
//   PUSHD_AGENTS_TIERS               agents per GitHub account by holding, "min whole $PUSHD:agents,..." (as PUSHD_MY_SCOUT_TIERS:
//                                    1000000:1,5000000:3,20000000:5); without a holding: 1
//   PUSHD_AGENTS_MODEL               the model that turns plain words into an agent (anthropic/claude-haiku-5.5)
//   PUSHD_AGENTS_DRAFTS_PER_HOUR     plain-words drafts per GitHub account an hour (12)
//   PUSHD_AGENTS_WEBHOOKS_PER_MIN    webhook deliveries per installation a minute before they are dropped (120)
//   PUSHD_AGENTS_SESSION_DAYS        how long a sign-in with GitHub lasts (7)
//
//   PUSHD_SCOUTS_ORG                 the account that owns the scouts' own repos, pushd-scout-<id> (PushdFun)
//   PUSHD_SCOUT_BUILDS               off: the scouts do not build (on with PUSHD_AGENTS)
//   PUSHD_SCOUT_AUTOMERGE            on: a scout's daily pull request is merged in its own repo (and only there); off by default
import { parseTiers, type Tier } from "../scouts/config.ts";
import { toWei } from "../token/config.ts";

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const modelId = (v: string | undefined, d: string) => (/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v?.trim() ?? "") ? v!.trim() : d);

export type AgentsConfig = {
  on: boolean;
  app: {
    id: string | null;
    slug: string | null;
    privateKey: string | null;
    webhookSecret: string | null;
    clientId: string | null;
    clientSecret: string | null;
  };
  freePerDay: number;
  holderPerHour: number;
  holderPerDay: number;
  dailyUsd: number;
  callMaxUsd: number;
  runPriceWei: bigint;
  tiers: Tier[];
  model: string;
  draftsPerHour: number;
  webhooksPerMin: number;
  sessionDays: number;
  scoutsOrg: string;
  scoutBuilds: boolean;
  scoutAutomerge: boolean;
};

/** A PEM key as the host stores it: real new lines, or "\n" typed as two characters. Null unless it looks like one. */
export function pemFrom(v: string | undefined): string | null {
  const s = (v ?? "").replace(/\\n/g, "\n").trim();
  return /^-----BEGIN (RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (RSA )?PRIVATE KEY-----$/.test(s) ? s : null;
}

export function agentsConfigFromEnv(env: Env = process.env): AgentsConfig {
  const t = (k: string) => env[k]?.trim() || null;
  return {
    on: env.PUSHD_AGENTS?.trim().toLowerCase() === "on",
    app: {
      id: /^\d{1,12}$/.test(t("PUSHD_GH_APP_ID") ?? "") ? t("PUSHD_GH_APP_ID") : null,
      slug: /^[a-z0-9][a-z0-9-]{0,60}$/.test(t("PUSHD_GH_APP_SLUG") ?? "") ? t("PUSHD_GH_APP_SLUG") : null,
      privateKey: pemFrom(env.PUSHD_GH_APP_PRIVATE_KEY),
      webhookSecret: (t("PUSHD_GH_APP_WEBHOOK_SECRET")?.length ?? 0) >= 16 ? t("PUSHD_GH_APP_WEBHOOK_SECRET") : null,
      clientId: /^[A-Za-z0-9.]{8,64}$/.test(t("PUSHD_GH_APP_CLIENT_ID") ?? "") ? t("PUSHD_GH_APP_CLIENT_ID") : null,
      clientSecret: (t("PUSHD_GH_APP_CLIENT_SECRET")?.length ?? 0) >= 16 ? t("PUSHD_GH_APP_CLIENT_SECRET") : null,
    },
    freePerDay: num(env.PUSHD_AGENTS_FREE_PER_DAY, 5, 0, 1000),
    holderPerHour: num(env.PUSHD_AGENTS_HOLDER_PER_HOUR, 30, 1, 100_000),
    holderPerDay: num(env.PUSHD_AGENTS_HOLDER_PER_DAY, 300, 1, 1_000_000),
    dailyUsd: num(env.PUSHD_AGENTS_DAILY_USD, 5, 0, 10_000),
    callMaxUsd: num(env.PUSHD_AGENTS_CALL_MAX_USD, 0.08, 0, 10),
    runPriceWei: toWei(env.PUSHD_AGENTS_RUN_PRICE_ETH) ?? toWei("0.00003")!,
    tiers: parseTiers(env.PUSHD_AGENTS_TIERS ?? env.PUSHD_MY_SCOUT_TIERS),
    model: modelId(env.PUSHD_AGENTS_MODEL, "anthropic/claude-haiku-5.5"),
    draftsPerHour: num(env.PUSHD_AGENTS_DRAFTS_PER_HOUR, 12, 1, 1000),
    webhooksPerMin: num(env.PUSHD_AGENTS_WEBHOOKS_PER_MIN, 120, 1, 100_000),
    sessionDays: num(env.PUSHD_AGENTS_SESSION_DAYS, 7, 1, 90),
    scoutsOrg: /^[A-Za-z0-9-]{1,39}$/.test(t("PUSHD_SCOUTS_ORG") ?? "") ? t("PUSHD_SCOUTS_ORG")! : "PushdFun",
    scoutBuilds: env.PUSHD_SCOUT_BUILDS?.trim().toLowerCase() !== "off",
    scoutAutomerge: env.PUSHD_SCOUT_AUTOMERGE?.trim().toLowerCase() === "on",
  };
}

/** What is missing for the GitHub side to work; empty when the app is fully set. */
export function appMissing(c: AgentsConfig): string[] {
  const m: string[] = [];
  if (!c.app.id) m.push("PUSHD_GH_APP_ID");
  if (!c.app.slug) m.push("PUSHD_GH_APP_SLUG");
  if (!c.app.privateKey) m.push("PUSHD_GH_APP_PRIVATE_KEY");
  if (!c.app.webhookSecret) m.push("PUSHD_GH_APP_WEBHOOK_SECRET");
  if (!c.app.clientId) m.push("PUSHD_GH_APP_CLIENT_ID");
  if (!c.app.clientSecret) m.push("PUSHD_GH_APP_CLIENT_SECRET");
  return m;
}
