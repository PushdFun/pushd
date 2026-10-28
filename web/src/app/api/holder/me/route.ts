import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { clearSession, closed, noStore, sessionOf, toEngine } from "@/lib/holder-route";

/** The signed-in wallet: its $PUSHD as last read, whether it opens the live feed, and its own choices. */
export async function GET(req: NextRequest) {
  if (!engineUrl()) return closed();
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const r = await toEngine("/v1/holders/me", { method: "GET", session });
  const res = NextResponse.json(r.body, { status: r.status, headers: noStore });
  if (r.status === 401) clearSession(res);
  return res;
}
