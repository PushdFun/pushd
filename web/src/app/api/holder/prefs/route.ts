import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";

/** A holder's own watchlist and alert choices. The engine checks every handle against the shared watchlist. */
export async function PUT(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/prefs", { method: "PUT", session, body: { follow: b.follow, mute: b.mute, alertHeat: b.alertHeat, alertMine: b.alertMine, scouts: b.scouts } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
