import { HEAT_LABEL, KIND_VERB } from "./groups";
import { SITE } from "./site";
import type { Feed, FeedItem } from "./types";

// The public feed as RSS 2.0 and JSON Feed 1.1, built from the same lines as the site's public view (5 minutes behind).
// Pure, so the tests can check them. Sample lines are marked sample in their title.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const noDash = (s: string) => s.replace(/[–—]/g, "-");
export const titleOf = (it: FeedItem) => noDash(`${it.handle} ${KIND_VERB[it.kind]} ${it.repo}${it.version ? ` ${it.version}` : ""}${it.sample ? " (sample)" : ""}`);
const bodyOf = (it: FeedItem) => noDash(`${it.summary} Heat: ${HEAT_LABEL[it.heat]}.`);
const linkOf = (it: FeedItem) => `${SITE.url}/feed/${it.id}`;
const when = (it: FeedItem) => it.shownAt ?? it.githubAt;

export function toRss(feed: Feed, limit = 50): string {
  const items = feed.items.slice(0, limit);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>PUSHD</title>
<link>${SITE.url}/feed</link>
<atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml"/>
<description>What every crypto project that keeps shipping publishes on public GitHub, one plain line each. The public view, a few minutes behind.</description>
<language>en</language>
<lastBuildDate>${new Date(feed.asOf).toUTCString()}</lastBuildDate>
${items
  .map(
    (it) => `<item>
<title>${esc(titleOf(it))}</title>
<link>${linkOf(it)}</link>
<guid isPermaLink="true">${linkOf(it)}</guid>
<pubDate>${new Date(when(it)).toUTCString()}</pubDate>
<category>${esc(it.heat)}</category>
<description>${esc(bodyOf(it))}</description>
</item>`,
  )
  .join("\n")}
</channel>
</rss>
`;
}

export function toJsonFeed(feed: Feed, limit = 50) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "PUSHD",
    home_page_url: `${SITE.url}/feed`,
    feed_url: `${SITE.url}/feed.json`,
    description: "What every crypto project that keeps shipping publishes on public GitHub, one plain line each. The public view, a few minutes behind.",
    language: "en",
    items: feed.items.slice(0, limit).map((it) => ({
      id: linkOf(it),
      url: linkOf(it),
      ...(it.url ? { external_url: it.url } : {}),
      title: titleOf(it),
      content_text: bodyOf(it),
      date_published: new Date(when(it)).toISOString(),
      tags: [it.kind, it.group, it.heat],
      _pushd: { handle: it.handle, repo: it.repo, version: it.version ?? null, kind: it.kind, group: it.group, heat: it.heat, score: it.score ?? null, githubAt: it.githubAt, shownAt: it.shownAt, sample: it.sample },
    })),
  };
}
