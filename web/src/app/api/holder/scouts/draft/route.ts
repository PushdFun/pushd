import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

// Plain words to a rule draft: the model when the engine has one (within its daily cap), the template parser
// otherwise. Nothing is saved; the holder edits the rule first.
export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b || typeof b.text !== "string") return NextResponse.json({ error: "Say in a few words what to watch." }, { status: 400 });
  const r = await toEngine("/v1/holders/scouts/draft", { method: "POST", session, body: { text: b.text.slice(0, 300) } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
