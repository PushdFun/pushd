import { NextResponse, type NextRequest } from "next/server";
import { agentsOn, buildFetch, GH_COOKIE, GH_STATE } from "@/lib/build-server";
import { ipOf } from "@/lib/holder-route";
import { SITE } from "@/lib/site";

// GitHub sends the browser back here with a code and the state. The state must be the one this browser was given; the
// engine swaps the code for who signed in (the GitHub token is used there once and dropped) and answers a session of
// its own, kept here in an httpOnly cookie.
export async function GET(req: NextRequest) {
  if (!agentsOn()) return new NextResponse(null, { status: 404 });
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/build${q}`, SITE.url));
    res.cookies.set(GH_STATE, "", { path: "/api/build/github", maxAge: 0 });
    return res;
  };
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const kept = req.cookies.get(GH_STATE)?.value ?? "";
  if (!code || !state || state !== kept) return back("?signin=again");
  const r = await buildFetch("/v1/build/github/oauth", { method: "POST", body: { code, redirectUri: `${SITE.url.replace(/\/+$/, "")}/api/build/github/callback` }, ip: ipOf(req), timeoutMs: 30_000 });
  if (r.status !== 200 || typeof r.body.session !== "string" || typeof r.body.expiresAt !== "number") return back("?signin=failed");
  const res = back("");
  res.cookies.set(GH_COOKIE, r.body.session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: new Date(r.body.expiresAt) });
  return res;
}
