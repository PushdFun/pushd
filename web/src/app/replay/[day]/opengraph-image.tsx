import { ImageResponse } from "next/og";
import { dayWords } from "@/lib/brief";
import { DAY_RE, getDay } from "@/lib/data-days";
import { isCatch } from "@/lib/groups";
import { C, OG_SIZE, OgFrame, ogFonts } from "@/lib/og-days";

// The share picture for one day's replay: the day's events by hour as bars, the hot moments marked above them.
export const alt = "PUSHD replay of a day";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ day: string }> }) {
  const { day } = await params;
  const d = DAY_RE.test(day) ? await getDay(day) : null;
  const fonts = await ogFonts();
  const hours = d?.hours ?? Array.from({ length: 24 }, () => 0);
  const max = Math.max(1, ...hours);
  const hotHours = new Set((d?.lines ?? []).filter((l) => isCatch(l.heat)).map((l) => new Date(l.githubAt).getUTCHours()));
  return new ImageResponse(
    (
      <OgFrame cmd={`pushd replay ${day.slice(0, 10)} --in 60s`} tag={d?.sample ? "SAMPLE" : undefined}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginTop: 18 }}>
          <span style={{ fontSize: 70, fontWeight: 800, letterSpacing: -2 }}>Replay</span>
          <span style={{ fontSize: 40, fontWeight: 800, color: C.acc }}>{DAY_RE.test(day) ? dayWords(day, true) : ""}</span>
        </div>
        <div style={{ display: "flex", fontSize: 24, color: C.muted, marginTop: 6 }}>
          {d ? `${d.totalEvents.toLocaleString("en-US")} public events, ${d.lines.length} feed lines, played back in 60 seconds.` : "A day of pushes, played back in 60 seconds."}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: "auto", height: 230, padding: "0 4px", borderBottom: `2px solid ${C.line2}` }}>
          {hours.map((v, h) => (
            <div key={h} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", flex: 1, height: "100%" }}>
              {hotHours.has(h) && <div style={{ width: 16, height: 16, borderRadius: 8, background: C.vhigh, marginBottom: 8 }} />}
              <div style={{ width: "100%", height: `${v ? Math.max(4, Math.round((v / max) * 100)) : 1}%`, background: hotHours.has(h) ? C.acc : C.line2, borderRadius: "3px 3px 0 0" }} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, color: C.dim, marginTop: 8 }}>
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>24:00 UTC</span>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
