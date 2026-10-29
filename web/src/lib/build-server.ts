import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { engineUrl, holderSession } from "./data";
import type { AgentView, BuildConfig, BuildMe, RunView, ScoutBuild, Shipped } from "./build";

// PUSHD Agents on the server side of the site. The switch is PUSHD_AGENTS (the same as the engine's): anything but
// "on" and every page and route of it is a 404 and the nav has no Build entry. The GitHub sign-in is a session of the
// engine's, kept here in an httpOnly cookie (pushd_gh); the site never sees a GitHub token.
//
//   GET /v1/build/config, /v1/build/me, /v1/build/agents/:id, /v1/build/shipped/:owner/:repo, /v1/build/scouts

import { agentsOn } from "./build-switch";

export { agentsOn };

export const GH_COOKIE = "pushd_gh";
export const GH_STATE = "pushd_gh_state";
const SESSION_RE = /^[A-Za-z0-9_-]{20,100}$/;

export async function ghSession(): Promise<string | null> {
  const v = (await cookies()).get(GH_COOKIE)?.value ?? "";
  return SESSION_RE.test(v) ? v : null;
}

/** One call to the engine's /v1/build with the GitHub session and, when there is one, the holder's. */
export async function buildFetch(path: string, o: { method?: string; body?: unknown; gh?: string | null; holder?: string | null; ip?: string | null; timeoutMs?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = engineUrl();
  if (!base) return { status: 503, body: { error: "PUSHD's engine is not connected here." } };
  try {
    const res = await fetch(base + path, {
      method: o.method ?? "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      headers: {
        accept: "application/json",
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(o.gh ? { "x-pushd-gh-session": o.gh } : {}),
        ...(o.holder ? { authorization: `Bearer ${o.holder}` } : {}),
        ...(o.ip ? { "x-forwarded-for": o.ip } : {}),
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (res.status === 204) return { status: 204, body: {} };
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { status: 503, body: { error: "PUSHD's server did not answer. Try again in a minute." } };
  }
}

/** What the builder needs to know. Null without an engine or when it is silent. */
export async function getBuildConfig(): Promise<BuildConfig | null> {
  await connection();
  if (!agentsOn() || !engineUrl()) return null;
  const r = await buildFetch("/v1/build/config");
  return r.status === 200 ? (r.body as unknown as BuildConfig) : null;
}

/** The signed-in GitHub account with its agents. Null when not signed in. */
export async function getBuildMe(): Promise<BuildMe | null> {
  await connection();
  const gh = await ghSession();
  if (!agentsOn() || !gh) return null;
  const r = await buildFetch("/v1/build/me", { gh, holder: await holderSession() });
  return r.status === 200 ? (r.body as unknown as BuildMe) : null;
}

export async function getBuildAgent(id: string): Promise<{ agent: AgentView; runs: RunView[] } | null> {
  await connection();
  const gh = await ghSession();
  if (!agentsOn() || !gh || !/^[a-f0-9]{16}$/.test(id)) return null;
  const r = await buildFetch(`/v1/build/agents/${id}`, { gh });
  return r.status === 200 ? (r.body as unknown as { agent: AgentView; runs: RunView[] }) : null;
}

export async function getShipped(owner: string, repo: string): Promise<Shipped | null> {
  await connection();
  if (!agentsOn() || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  const r = await buildFetch(`/v1/build/shipped/${owner}/${repo}`);
  return r.status === 200 ? (r.body as unknown as Shipped) : null;
}

export async function getScoutBuilds(): Promise<{ scouts: ScoutBuild[]; org: string } | null> {
  await connection();
  if (!agentsOn()) return null;
  const r = await buildFetch("/v1/build/scouts", { holder: await holderSession() });
  return r.status === 200 ? (r.body as unknown as { scouts: ScoutBuild[]; org: string }) : null;
}
