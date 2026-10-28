import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sessionOf } from "@/lib/holder-route";

export const dynamic = "force-dynamic";

/**
 * The live feed as server-sent events, for a signed-in holder: the engine's /v1/stream with no delay, passed through
 * as it arrives. The engine checks the session and the balance when the stream opens; browser alerts and the live
 * feed page listen to it. A reconnect sends its Last-Event-ID on, so no line is skipped or sent twice.
 */
export async function GET(req: NextRequest) {
  if (!engineUrl()) return closed();
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const last = req.headers.get("last-event-id");
  let upstream: Response;
  try {
    upstream = await fetch(`${engineUrl()}/v1/stream?delay=0`, {
      cache: "no-store",
      signal: req.signal,
      headers: { authorization: `Bearer ${session}`, accept: "text/event-stream", ...(last && /^\d+$/.test(last) ? { "last-event-id": last } : {}) },
    });
  } catch {
    return NextResponse.json({ error: "PUSHD's server did not answer." }, { status: 503, headers: noStore });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json({ error: upstream.status === 401 ? "The live feed needs a wallet that holds $PUSHD." : "The live feed is not available." }, { status: upstream.status === 401 ? 401 : 503, headers: noStore });
  }
  return new Response(upstream.body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
