import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, setSession, smallJson, toEngine } from "@/lib/holder-route";

/**
 * Step 2: the signature. The engine checks it against the message it kept and reads the wallet's $PUSHD; a holder
 * gets a session, kept here in an httpOnly cookie and never shown to the page.
 */
export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/session", { method: "POST", body: { address: b.address, nonce: b.nonce, signature: b.signature } });
  if (r.status !== 200 || typeof r.body.session !== "string" || typeof r.body.expiresAt !== "number") return NextResponse.json(r.body, { status: r.status === 200 ? 502 : r.status, headers: noStore });
  const res = NextResponse.json({ status: r.body.status, expiresAt: r.body.expiresAt }, { headers: noStore });
  setSession(res, r.body.session, r.body.expiresAt);
  return res;
}
