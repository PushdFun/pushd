import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin";
import { engineCall, engineUrl } from "@/lib/data";
import { noStore, sameSite, smallJson } from "@/lib/holder-route";

/** Mark a suggestion approved, declined or new again. Approving only marks it: nothing is added to the list. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not signed in to admin." }, { status: 401, headers: noStore });
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  if (!engineUrl()) return NextResponse.json({ error: "No engine connected." }, { status: 503, headers: noStore });
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) return NextResponse.json({ error: "No such suggestion." }, { status: 404, headers: noStore });
  const b = await smallJson(req);
  const status = b?.status;
  if (status !== "approved" && status !== "declined" && status !== "new") return NextResponse.json({ error: "approved, declined or new" }, { status: 400, headers: noStore });
  const r = await engineCall(`/v1/admin/suggestions/${id}`, { method: "POST", body: { status }, admin: true });
  return NextResponse.json(r.body, { status: r.status || 503, headers: noStore });
}
