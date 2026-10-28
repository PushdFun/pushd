import { ImageResponse } from "next/og";
import { getBuilder } from "@/lib/data";
import { bare, num } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { C, OG_SIZE, OgFrame, ogFonts } from "@/lib/og-days";

// A builder's share picture: the handle, who they are, the week in numbers and their last 12 weeks as a grid.
export const alt = "A builder on PUSHD";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const b = await getBuilder(decodeURIComponent(handle)).catch(() => null);
  const fonts = await ogFonts();
  const days = b?.days ?? [];
  const max = Math.max(1, ...days.map((d) => d.events));
  const lead = days.length ? (new Date(days[0].day + "T00:00:00Z").getUTCDay() + 6) % 7 : 0;
  const cells = [...Array.from({ length: lead }, () => -1), ...days.map((d) => d.events)];
  const weeks = Math.ceil(cells.length / 7);
  const shade = (v: number) => (v < 0 ? "transparent" : v === 0 ? C.bg3 : `rgba(166,255,77,${0.25 + 0.75 * (v / max)})`);
  return new ImageResponse(
    (
      <OgFrame cmd={`pushd who ${b ? bare(b.handle) : handle}`} tag={b?.sample ? "SAMPLE" : undefined}>
        <div style={{ display: "flex", marginTop: 28, gap: 48, flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <span style={{ fontSize: 78, fontWeight: 800, letterSpacing: -2, lineHeight: 1 }}>{b ? bare(b.handle) : handle}</span>
            <span style={{ fontSize: 26, color: C.muted, marginTop: 14 }}>{b ? [b.name !== b.handle ? b.name : null, b.org, GROUPS[b.group].mid].filter(Boolean).join(" . ") : "not on the watchlist"}</span>
            <div style={{ display: "flex", gap: 36, marginTop: "auto", marginBottom: 6 }}>
              {[
                ["7 days", num(b?.events7d ?? 0)],
                ["30 days", num(b?.events30d ?? 0)],
                ["lines", num(b?.items ?? 0)],
                ["catches", num(b?.catches ?? 0)],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 50, fontWeight: 800, color: k === "catches" && v !== "0" ? C.vhigh : C.text }}>{v}</span>
                  <span style={{ fontSize: 18, color: C.dim }}>{k}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignSelf: "flex-end" }}>
            {Array.from({ length: weeks }, (_, w) => (
              <div key={w} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {cells.slice(w * 7, w * 7 + 7).map((v, d) => (
                  <div key={d} style={{ width: 24, height: 24, borderRadius: 5, background: shade(v) }} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
