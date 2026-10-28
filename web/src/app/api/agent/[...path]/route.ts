import { type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";

// PUSHD for agents, REST: /api/agent/<tool> on this site is the engine's /v1/agent/<tool> (engine/src/agent). The
// request passes through as it is, with the caller's address for the rate limits, an optional API key and a payment's
// two headers; the engine does every check, the 402 included.

const PASS = ["x-pushd-key", "x-pushd-payment-tx", "x-pushd-payment-signature", "content-type", "accept"];
const BACK = ["content-type", "retry-after", "x-pushd-payment-required", "cache-control"];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const base = engineUrl();
  if (!base) return Response.json({ error: "The agent API runs with PUSHD's engine, which is not connected here." }, { status: 503 });
  const { path } = await ctx.params;
  if (!path.length || path.length > 2 || !path.every((p) => /^[a-z0-9.-]{1,40}$/.test(p))) return Response.json({ error: "No such tool." }, { status: 404 });
  const headers: Record<string, string> = {};
  for (const h of PASS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v.slice(0, 600);
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  if (ip) headers["x-forwarded-for"] = ip.slice(0, 64);
  const body = req.method === "POST" ? (await req.text()).slice(0, 4096) : undefined;
  try {
    const res = await fetch(`${base}/v1/agent/${path.join("/")}${req.nextUrl.search}`, { method: req.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(90_000) });
    const out = new Headers({ "access-control-allow-origin": "*", "x-content-type-options": "nosniff" });
    for (const h of BACK) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(await res.text(), { status: res.status, headers: out });
  } catch {
    return Response.json({ error: "PUSHD's server did not answer. Try again in a minute." }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "x-pushd-key, x-pushd-payment-tx, x-pushd-payment-signature, content-type" } });
}
