import { NextResponse, type NextRequest } from "next/server";
import { agentsOn, buildFetch, GH_COOKIE } from "@/lib/build-server";
import { sameSite } from "@/lib/holder-route";

// Signs out of GitHub on PUSHD: the engine forgets the session, the cookie goes.
export async function POST(req: NextRequest) {
  if (!agentsOn()) return new NextResponse(null, { status: 404 });
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const gh = req.cookies.get(GH_COOKIE)?.value;
  if (gh) await buildFetch("/v1/build/session", { method: "DELETE", gh });
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(GH_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
