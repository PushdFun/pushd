import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

// Alerts with PUSHD closed: this browser's push subscription, saved for the signed-in holder (PUT) or forgotten
// (DELETE). The engine checks the session, the holding and the subscription itself, and sends the alerts.

export async function PUT(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/push", { method: "PUT", session, body: { endpoint: b.endpoint, keys: b.keys } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

export async function DELETE(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = (await smallJson(req)) ?? {};
  const r = await toEngine("/v1/holders/push", { method: "DELETE", session, body: { endpoint: typeof b.endpoint === "string" ? b.endpoint : undefined } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
