import type { CSSProperties } from "react";
import { hourLabel, num, shortDate, weekday } from "@/lib/format";
import type { DayCount } from "@/lib/types";

// Small charts drawn as plain markup and SVG: a sparkline, a GitHub-style activity grid, a 24 hour bar row. They read
// as a terminal would draw them: square cells, one accent colour, the count in a title for every cell.

/** Bars for a short run of counts (14 days). */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <span className="spark" role="img" aria-label={label}>
      {values.map((v, i) => (
        <i key={i} style={{ "--h": `${v ? Math.max(14, Math.round((v / max) * 100)) : 6}%` } as CSSProperties} className={v ? "on" : undefined} />
      ))}
    </span>
  );
}

const level = (v: number, max: number) => (v <= 0 ? 0 : v >= max * 0.75 ? 4 : v >= max * 0.45 ? 3 : v >= max * 0.2 ? 2 : 1);

/** The activity grid: weeks as columns, Monday to Sunday as rows, the newest day last. Days with a feed line get a dot. */
export function ActivityGrid({ days, label }: { days: DayCount[]; label: string }) {
  if (!days.length) return null;
  const max = Math.max(1, ...days.map((d) => d.events));
  // Monday first: pad the first column so each day sits on its weekday's row
  const lead = (new Date(days[0].day + "T00:00:00Z").getUTCDay() + 6) % 7;
  const cells: (DayCount | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const months: { col: number; text: string }[] = [];
  for (let c = 0; c < weeks; c++) {
    const first = cells.slice(c * 7, c * 7 + 7).find((d): d is DayCount => !!d);
    if (first && (c === 0 || first.day.slice(8) <= "07")) {
      const text = shortDate(first.day).split(" ")[1];
      if (!months.some((m) => m.text === text)) months.push({ col: c, text });
    }
  }
  return (
    <figure className="agrid" aria-label={label}>
      <div className="agrid-months" style={{ gridTemplateColumns: `repeat(${weeks}, var(--cell))` }} aria-hidden="true">
        {months.map((m) => (
          <span key={m.text} style={{ gridColumn: m.col + 1 }}>
            {m.text}
          </span>
        ))}
      </div>
      <div className="agrid-body">
        <div className="agrid-days" aria-hidden="true">
          <span>Mon</span>
          <span></span>
          <span>Wed</span>
          <span></span>
          <span>Fri</span>
          <span></span>
          <span></span>
        </div>
        <div className="agrid-cells" style={{ gridTemplateColumns: `repeat(${weeks}, var(--cell))` }}>
          {cells.map((d, i) =>
            d ? (
              <i key={d.day} className={`l${level(d.events, max)}${d.items ? " hot" : ""}`} title={`${weekday(d.day)} ${shortDate(d.day)}: ${num(d.events)} public event${d.events === 1 ? "" : "s"}${d.items ? `, ${d.items} feed line${d.items === 1 ? "" : "s"}` : ""}`} />
            ) : (
              <i key={`pad-${i}`} className="pad" />
            ),
          )}
        </div>
      </div>
      <figcaption className="agrid-key">
        <span>less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`l${l}`} />
        ))}
        <span>more</span>
        <span className="agrid-dot">
          <i className="l2 hot" /> a feed line that day
        </span>
      </figcaption>
    </figure>
  );
}

/** 24 bars, one per hour of the day (UTC). The busiest hours are lit. */
export function HourBars({ hours, label, mark }: { hours: number[]; label: string; mark?: number | null }) {
  const max = Math.max(1, ...hours);
  return (
    <figure className="hbars" aria-label={label}>
      <div className="hbars-row">
        {hours.map((v, h) => (
          <span key={h} className={`hb${h === mark ? " peak" : ""}`} title={`${hourLabel(h)} UTC: ${num(v)}`}>
            <i style={{ height: `${v ? Math.max(6, Math.round((v / max) * 100)) : 2}%` }} />
          </span>
        ))}
      </div>
      <div className="hbars-axis" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </figure>
  );
}
