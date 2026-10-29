// The site's own addresses. The buy button follows $PUSHD itself (getBuyLink in src/lib/data.ts): launching soon until the token exists.

export const SITE = {
  name: "PUSHD",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://pushd.fun",
  tagline: "Know the moment builders push.",
  github: "https://github.com/PushdFun/pushd" as string | null,
  x: "https://x.com/PushdFun" as string | null,
};

export const RISK_LINE = "Nothing on PUSHD is financial advice. Everything here is at your own risk.";

/** The pages in the header, in order. Home is the logo. Build shows only with PUSHD Agents on (PUSHD_AGENTS). */
export const NAV = [
  { href: "/feed", label: "Feed" },
  { href: "/scouts", label: "Scouts" },
  { href: "/pulse", label: "Pulse" },
  { href: "/replay", label: "Replay" },
  { href: "/brief", label: "Brief" },
  { href: "/catches", label: "Catches" },
  { href: "/watchlist", label: "The list" },
  { href: "/how", label: "How it works" },
  { href: "/agents", label: "Agents" },
  { href: "/build", label: "Build" },
  { href: "/holders", label: "Holders" },
  { href: "/token", label: "Token" },
] as const;
