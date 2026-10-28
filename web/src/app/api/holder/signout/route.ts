import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { clearSession, noStore, sameSite, sessionOf, toEngine } from "@/lib/holder-route";

/** Ends the session on the engine and here. */
export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (session && engineUrl()) await toEngine("/v1/holders/session", { method: "DELETE", session });
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  clearSession(res);
  return res;
}
