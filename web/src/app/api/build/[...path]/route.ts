import { NextResponse, type NextRequest } from "next/server";
import { agentsOn, buildFetch, GH_COOKIE } from "@/lib/build-server";
import { buildRouteOk } from "@/lib/build-switch";
import { ipOf, noStore, sameSite, sessionOf } from "@/lib/holder-route";

// The builder's calls from the page, passed to the engine's /v1/build (engine/src/agents/routes.ts), which checks the
// GitHub session, the agent's owner, every field of a spec, the limits and any payment. Only the paths in BUILD_ROUTES
// (src/lib/build-switch.ts) pass; the GitHub session goes along from its httpOnly cookie, and the holder's session (for
// the wallet link and votes) too.

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!agentsOn()) return new NextResponse(null, { status: 404 });
  const path = (await ctx.params).path.join("/");
  if (!buildRouteOk(path, req.method)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (req.method !== "GET" && !sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const gh = req.cookies.get(GH_COOKIE)?.value ?? null;
  let body: unknown;
  if (req.method === "POST" || req.method === "PATCH") {
    const text = await req.text().catch(() => "");
    if (text.length > 16_384) return NextResponse.json({ error: "too large" }, { status: 413 });
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
    }
  }
  const r = await buildFetch(`/v1/build/${path}`, { method: req.method, body, gh, holder: sessionOf(req), ip: ipOf(req), timeoutMs: path === "draft" || path.endsWith("/pay") ? 60_000 : 20_000 });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
