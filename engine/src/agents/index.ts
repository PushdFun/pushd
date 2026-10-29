// PUSHD Agents for one engine process: the settings, the GitHub App, the service, the scouts' builds and the routes,
// all from the environment. Null (and nothing started, every /v1/build route a 404) unless PUSHD_AGENTS=on.
import type { Payments } from "../agent/payments.ts";
import type { DB } from "../db.ts";
import type { ModelProvider } from "../scouts/provider.ts";
import type { TokenServices } from "../token/local.ts";
import { Agents } from "./agents.ts";
import { agentsConfigFromEnv, appMissing, type AgentsConfig } from "./config.ts";
import { GitHubApp } from "./github-app.ts";
import { realOutside, type Outside } from "./jobs.ts";
import { buildRoutes, type BuildRoutes } from "./routes.ts";
import { ScoutBuilds } from "./scoutbuilds.ts";

export type BuildServices = {
  config: AgentsConfig;
  agents: Agents;
  scouts: ScoutBuilds | null;
  routes: BuildRoutes;
  /** the feed's tag: a line an agent shipped */
  shipped: (it: { url: string | null; kind: string }) => boolean;
  stop: () => void;
};

export function buildServices(o: {
  db: DB;
  token: TokenServices;
  payments: Payments;
  provider: ModelProvider | null;
  push: { sendTo(address: string, payload: string, urgent: boolean): Promise<number>; on: boolean } | null;
  trustProxy: boolean;
  env?: Record<string, string | undefined>;
  /** the tests hand in a pretend GitHub and outside sources */
  fetchImpl?: typeof fetch;
  outside?: Outside;
  ghApi?: string;
  ghWeb?: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** false: no timers (the tests drive the worker themselves) */
  start?: boolean;
}): BuildServices | null {
  const config = agentsConfigFromEnv(o.env ?? process.env);
  if (!config.on) return null;
  const missing = appMissing(config);
  const app =
    config.app.id && config.app.privateKey
      ? new GitHubApp({ appId: config.app.id, privateKey: config.app.privateKey, clientId: config.app.clientId, clientSecret: config.app.clientSecret, slug: config.app.slug, fetchImpl: o.fetchImpl, now: o.now, api: o.ghApi, web: o.ghWeb })
      : null;
  if (missing.length) o.log?.(`agents: on, but the GitHub App is not fully set (${missing.join(", ")})`);
  const agents = new Agents({
    db: o.db,
    config,
    app,
    provider: o.provider,
    payments: o.payments,
    holding: async (w) => {
      const st = await o.token.holders.status(w);
      return { holder: st.holder, balanceWei: st.balanceWei == null ? null : BigInt(st.balanceWei) };
    },
    holderSession: (t) => o.token.holders.session(t)?.address ?? null,
    push: o.push,
    outside: o.outside ?? realOutside(o.fetchImpl),
    siteUrl: o.token.config.holder.siteUrl,
    now: o.now,
    log: o.log,
  });
  const scouts = config.scoutBuilds ? new ScoutBuilds({ db: o.db, agents, config, isHolder: async (w) => (await o.token.holders.status(w)).holder, now: o.now, log: o.log }) : null;
  if (scouts) {
    scouts.ensure();
    agents.onScoutPush = scouts.onPush;
    agents.scoutRunner = scouts.run;
  }
  const routes = buildRoutes({ agents, config, app, scouts, trustProxy: o.trustProxy });
  const stop = o.start === false ? () => undefined : agents.start({ extra: () => scouts?.tick() ?? Promise.resolve(0) });
  o.log?.(`agents: on${app ? "" : " (no GitHub App yet: sign-in and runs wait for it)"}`);
  return { config, agents, scouts, routes, shipped: (it) => agents.shipped(it), stop };
}
