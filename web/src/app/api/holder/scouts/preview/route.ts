import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

// What a rule would have matched among the latest lines. No model call, nothing saved.
export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/scouts/preview", { method: "POST", session, body: { rule: b.rule } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
