import { agentsOn } from "@/lib/build-server";
import { engineUrl } from "@/lib/data";

// The PUSHD GitHub App's webhook: GitHub posts here and the delivery passes to the engine as it came, raw body and the
// three headers, because the engine checks the signature over the exact bytes. Nothing is read or kept here.
export async function POST(req: Request) {
  const base = engineUrl();
  if (!agentsOn() || !base) return new Response(null, { status: 404 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 2_000_000) return Response.json({ error: "too large" }, { status: 413 });
  const body = await req.arrayBuffer();
  if (body.byteLength > 2_000_000) return Response.json({ error: "too large" }, { status: 413 });
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["x-hub-signature-256", "x-github-delivery", "x-github-event"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v.slice(0, 200);
  }
  try {
    const res = await fetch(`${base}/v1/build/github/webhook`, { method: "POST", headers, body, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "the engine did not answer" }, { status: 503 });
  }
}
