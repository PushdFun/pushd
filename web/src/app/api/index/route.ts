import { NextResponse } from "next/server";
import { getBuilders, getFeed } from "@/lib/data";

/** What the command palette searches in the browser: every builder, and the latest lines this visitor may see. */
export async function GET() {
  const [{ builders }, feed] = await Promise.all([getBuilders(), getFeed()]);
  return NextResponse.json(
    {
      builders: builders.map((b) => ({ handle: b.handle, name: b.name, org: b.org, group: b.group, sample: b.sample })),
      items: feed.items.slice(0, 120).map((it) => ({ id: it.id, handle: it.handle, repo: it.repo, version: it.version, kind: it.kind, heat: it.heat, summary: it.summary, sample: it.sample })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
