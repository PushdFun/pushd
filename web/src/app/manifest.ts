import type { MetadataRoute } from "next";
import { MARK_COLORS } from "@/components/Logo";

// The install manifest: PUSHD as an app on a phone's home screen or a computer's dock, opening on the feed.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PUSHD",
    short_name: "PUSHD",
    description: "Know the moment builders push. A live feed of every crypto project that keeps shipping on GitHub.",
    start_url: "/feed",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: MARK_COLORS.bg,
    theme_color: MARK_COLORS.bg,
    categories: ["developer", "news", "utilities"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Feed", url: "/feed", icons: [{ src: "/icons/192", sizes: "192x192" }] },
      { name: "Catches", url: "/catches", icons: [{ src: "/icons/192", sizes: "192x192" }] },
    ],
  };
}
