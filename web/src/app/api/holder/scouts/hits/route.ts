import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sessionOf, toEngine } from "@/lib/holder-route";

// The "my scout" inbox: hits after a number (the tab's alerts ask for the new ones every few seconds).
export async function GET(req: NextRequest) {
  if (!engineUrl()) return closed();
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const after = Number(req.nextUrl.searchParams.get("after") ?? 0);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 30);
  const q = `after=${Number.isInteger(after) && after >= 0 ? after : 0}&limit=${Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 30}`;
  const r = await toEngine(`/v1/holders/scouts/hits?${q}`, { method: "GET", session });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
