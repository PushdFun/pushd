import { ImageResponse } from "next/og";
import { getItem } from "@/lib/data";
import { GROUPS, HEAT_LABEL, KIND_LABEL } from "@/lib/groups";
import { C, HEAT_COLOR, HEAT_LIT, OG_SIZE, OgFrame, ogFonts } from "@/lib/og-days";

// A line's share picture: who and what, the plain line, the heat bar.
export const alt = "A line on PUSHD";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await getItem(id).catch(() => null);
  const fonts = await ogFonts();
  const it = found?.item;
  const repo = it ? (it.version ? `${it.repo} ${it.version}` : it.repo) : id;
  const color = it ? HEAT_COLOR[it.heat] : C.dim;
  const lit = it ? HEAT_LIT[it.heat] : 0;
  return new ImageResponse(
    (
      <OgFrame cmd={`pushd show ${id.slice(0, 40)}`} tag={it?.sample ? "SAMPLE" : undefined}>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 26, flex: 1 }}>
          <div style={{ display: "flex", gap: 16, fontSize: 22, color: C.cyan }}>
            <span>{it ? KIND_LABEL[it.kind].toUpperCase() : "LINE"}</span>
            {it && <span style={{ color: C.dim }}>{GROUPS[it.group].mid}</span>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 18, marginTop: 12, fontSize: repo.length > 24 ? 54 : 68, fontWeight: 800, lineHeight: 1.05 }}>
            <span>{it?.handle ?? "PUSHD"}</span>
            <span style={{ color: C.dim, fontWeight: 400 }}>/</span>
            <span style={{ color: color }}>{repo}</span>
          </div>
          <div style={{ display: "flex", fontSize: 30, color: C.muted, marginTop: 22, lineHeight: 1.35 }}>{it ? (it.summary.length > 110 ? it.summary.slice(0, 107) + "..." : it.summary) : "No such line."}</div>
          {it && (
            <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: "auto" }}>
              <span style={{ display: "flex", fontSize: 30, letterSpacing: 3 }}>
                <span style={{ color }}>{"█".repeat(lit)}</span>
                <span style={{ color: C.line2 }}>{"█".repeat(10 - lit)}</span>
              </span>
              <span style={{ fontSize: 26, fontWeight: 800, color }}>{HEAT_LABEL[it.heat].toUpperCase()}</span>
              <span style={{ marginLeft: "auto", fontSize: 22, color: C.dim }}>{it.score != null ? `heat ${it.score}/10` : ""}</span>
            </div>
          )}
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
