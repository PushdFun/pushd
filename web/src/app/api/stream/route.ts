import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The public feed as server-sent events: the engine's /v1/stream at the public delay, passed through as it arrives. A
 * line comes here only once it is out of its delay, the same moment it reaches the public feed page. Holders have
 * their own live stream (/api/holder/stream). With no engine there is nothing to stream: a 204.
 */
export async function GET(req: NextRequest) {
  if (!engineUrl()) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const last = req.headers.get("last-event-id");
  let upstream: Response;
  try {
    upstream = await fetch(`${engineUrl()}/v1/stream`, {
      cache: "no-store",
      signal: req.signal,
      headers: { accept: "text/event-stream", ...(last && /^\d+$/.test(last) ? { "last-event-id": last } : {}) },
    });
  } catch {
    return NextResponse.json({ error: "PUSHD's server did not answer." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json({ error: "The stream is not available." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return new Response(upstream.body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
