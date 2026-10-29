// The /v1/build routes: PUSHD Agents over HTTP, for the site's proxy (web/src/app/api/build). Off (404 for all) unless
// PUSHD_AGENTS=on. A person's GitHub session comes in X-PUSHD-GH-Session; a holder's wallet session, when the browser
// has one, in Authorization: Bearer (it links the wallet, and it is what a scout vote is cast with).
//
//   GET    /v1/build/config                     what the builder needs: jobs, triggers, models, free runs, price, paused
//   GET    /v1/build/github/authorize           ?state= &redirect= -> { url }  where sign-in with GitHub starts
//   POST   /v1/build/github/oauth               { code, redirectUri } -> { session, expiresAt, user }
//   POST   /v1/build/github/webhook             GitHub's deliveries (signature checked over the raw body)
//   GET    /v1/build/me                         the person, their repos, agents, runs left, inbox
//   DELETE /v1/build/session                    sign out
//   POST   /v1/build/draft                      { text } -> { spec, source, notes }
//   GET    /v1/build/agents, POST               list; save (new, or an edit with id)
//   GET    /v1/build/agents/:id                 { agent, runs }   PATCH { paused, proof }   DELETE
//   POST   /v1/build/agents/:id/run             { job, repo, request?, kind?, pr?, issue? } -> { run } or 402 with the price
//   POST   /v1/build/runs/:id/pay               { tx, signature } -> { run }
//   POST   /v1/build/runs/:id/approve           { index, post } -> { run }
//   POST   /v1/build/inbox/seen
//   GET    /v1/build/shipped/:owner/:repo       the public page of what agents shipped on a repo
//   GET    /v1/build/scouts, POST /v1/build/scouts/vote { scout, option }
import type { IncomingMessage, ServerResponse } from "node:http";
import { ethString } from "../agent/payments.ts";
import { SCOUTS } from "../scouts/roster.ts";
import { Agents, AgentsError } from "./agents.ts";
import { appMissing, type AgentsConfig } from "./config.ts";
import type { GitHubApp } from "./github-app.ts";
import type { ScoutBuilds } from "./scoutbuilds.ts";
import { JOB_IDS, JOBS, TRIGGER_LABEL, TRIGGERS } from "./spec.ts";

export type BuildRoutes = { handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> };

