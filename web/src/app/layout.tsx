import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { HolderLive } from "@/components/HolderLive";
import { PublicLive } from "@/components/PublicLive";
import { AppShell } from "@/components/AppShell";
import { Palette } from "@/components/Palette";
import { SoundPlayer } from "@/components/Sound";
import { getBuyLink } from "@/lib/data";
import { agentsOn } from "@/lib/build-server";
import { SITE } from "@/lib/site";
import "./globals.css";
// one stylesheet per part of the site, after the base look
import "./styles/v2.css";
import "./styles/days.css";
import "./styles/app.css";
import "./styles/scouts.css";
import "./styles/lookup.css";
import "./styles/build.css";

// The heat bars use the block glyph, which JetBrains Mono's web subsets leave out: it must fall through to the
// system monospace (as in the design), not to next/font's metric-matched Arial, so the mono face has no adjusted fallback.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-jbm",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
const sans = Schibsted_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-sg", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: "PUSHD",
  description: "Know the moment builders push. A live feed of what the most active crypto projects on GitHub publish.",
  applicationName: "PUSHD",
  openGraph: { type: "website", siteName: "PUSHD", locale: "en" },
  twitter: { card: "summary_large_image", site: "@PushdFun" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0c0b" },
    { media: "(prefers-color-scheme: light)", color: "#f1f0ea" },
  ],
};

// Runs before paint: the saved theme (dark unless the visitor picked light). Storage can be blocked, hence the try.
const THEME_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem("pushd-theme")}catch(e){}document.documentElement.setAttribute("data-theme",s==="light"||s==="dark"?s:"dark")})()`;

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const buy = await getBuyLink();
  return (
    <html lang="en" data-theme="dark" className={`${mono.variable} ${sans.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Header buyHref={buy.href} build={agentsOn()} />
        <main>{children}</main>
        <Footer />
        <HolderLive />
        <PublicLive />
        <SoundPlayer />
        <AppShell />
        <Palette />
      </body>
    </html>
  );
}
