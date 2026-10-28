import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, adminSecret } from "@/lib/admin";
import { adminKeyOk, adminToken } from "@/lib/admin-token";
import { noStore, sameSite, smallJson } from "@/lib/holder-route";

// The admin sign-in: the typed key is compared on the server, in constant time, with PUSHD_ADMIN_KEY. The cookie holds an
// HMAC keyed by the secret, never the secret. A wrong key waits a moment, so guessing is slow.

export async function POST(req: NextRequest) {
  const secret = adminSecret();
  if (!secret) return NextResponse.json({ error: "Admin is off: PUSHD_ADMIN_KEY is not set." }, { status: 404, headers: noStore });
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  const b = await smallJson(req);
  if (!adminKeyOk(b?.key, secret)) {
    await new Promise((r) => setTimeout(r, 800));
    return NextResponse.json({ error: "That key is not right." }, { status: 401, headers: noStore });
  }
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  res.cookies.set(ADMIN_COOKIE, adminToken(secret), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 12 * 3600 });
  return res;
}
