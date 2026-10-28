import { type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";

// PUSHD's MCP server, Streamable HTTP: https://pushd.fun/mcp. The JSON-RPC messages pass through to the engine's
// /mcp (engine/src/agent/agent.ts), which answers each with one JSON body (no server-sent stream is offered).

const PASS = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "x-pushd-key", "origin"];

async function forward(req: NextRequest) {
  const base = engineUrl();
  if (!base) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "PUSHD's engine is not connected here." } }, { status: 503 });
  const headers: Record<string, string> = {};
  for (const h of PASS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v.slice(0, 600);
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  if (ip) headers["x-forwarded-for"] = ip.slice(0, 64);
  const text = req.method === "POST" ? await req.text() : undefined;
  if (text && text.length > 65_536) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Too large." } }, { status: 413 });
  try {
    const res = await fetch(`${base}/mcp`, { method: req.method, headers, body: text, cache: "no-store", signal: AbortSignal.timeout(90_000) });
    const out = new Headers({ "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    for (const h of ["content-type", "retry-after", "allow", "access-control-allow-methods", "access-control-allow-headers"]) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.status === 202 || res.status === 204 ? null : await res.text(), { status: res.status, headers: out });
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "PUSHD's server did not answer. Try again in a minute." } }, { status: 503 });
  }
}

export const POST = forward;
export const GET = forward;
export const DELETE = forward;
export const OPTIONS = forward;
