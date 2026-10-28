import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, toEngine } from "@/lib/holder-route";

// Deletes one of the holder's own scouts, with its hits.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) return NextResponse.json({ error: "No such scout of yours." }, { status: 404 });
  const r = await toEngine(`/v1/holders/scouts/${id}`, { method: "DELETE", session });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
