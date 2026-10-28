import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { ipOf, noStore, sameSite, smallJson, toEngine } from "@/lib/holder-route";

/** Suggest a builder: stored by the engine for the owner to look at. Nothing is added by itself. */
export async function POST(req: NextRequest) {
  if (!engineUrl()) return NextResponse.json({ error: "Suggestions open once PUSHD's engine is connected here." }, { status: 503, headers: noStore });
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400, headers: noStore });
  const r = await toEngine("/v1/suggestions", { method: "POST", ip: ipOf(req), body: { login: b.login, camp: b.camp, why: b.why } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
