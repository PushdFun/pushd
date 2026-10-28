import { hourLabel, num } from "@/lib/format";
import { GROUPS, GROUP_ORDER } from "@/lib/groups";
import type { Pulse } from "@/lib/types";

// The last 24 hours as a clock: one wedge per hour, stacked by camp, longer for busier hours. The newest hour is
// marked. Every wedge has its count in a title.

const C = 200;
const R0 = 58;
const R1 = 182;

function wedge(h: number, r0: number, r1: number): string {
  const a0 = ((h * 15 - 90 + 1.2) * Math.PI) / 180;
  const a1 = (((h + 1) * 15 - 90 - 1.2) * Math.PI) / 180;
  const p = (a: number, r: number) => `${(C + r * Math.cos(a)).toFixed(1)} ${(C + r * Math.sin(a)).toFixed(1)}`;
  return `M${p(a0, r0)} L${p(a0, r1)} A${r1} ${r1} 0 0 1 ${p(a1, r1)} L${p(a1, r0)} A${r0} ${r0} 0 0 0 ${p(a0, r0)} Z`;
}

export function Clock24({ hours }: { hours: Pulse["hours"] }) {
  const max = Math.max(1, ...hours.map((h) => h.total));
  const nowHour = hours.length ? new Date(hours[hours.length - 1].at).getUTCHours() : 0;
  const total = hours.reduce((n, h) => n + h.total, 0);
  return (
    <svg className="clock24" viewBox="0 0 400 400" role="img" aria-label={`Public events in the last 24 hours by camp and hour (UTC): ${num(total)} in all`}>
      {[R0, (R0 + R1) / 2, R1].map((r) => (
        <circle key={r} className="ring" cx={C} cy={C} r={r} strokeDasharray={r === R1 ? undefined : "2 5"} />
      ))}
      {hours.map((slot) => {
        const h = new Date(slot.at).getUTCHours();
        let r = R0;
        const span = R1 - R0;
        return (
          <g key={slot.at}>
            <title>{`${hourLabel(h)} UTC: ${num(slot.total)} events`}</title>
            {slot.total === 0 && <path d={wedge(h, R0, R0 + 3)} fill="var(--line-2)" />}
            {GROUP_ORDER.map((g) => {
              const v = slot.groups[g];
              if (!v) return null;
              const r1 = r + (v / max) * span;
              const d = wedge(h, r, r1);
              r = r1;
              return <path key={g} d={d} className={`g-${g}`} fill="var(--g)" opacity={0.9} />;
            })}
          </g>
        );
      })}
      {[0, 6, 12, 18].map((h) => {
        const a = ((h * 15 - 90) * Math.PI) / 180;
        return (
          <text key={h} x={C + (R1 + 12) * Math.cos(a)} y={C + (R1 + 12) * Math.sin(a) + 3.5} textAnchor="middle">
            {String(h).padStart(2, "0")}
          </text>
        );
      })}
      <line className="now" x1={C + (R0 - 8) * Math.cos(((nowHour * 15 - 90 + 15) * Math.PI) / 180)} y1={C + (R0 - 8) * Math.sin(((nowHour * 15 - 90 + 15) * Math.PI) / 180)} x2={C + (R1 + 4) * Math.cos(((nowHour * 15 - 90 + 15) * Math.PI) / 180)} y2={C + (R1 + 4) * Math.sin(((nowHour * 15 - 90 + 15) * Math.PI) / 180)} />
      <text x={C} y={C - 4} textAnchor="middle" style={{ fontSize: 26, fontWeight: 800, fill: "var(--text)" }}>
        {num(total)}
      </text>
      <text x={C} y={C + 16} textAnchor="middle">
        events, 24h
      </text>
    </svg>
  );
}

export function GroupLegend() {
  return (
    <div className="glegend" aria-hidden="true">
      {GROUP_ORDER.map((g) => (
        <span key={g} className={`g-${g}`}>
          <i className="gdot" />
          {GROUPS[g].chip}
        </span>
      ))}
    </div>
  );
}
