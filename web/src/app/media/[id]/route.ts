import { getMedia } from "@/lib/data";

// A repo's preview picture, served from this site (the engine is read on the server only, and the page's policy
// allows pictures from this site alone). The engine fetched it once from GitHub; it never changes, so it is cached
// for a year. No engine or no such picture: a 404, and the card draws its own picture instead.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pic = await getMedia(id);
  if (!pic) return new Response("no such picture", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(pic.body, {
    headers: {
      "content-type": pic.type,
      "content-length": String(pic.body.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
