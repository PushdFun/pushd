import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, sessionOf, toEngine } from "@/lib/holder-route";
import { validLogin } from "@/lib/lookup";

/** Stop watching one added account. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ login: string }> }) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  const session = sessionOf(req);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: noStore });
  const { login } = await ctx.params;
  if (!validLogin(login)) return NextResponse.json({ error: "That is not a GitHub username." }, { status: 400, headers: noStore });
  const r = await toEngine(`/v1/holders/watch/${encodeURIComponent(login)}`, { method: "DELETE", session });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
