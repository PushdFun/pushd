import type { NextConfig } from "next";

// Everything the page loads comes from this site: next/font serves the fonts from here, and the engine is read on the
// server only. So the policy can be strict.
const csp = [
  "default-src 'self'",
  // the theme script in the head and Next's own bootstrapping are inline
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // the service worker (public/sw.js) and the install manifest (src/app/manifest.ts) come from this site
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const security = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // the dev badge would sit in every local screenshot
  devIndicators: false,
  async headers() {
    // dev needs eval for fast refresh; the policy is for the built site
    const policy = process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: csp }] : [];
    // the widget (/embed) is made to sit inside other sites' pages: everything but the framing rule is the same
    const framed = process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: csp.replace("frame-ancestors 'none'", "frame-ancestors *") }] : [];
    return [
      { source: "/((?!embed$|embed/).*)", headers: [...security, ...policy] },
      { source: "/embed", headers: [...security.filter((h) => h.key !== "X-Frame-Options"), ...framed] },
    ];
  },
  async redirects() {
    // terms and privacy are sections of the own-risk page
    return [
      { source: "/terms", destination: "/own-risk#terms", permanent: true },
      { source: "/privacy", destination: "/own-risk#privacy", permanent: true },
      // the Top 100 lives on the watchlist page
      { source: "/top", destination: "/watchlist", permanent: false },
    ];
  },
};

export default nextConfig;
