import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { HourBars } from "@/components/Charts";
import { ComparePick } from "@/components/ComparePick";
import { Prompt } from "@/components/Prompt";
import { getBuilder, getBuilders } from "@/lib/data";
import { agoWords, bare, builderHref, num, shortDate } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { busiestWeekday, currentStreak, longestStreak, peakHour, shipsAt } from "@/lib/profile";
import type { BuilderProfile } from "@/lib/types";

export const metadata: Metadata = {
  title: "PUSHD Compare",
  description: "Two or three builders side by side over 30 days: activity, lines, streaks and when they ship.",
  alternates: { canonical: "/compare" },
};

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };
const LINE = ["var(--accent)", "var(--cyan)", "var(--heat-high)"];

function Chart({ list }: { list: BuilderProfile[] }) {
  const days = list[0].days.slice(-30);
  const W = 900;
  const H = 220;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...list.flatMap((b) => b.days.slice(-30).map((d) => d.events)));
  const x = (i: number) => pad.l + (i / Math.max(1, days.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily public events over 30 days for ${list.map((b) => b.handle).join(", ")}`}>
      {[0, 0.5, 1].map((k) => (
        <g key={k}>
          <line x1={pad.l} x2={W - pad.r} y1={y(max * k)} y2={y(max * k)} stroke="var(--line)" strokeDasharray={k ? "3 5" : undefined} />
          {(k !== 0.5 || max >= 4) && (
            <text x={pad.l - 8} y={y(max * k) + 4} textAnchor="end">
              {Math.round(max * k)}
            </text>
          )}
        </g>
      ))}
      {days.map((d, i) =>
        (i % 7 === 0 && i < days.length - 3) || i === days.length - 1 ? (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor={i === days.length - 1 ? "end" : "middle"}>
            {shortDate(d.day)}
          </text>
        ) : null,
      )}
      {list.map((b, bi) => {
        const pts = b.days.slice(-30).map((d, i) => `${x(i).toFixed(1)},${y(d.events).toFixed(1)}`);
        return (
          <g key={b.handle}>
            <polyline points={pts.join(" ")} fill="none" stroke={LINE[bi]} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
            {b.days.slice(-30).map((d, i) => (d.items ? <circle key={d.day} cx={x(i)} cy={y(d.events)} r={4.5} fill="var(--heat-vhigh)" stroke="var(--bg-2)" strokeWidth={2} /> : null))}
          </g>
        );
      })}
    </svg>
  );
}

export default async function ComparePage({ searchParams }: Props) {
  const q = await searchParams;
  const raw = (Array.isArray(q.b) ? q.b.join(",") : q.b ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = [...new Set(raw)].slice(0, 3);
  const [{ builders }, found] = await Promise.all([getBuilders(), Promise.all(wanted.map((h) => getBuilder(h).catch(() => null)))]);
  const list = found.filter((b): b is BuilderProfile => !!b);
  const sample = list.some((b) => b.sample) || (!list.length && builders.some((b) => b.sample));
  const asOf = list[0]?.days.at(-1) ? `${list[0].days.at(-1)!.day}T23:59:59Z` : new Date().toISOString();
  const rows: { k: string; v: (b: BuilderProfile) => number | string; num?: boolean }[] = [
    { k: "events, 7 days", v: (b) => b.events7d, num: true },
    { k: "events, 30 days", v: (b) => b.events30d, num: true },
    { k: "feed lines", v: (b) => b.items, num: true },
    { k: "hot catches", v: (b) => b.catches, num: true },
    { k: "streak now", v: (b) => currentStreak(b.days), num: true },
    { k: "longest streak, 12 weeks", v: (b) => longestStreak(b.days), num: true },
    { k: "active days, 30", v: (b) => b.days.slice(-30).filter((d) => d.events > 0).length, num: true },
    { k: "busiest weekday", v: (b) => busiestWeekday(b.days) ?? "none" },
    { k: "last seen", v: (b) => (b.lastActiveAt ? agoWords(b.lastActiveAt, asOf) : "not yet") },
  ];
  const best = (r: (typeof rows)[number]) => (list.length > 1 && r.num ? Math.max(...list.map((b) => Number(r.v(b)))) : null);

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd" cmd={`pushd diff ${list.map((b) => bare(b.handle)).join(" ") || "<a> <b>"}`} />
              <h1>
                Compare<span className="acc">.</span>
              </h1>
              <p className="lede">Two or three builders side by side over the last 30 days. Pick from the whole watchlist.</p>
            </div>
            {sample && <span className="tag sample">Sample data</span>}
          </div>
          <ComparePick all={builders.map((b) => ({ handle: b.handle, name: b.name }))} chosen={list.map((b) => bare(b.handle))} />
        </div>
      </section>

      <section className="wrap">
        {list.length === 0 ? (
          <div className="estate" style={{ marginTop: 32 }}>
            <b>Pick two builders above.</b>
            <span>Or tick them in the watchlist table and press Compare.</span>
            <Link className="textlink" href="/watchlist#everyone">
              the watchlist -&gt;
            </Link>
          </div>
        ) : (
          <>
            <div className="panel cmp-chart">
              <div className="ptitle">
                <h3>Public events per day, 30 days</h3>
                <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {list.map((b, i) => (
                    <span key={b.handle} style={{ color: LINE[i] }}>
                      ━ {b.handle}
                    </span>
                  ))}
                  <span style={{ color: "var(--heat-vhigh)" }}>● a feed line</span>
                </span>
              </div>
              <div className="cscroll">
                <Chart list={list} />
              </div>
            </div>
            <div className={`cmpgrid n${Math.max(2, list.length)}`}>
              {list.map((b, bi) => (
                <div key={b.handle} className={`panel ccol g-${b.group}`} style={{ borderTop: `3px solid ${LINE[bi]}` }}>
                  <div className="chd">
                    <Avatar handle={b.handle} sample={b.sample} size={48} />
                    <span style={{ minWidth: 0 }}>
                      <h3>
                        <Link className="who-link" href={builderHref(b.handle)}>
                          {b.handle}
                        </Link>
                      </h3>
                      <small>
                        {[b.name !== b.handle ? b.name : null, GROUPS[b.group].mid].filter(Boolean).join(" · ")}
                      </small>
                    </span>
                  </div>
                  <div>
                    {rows.map((r) => {
                      const v = r.v(b);
                      const top = best(r);
                      return (
                        <div key={r.k} className="crow">
                          <span>{r.k}</span>
                          <b className={top != null && top > 0 && Number(v) === top ? "win" : undefined}>{typeof v === "number" ? num(v) : v}</b>
                        </div>
                      );
                    })}
                  </div>
                  <div>
                    <div className="ptitle" style={{ marginBottom: 8 }}>
                      <h3 style={{ fontSize: 15 }}>Usually ships at</h3>
                      <span>{shipsAt(peakHour(b.hours))}</span>
                    </div>
                    <HourBars hours={b.hours} mark={peakHour(b.hours)} label={`${b.handle}: activity by hour`} />
                  </div>
                </div>
              ))}
              {list.length === 1 && (
                <div className="estate">
                  <b>Add one more.</b>
                  <span>Pick a second builder above to see them side by side.</span>
                </div>
              )}
            </div>
            <p className="footnote">
              Counts are public GitHub events as GitHub listed them when PUSHD read each account (about 90 days, up to 100 a read). The
              brightest number in each row is the highest.
            </p>
          </>
        )}
      </section>
    </>
  );
}
