import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";
import { MARK_COLORS, Mark } from "@/components/Logo";
import { MARK_DATA } from "@/lib/brand-files";

// The share pictures for one day (the brief and the replay): the terminal look of the site's own share picture.

export const OG_SIZE = { width: 1200, height: 630 };
export const C = { bg: "#0a0c0b", bg2: "#0f1211", bg3: "#151917", line: "#222826", line2: "#2e3632", text: "#e6ece8", muted: "#95a29b", dim: "#5d6963", acc: MARK_COLORS.accent, cyan: "#74dcff", vhigh: "#ff5473", high: "#ff8f3f", medium: "#f4c152", low: "#85928b" };
export const HEAT_COLOR = { low: C.low, medium: C.medium, high: C.high, veryHigh: C.vhigh } as const;
export const HEAT_LIT = { low: 3, medium: 5, high: 8, veryHigh: 10 } as const;

export async function ogFonts() {
  const dir = join(process.cwd(), "src/assets");
  const [regular, bold] = await Promise.all([readFile(join(dir, "JetBrainsMono-Regular.ttf")), readFile(join(dir, "JetBrainsMono-ExtraBold.ttf"))]);
  return [
    { name: "JetBrains Mono", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "JetBrains Mono", data: bold, weight: 800 as const, style: "normal" as const },
  ];
}

/** The frame: the grid, the mark and wordmark, the prompt line, then the picture's own content. */
export function OgFrame({ cmd, tag, children }: { cmd: string; tag?: string; children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "48px 64px",
        background: C.bg,
        backgroundImage: `linear-gradient(rgba(166,255,77,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(166,255,77,0.05) 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
        fontFamily: "JetBrains Mono",
        color: C.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Mark size={44} src={MARK_DATA} />
        <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: 3 }}>PUSHD</span>
        <span style={{ fontSize: 34, fontWeight: 800, color: C.acc, marginLeft: -14 }}>_</span>
        {tag && <span style={{ marginLeft: 18, fontSize: 18, color: C.medium, border: `2px dashed ${C.medium}`, padding: "2px 10px", borderRadius: 4 }}>{tag}</span>}
        <span style={{ marginLeft: "auto", fontSize: 20, color: C.muted }}>pushd.fun</span>
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 30, fontSize: 22 }}>
        <span style={{ color: C.cyan }}>~/pushd</span>
        <span style={{ color: C.acc }}>$</span>
        <span>{cmd}</span>
      </div>
      {children}
    </div>
  );
}
