import Link from "next/link";
import { dayWords } from "@/lib/brief";
import type { DaySummary } from "@/lib/day-types";
import { num, weekday } from "@/lib/format";

// The recent days as a strip of small bars (older on the left), each one a link to that day; the open day is lit, and
// a day with a hot catch has a heat dot. With the older and newer day as arrows on both ends.

export function DayStrip({ days, current, base, older, newer }: { days: DaySummary[]; current: string; base: "/replay" | "/brief"; older: string | null; newer: string | null }) {
  const recent = [...days].sort((a, b) => a.day.localeCompare(b.day)).slice(-21);
  if (!recent.some((d) => d.day === current)) {
    // the open day is older than the strip: show the days around it instead
    const all = [...days].sort((a, b) => a.day.localeCompare(b.day));
    const i = all.findIndex((d) => d.day === current);
    if (i >= 0) recent.splice(0, recent.length, ...all.slice(Math.max(0, i - 10), i + 11));
  }
  const max = Math.max(1, ...recent.map((d) => d.events));
  return (
    <nav className="dstrip" aria-label="Days">
      {older ? (
        <Link className="dstrip-arrow" href={`${base}/${older}`} aria-label={`Older day, ${dayWords(older)}`}>
          &lt;
        </Link>
      ) : (
        <span className="dstrip-arrow off" aria-hidden="true">
          &lt;
        </span>
      )}
      <ol className="dstrip-days">
        {recent.map((d) => (
          <li key={d.day}>
            <Link
              href={`${base}/${d.day}`}
              className={d.day === current ? "on" : undefined}
              aria-current={d.day === current ? "page" : undefined}
              title={`${weekday(d.day)} ${dayWords(d.day)}: ${num(d.events)} events, ${num(d.lines)} feed lines${d.catches ? `, ${d.catches} hot` : ""}`}
            >
              <span className="dstrip-bar">
                <i style={{ height: `${Math.max(6, Math.round((d.events / max) * 100))}%` }} />
                {d.catches > 0 && <b aria-hidden="true" />}
              </span>
              <span className="dstrip-d">{dayWords(d.day).split(" ")[0]}</span>
            </Link>
          </li>
        ))}
      </ol>
      {newer ? (
        <Link className="dstrip-arrow" href={`${base}/${newer}`} aria-label={`Newer day, ${dayWords(newer)}`}>
          &gt;
        </Link>
      ) : (
        <span className="dstrip-arrow off" aria-hidden="true">
          &gt;
        </span>
      )}
    </nav>
  );
}
