import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

// A holder's own scouts (engine: src/scouts/myscouts.ts): the list and how many the holding allows (GET), and a
// save, new or an edit (POST). The engine checks the session, the holding, the tier and every field of the rule.

export async function GET(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const r = await toEngine("/v1/holders/scouts", { method: "GET", session });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/scouts", { method: "POST", session, body: { id: b.id, name: b.name, text: b.text, rule: b.rule } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
