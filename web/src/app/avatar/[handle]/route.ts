import { getAvatar } from "@/lib/data";

// A watched builder's GitHub picture, served from this site (the page's policy allows pictures from here alone). The
// engine fetched it at most once a week. No engine or no picture: a 404, and the page draws the builder's initial.
export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  const { handle } = await ctx.params;
  const pic = await getAvatar(handle);
  if (!pic) return new Response("no such picture", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  return new Response(pic.body, {
    headers: { "content-type": pic.type, "content-length": String(pic.body.byteLength), "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}
