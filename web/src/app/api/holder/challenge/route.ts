import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { closed, noStore, sameSite, smallJson, toEngine } from "@/lib/holder-route";

/** Step 1 of holder sign-in: the message for the wallet to sign, written and kept by the engine. */
export async function POST(req: NextRequest) {
  if (!engineUrl()) return closed();
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403 });
  const b = await smallJson(req);
  if (!b) return NextResponse.json({ error: "That request is not valid." }, { status: 400 });
  const r = await toEngine("/v1/holders/challenge", { method: "POST", body: { address: b.address } });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