const readRaw = (req: IncomingMessage, max: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new AgentsError(413, "too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

const json = async (req: IncomingMessage, max = 16_384): Promise<Record<string, unknown>> => {
  const raw = await readRaw(req, max);
  if (!raw.length) return {};
  try {
    const v = JSON.parse(raw.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    throw new AgentsError(400, "the body is not JSON");
  }
};

const h = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function buildRoutes(o: { agents: Agents; config: AgentsConfig; app: GitHubApp | null; scouts: ScoutBuilds | null; trustProxy: boolean }): BuildRoutes {
  const { agents, config } = o;
  const visitor = (req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? "";
    const loop = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const f = h(req, "x-forwarded-for")?.split(",")[0]?.trim();
    return (loop || o.trustProxy) && f ? f.slice(0, 64) : peer;
  };
  const bearer = (req: IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(h(req, "authorization") ?? "")?.[1] ?? null;
  const signedIn = (req: IncomingMessage) => {
    const u = agents.session(h(req, "x-pushd-gh-session"));
    if (!u) throw new AgentsError(401, "not signed in");
    return u;
  };

  const config_ = () => ({
    on: true,
    ready: appMissing(config).length === 0,
    signIn: !!(config.app.clientId && config.app.clientSecret),
    installUrl: o.app?.installUrl ?? null,
    freePerDay: config.freePerDay,
    price: { wei: config.runPriceWei.toString(), eth: ethString(config.runPriceWei) },
    paused: agents.paused,
    jobs: JOB_IDS.map((id) => ({ id, title: JOBS[id].title, what: JOBS[id].what, triggers: JOBS[id].triggers, byDefault: JOBS[id].byDefault, free: !!JOBS[id].free })),
    triggers: TRIGGERS.map((t) => ({ id: t, label: TRIGGER_LABEL[t] })),
    models: SCOUTS.map((s) => ({ id: s.id, name: s.name, maker: s.maker, model: s.modelName })),
    scoutsOrg: config.scoutsOrg,
    stats: agents.stats(),
  });

  return {
    async handle(req, res, path, url) {
      if (!path.startsWith("/v1/build")) return false;
      const m = req.method ?? "GET";
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(body));
      };
      try {
        if (path === "/v1/build/config" && m === "GET") return (send(200, config_()), true);
        if (path === "/v1/build/github/webhook" && m === "POST") {
          const raw = await readRaw(req, 2_000_000);
          const hd = { "x-hub-signature-256": h(req, "x-hub-signature-256"), "x-github-delivery": h(req, "x-github-delivery"), "x-github-event": h(req, "x-github-event") };
          const r = await agents.webhook(hd, raw);
          return (send(r.status, r.body), true);
        }
        if (path === "/v1/build/github/authorize" && m === "GET") {
          const state = url.searchParams.get("state") ?? "";
          const redirect = url.searchParams.get("redirect") ?? "";
          if (!/^[A-Za-z0-9_-]{16,100}$/.test(state) || !/^https?:\/\/\S{1,200}$/.test(redirect)) throw new AgentsError(400, "Not a valid sign-in start.");
          const u = o.app?.authorizeUrl(state, redirect);
          if (!u) throw new AgentsError(409, "Sign-in with GitHub is not set up yet.");
          return (send(200, { url: u }), true);
        }
        if (path === "/v1/build/github/oauth" && m === "POST") {
          const b = await json(req);
          return (send(200, await agents.signIn(b.code, b.redirectUri, visitor(req))), true);
        }
        const shipped = /^\/v1\/build\/shipped\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(path);
        if (shipped && m === "GET") {
          const p = agents.shippedOn(`${shipped[1]}/${shipped[2]}`);
          if (!p) throw new AgentsError(404, "Nothing shipped by an agent on that repo yet.");
          return (send(200, p), true);
        }
        if (path === "/v1/build/scouts" && m === "GET") {
          if (!o.scouts) throw new AgentsError(404, "The scouts do not build here.");
          return (send(200, { scouts: o.scouts.view(agents.walletOf(bearer(req))), org: config.scoutsOrg }), true);
        }
        if (path === "/v1/build/scouts/vote" && m === "POST") {
          if (!o.scouts) throw new AgentsError(404, "The scouts do not build here.");
          const b = await json(req);
          return (send(200, await o.scouts.vote(agents.walletOf(bearer(req)), b.scout, b.option)), true);
        }
        if (path === "/v1/build/session" && m === "DELETE") {
          agents.signOut(h(req, "x-pushd-gh-session"));
          res.writeHead(204, { "cache-control": "no-store" });
          return (res.end(), true);
        }
        const u = signedIn(req);
        if (path === "/v1/build/me" && m === "GET") return (send(200, await agents.me(u.id, bearer(req))), true);
        if (path === "/v1/build/inbox/seen" && m === "POST") return (agents.seen(u.id), send(200, { ok: true }), true);
        if (path === "/v1/build/draft" && m === "POST") return (send(200, await agents.draft(u.id, (await json(req)).text)), true);
        if (path === "/v1/build/agents" && m === "GET") return (send(200, { agents: agents.list(u.id) }), true);
        if (path === "/v1/build/agents" && m === "POST") return (send(200, { agent: await agents.save(u.id, await json(req)) }), true);
        const one = /^\/v1\/build\/agents\/([a-f0-9]{16})(\/run)?$/.exec(path);
        if (one && !one[2] && m === "GET") return (send(200, agents.one(u.id, one[1])), true);
        if (one && !one[2] && m === "PATCH") return (send(200, { agent: agents.settings(u.id, one[1], await json(req)) }), true);
        if (one && !one[2] && m === "DELETE") return (send(200, agents.remove(u.id, one[1])), true);
        if (one && one[2] && m === "POST") return (send(200, { run: await agents.request(u.id, one[1], await json(req)) }), true);
        const run = /^\/v1\/build\/runs\/([a-f0-9]{16})\/(pay|approve)$/.exec(path);
        if (run && m === "POST") return (send(200, { run: run[2] === "pay" ? await agents.pay(u.id, run[1], await json(req)) : await agents.approve(u.id, run[1], await json(req)) }), true);
        throw new AgentsError(404, "not found");
      } catch (e) {
        if (e instanceof AgentsError) {
          send(e.status, { error: e.message, ...e.body });
          return true;
        }
        throw e;
      }
    },
  };
}
