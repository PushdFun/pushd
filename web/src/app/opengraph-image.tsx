import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { MARK_COLORS, Mark } from "@/components/Logo";
import { MARK_DATA } from "@/lib/brand-files";

// The share picture: the terminal look, 1200 x 630. JetBrains Mono (OFL, src/assets/OFL.txt) is read from the repo.
export const alt = "PUSHD. Know the moment builders push.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = { bg: "#0a0c0b", bg2: "#0f1211", bg3: "#151917", line: "#222826", line2: "#2e3632", text: "#e6ece8", muted: "#95a29b", dim: "#5d6963", acc: MARK_COLORS.accent, cyan: "#74dcff", vhigh: "#ff5473", high: "#ff8f3f", medium: "#f4c152", low: "#85928b" };

function Row({ kind, what, lit, color, label }: { kind: string; what: string; lit: number; color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "12px 0", borderTop: `1px dashed ${C.line}` }}>
      <span style={{ color: C.cyan, width: 130, fontSize: 20 }}>{kind}</span>
      <span style={{ color: C.text, flex: 1, fontSize: 24 }}>{what}</span>
      <span style={{ display: "flex", fontSize: 20, letterSpacing: 2 }}>
        <span style={{ color }}>{"█".repeat(lit)}</span>
        <span style={{ color: C.line2 }}>{"█".repeat(10 - lit)}</span>
      </span>
      <span style={{ color, fontSize: 18, width: 120 }}>{label}</span>
    </div>
  );
}

export default async function OpengraphImage() {
  const dir = join(process.cwd(), "src/assets");
  const [regular, bold] = await Promise.all([readFile(join(dir, "JetBrainsMono-Regular.ttf")), readFile(join(dir, "JetBrainsMono-ExtraBold.ttf"))]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "56px 72px",
          background: C.bg,
          backgroundImage: `linear-gradient(rgba(166,255,77,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(166,255,77,0.05) 1px, transparent 1px)`,
          backgroundSize: "40px 40px",
          fontFamily: "JetBrains Mono",
          color: C.text,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Mark size={52} src={MARK_DATA} />
          <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: 3 }}>PUSHD</span>
          <span style={{ fontSize: 40, fontWeight: 800, color: C.acc, marginLeft: -16 }}>_</span>
          <span style={{ marginLeft: "auto", fontSize: 22, color: C.muted }}>pushd.fun</span>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 44, fontSize: 24 }}>
          <span style={{ color: C.cyan }}>~/pushd</span>
          <span style={{ color: C.acc }}>$</span>
          <span>git push</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 72, fontWeight: 800, letterSpacing: -2, lineHeight: 1.08, marginTop: 14 }}>
          <span>Know the moment</span>
          <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
            <span>builders</span>
            <span style={{ color: C.acc }}>push</span>
            <span style={{ width: 34, height: 60, background: C.acc, marginLeft: -14 }} />
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "auto",
            border: `1px solid ${C.line2}`,
            borderRadius: 12,
            background: C.bg2,
            padding: "18px 28px 10px",
          }}
        >
          <div style={{ display: "flex", gap: 12, fontSize: 20, color: C.muted, paddingBottom: 12 }}>
            <span style={{ color: C.acc }}>$</span>
            <span style={{ color: C.text }}>pushd tail --public</span>
            <span style={{ marginLeft: "auto" }}>public GitHub activity, one plain line each</span>
          </div>
          <Row kind="NEW REPO" what="a fun new repo" lit={10} color={C.vhigh} label="VERY HIGH" />
          <Row kind="RELEASE" what="a release with a clear idea" lit={5} color={C.medium} label="MEDIUM" />
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "JetBrains Mono", data: regular, weight: 400, style: "normal" },
        { name: "JetBrains Mono", data: bold, weight: 800, style: "normal" },
      ],
    },
  );
}
