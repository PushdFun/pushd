import { getPublicFeed } from "@/lib/data";
import { toRss } from "@/lib/feeds";

/** The public feed as RSS: the same lines as the public site, a few minutes behind. */
export async function GET() {
  const feed = await getPublicFeed();
  return new Response(toRss(feed), { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" } });
}
