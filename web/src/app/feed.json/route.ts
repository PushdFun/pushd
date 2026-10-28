import { getPublicFeed } from "@/lib/data";
import { toJsonFeed } from "@/lib/feeds";

/** The public feed as JSON Feed 1.1, with PUSHD's own fields under _pushd. Open to any site (CORS). */
export async function GET() {
  const feed = await getPublicFeed();
  return new Response(JSON.stringify(toJsonFeed(feed), null, 2), {
    headers: { "content-type": "application/feed+json; charset=utf-8", "cache-control": "public, max-age=60", "access-control-allow-origin": "*" },
  });
}
