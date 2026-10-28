import { NextResponse, type NextRequest } from "next/server";
import { lookupAll } from "@/lib/data";
import { ipOf } from "@/lib/holder-route";

/** Search for the command palette: the watched first, then anything on GitHub (the engine's /v1/lookup). */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 100);
  const { result, offline } = await lookupAll(q, ipOf(req));
  return NextResponse.json({ ...result, offline }, { headers: { "cache-control": "no-store" } });
}
