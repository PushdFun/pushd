import type { MetadataRoute } from "next";
import { SCOUTS } from "@/lib/scouts";
import { SITE } from "@/lib/site";

const PAGES = ["/", "/feed", "/scouts", ...SCOUTS.map((s) => `/scouts/${s.id}`), "/my-scout", "/pulse", "/replay", "/brief", "/catches", "/watchlist", "/gh", "/compare", "/how", "/agents", "/holders", "/token", "/own-risk"];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: `${SITE.url}${p === "/" ? "" : p}` }));
}
