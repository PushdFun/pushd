import { ImageResponse } from "next/og";
import { buildBrief, dayWords, lineWords } from "@/lib/brief";
import { DAY_RE, getDay } from "@/lib/data-days";
import { C, HEAT_COLOR, HEAT_LIT, OG_SIZE, OgFrame, ogFonts } from "@/lib/og-days";
import { SITE } from "@/lib/site";

// The share picture for one day's brief: the headline, the four counts, and the hottest line.
export const alt = "PUSHD daily brief";
export const size = OG_SIZE;
export const contentType = "image/png";

/** The lede's first two sentences (without the sample note), short enough for the picture. */
const sub = (lede: string) => {
  const parts = lede.replace(/^Sample brief, from the sample lines\. /, "").match(/[^.]+\./g) ?? [];
  const text = parts.slice(0, 2).join("").trim();
  return text.length > 150 ? parts[0]?.trim() ?? "" : text;
};

function Num({ k, v, color = C.text }: { k: string; v: number; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "16px 22px", borderLeft: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 16, color: C.dim, letterSpacing: 2 }}>{k.toUpperCase()}</span>
      <span style={{ fontSize: 46, fontWeight: 800, color, marginTop: 4 }}>{v.toLocaleString("en-US")}</span>
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ day: string }> }) {
  const { day } = await params;
  const d = DAY_RE.test(day) ? await getDay(day) : null;
  const fonts = await ogFonts();
  if (!d) {
    return new ImageResponse(
      (
        <OgFrame cmd={`pushd brief ${day.slice(0, 10)}`}>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, marginTop: 40 }}>The daily brief.</div>
          <div style={{ display: "flex", fontSize: 28, color: C.muted, marginTop: 16 }}>What the watched projects shipped, day by day.</div>
        </OgFrame>
      ),
      { ...size, fonts },
    );
  }
  const b = buildBrief(d, { url: `${SITE.url}/brief/${d.day}`, today: !d.sample && d.asOf.slice(0, 10) === d.day });
  const hot = b.top[0];
  return new ImageResponse(
    (
      <OgFrame cmd={`pushd brief ${d.day}`} tag={d.sample ? "SAMPLE" : undefined}>
        <div style={{ display: "flex", fontSize: b.headline.length > 34 ? 58 : 68, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05, marginTop: 18 }}>{b.headline}</div>
        <div style={{ display: "flex", fontSize: 24, lineHeight: 1.4, color: C.muted, marginTop: 14 }}>{sub(b.lede)}</div>
        <div style={{ display: "flex", marginTop: "auto", border: `1px solid ${C.line2}`, borderRadius: 12, background: C.bg2, overflow: "hidden" }}>
          <div style={{ display: "flex", flex: 1, marginLeft: -1 }}>
            <Num k="events" v={d.totalEvents} />
            <Num k="feed lines" v={d.lines.length} />
            <Num k="hot catches" v={d.catches} color={d.catches ? C.vhigh : C.text} />
            <Num k="builders" v={d.active} />
          </div>
        </div>
        {hot && (
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 18, fontSize: 22 }}>
            <span style={{ color: C.dim }}>hottest</span>
            <span style={{ color: C.text, flex: 1, overflow: "hidden" }}>{lineWords(hot).slice(0, 52)}</span>
            <span style={{ display: "flex", letterSpacing: 2, fontSize: 20 }}>
              <span style={{ color: HEAT_COLOR[hot.heat] }}>{"█".repeat(HEAT_LIT[hot.heat])}</span>
              <span style={{ color: C.line2 }}>{"█".repeat(10 - HEAT_LIT[hot.heat])}</span>
            </span>
          </div>
        )}
        {!hot && <div style={{ display: "flex", marginTop: 18, fontSize: 22, color: C.muted }}>{dayWords(d.day, true)}. No line made the feed.</div>}
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
