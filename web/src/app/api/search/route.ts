import { NextResponse, type NextRequest } from "next/server";
import { searchAll } from "@/lib/data";

/** Search for the command palette: lines (the public view) and builders matching a few words. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchAll(q), { headers: { "cache-control": "no-store" } });
}
