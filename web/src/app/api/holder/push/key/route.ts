import { NextResponse } from "next/server";
import { engineUrl } from "@/lib/data";
import { noStore, toEngine } from "@/lib/holder-route";

/** The key a browser subscribes to PUSHD's alerts with; 409 while alerts with PUSHD closed are not switched on. */
export async function GET() {
  if (!engineUrl()) return NextResponse.json({ error: "Alerts with PUSHD closed are not switched on yet." }, { status: 409, headers: noStore });
  const r = await toEngine("/v1/holders/push/key", { method: "GET" });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
