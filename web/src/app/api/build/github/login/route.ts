import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { agentsOn, buildFetch, GH_STATE } from "@/lib/build-server";
import { SITE } from "@/lib/site";

// Sign-in with GitHub starts here: a one-time state in an httpOnly cookie, then GitHub's own page. The engine builds the
// address (it holds the app's client id); GitHub sends the browser back to /api/build/github/callback.
export async function GET() {
  if (!agentsOn()) return new NextResponse(null, { status: 404 });
  const state = randomBytes(24).toString("base64url");
  const redirect = `${SITE.url.replace(/\/+$/, "")}/api/build/github/callback`;
  const r = await buildFetch(`/v1/build/github/authorize?state=${state}&redirect=${encodeURIComponent(redirect)}`);
  if (r.status !== 200 || typeof r.body.url !== "string" || !r.body.url.startsWith("https://github.com/login/oauth/authorize?")) return NextResponse.redirect(new URL("/build?signin=off", SITE.url));
  const res = NextResponse.redirect(r.body.url);
  res.cookies.set(GH_STATE, state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/build/github", maxAge: 600 });
  return res;
}
