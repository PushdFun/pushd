import { NextResponse, type NextRequest } from "next/server";
import { engineUrl } from "@/lib/data";
import { ipOf, noStore, sameSite, sessionOf, smallJson, toEngine } from "@/lib/holder-route";
import { validLogin, validRepo } from "@/lib/lookup";

/** "Ask a scout to read it": the engine checks the free reads, the caps and the scouts' model, then reads the repo. */
export async function POST(req: NextRequest) {
  if (!engineUrl()) return NextResponse.json({ error: "Scout reads need PUSHD's engine, which is not connected here." }, { status: 503, headers: noStore });
  if (!sameSite(req)) return NextResponse.json({ error: "Not from this site." }, { status: 403, headers: noStore });
  const b = await smallJson(req);
  const [owner, repo] = typeof b?.repo === "string" ? b.repo.split("/") : [];
  if (!owner || !repo || !validLogin(owner) || !validRepo(repo)) return NextResponse.json({ error: "Which repo? owner/name." }, { status: 400, headers: noStore });
  const r = await toEngine(`/v1/gh/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/read`, { method: "POST", ip: ipOf(req), session: sessionOf(req), body: {}, timeoutMs: 120_000 });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
