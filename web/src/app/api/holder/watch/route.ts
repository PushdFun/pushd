import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, ipOf, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

/** A holder's added accounts: the list, or one more. The engine checks the holding, the limits and the account. */
export async function GET(req: NextRequest) {
  if (!engineUrl()) return closed();
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const r = await toEngine("/v1/holders/watch", { method: "GET", session });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "Sign in as a holder first." }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b || typeof b.login !== "string") return NextResponse.json({ error: "Which account?" }, { status: 400, headers: noStore });
  const r = await toEngine("/v1/holders/watch", { method: "POST", session, ip: ipOf(req), body: { login: b.login } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
