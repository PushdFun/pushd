"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { bare, builderHref, num } from "@/lib/format";
import { GROUPS, GROUP_ORDER, HEAT_CLASS, HEAT_LABEL, isCatch, KIND_VERB } from "@/lib/groups";
import type { DayDetail } from "@/lib/day-types";
import type { FeedItem, GroupKey } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Heat } from "./Heat";

// A day of pushes, played back in 60 seconds (30 at 2x, 15 at 4x). The playhead runs from 00:00 to 24:00 UTC (or to
// the public view's moment, on a day that is not over); every event it passes types into the log, ticks onto its
// camp's lane and counts up, and every feed line it passes takes the hot moment panel. The scrubber below can be
// dragged, clicked, or moved with the keys (arrows, shift for an hour, Home and End); space plays and pauses. With
// reduced motion nothing plays by itself: the whole day is shown, and stepping still works.

const DAY_S = 86_400;
const PLAY_S = 60;
const SPEEDS = [1, 2, 4] as const;
const BINS = 96;
const SHOWN = 36;

type Entry =
  | { kind: "event"; at: number; handle: string; name?: string; group: GroupKey; what: string; repo: string | null; key: string }
  | { kind: "line"; at: number; item: FeedItem; key: string };

const secOfDay = (iso: string) => {
  const d = new Date(iso);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
};
const pad = (n: number) => String(n).padStart(2, "0");
const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const m = window.matchMedia(motionQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const clock = (s: number) => {
  const v = Math.max(0, Math.min(DAY_S, Math.floor(s)));
  return v >= DAY_S ? "24:00:00" : `${pad(Math.floor(v / 3600))}:${pad(Math.floor((v % 3600) / 60))}:${pad(v % 60)}`;
};

/** The index of the last entry at or before t (entries sorted by time); -1 when none. */
function upTo(entries: Entry[], t: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].at <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function ReplayPlayer({ day, today }: { day: DayDetail; today: boolean }) {
  const end = today ? Math.max(60, Math.min(DAY_S, secOfDay(day.asOf))) : DAY_S;
  const entries = useMemo<Entry[]>(() => {
    const ev: Entry[] = day.events.map((e, i) => ({ kind: "event", at: secOfDay(e.at), handle: e.handle, ...(e.name ? { name: e.name } : {}), group: e.group, what: e.what, repo: e.repo, key: `e${i}` }));
    const ln: Entry[] = day.lines.map((it) => ({ kind: "line", at: secOfDay(it.githubAt), item: it, key: `l${it.id}` }));
    return [...ev, ...ln].sort((a, b) => a.at - b.at || (a.kind === "line" ? 1 : -1));
  }, [day]);
  const lines = useMemo(() => entries.filter((e): e is Extract<Entry, { kind: "line" }> => e.kind === "line"), [entries]);
  const bins = useMemo(() => {
    const b = Array.from({ length: BINS }, () => 0);
    for (const e of entries) if (e.kind === "event") b[Math.min(BINS - 1, Math.floor((e.at / DAY_S) * BINS))]++;
    return b;
  }, [entries]);
  const binMax = Math.max(1, ...bins);

  const [rawT, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const reduced = useSyncExternalStore(subscribeMotion, () => window.matchMedia(motionQuery).matches, () => false);
  // with reduced motion the whole day shows until the visitor moves the playhead
  const [touched, setTouched] = useState(false);
  const t = reduced && !touched ? end : rawT;
  const raf = useRef(0);
  const last = useRef(0);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ wasPlaying: boolean } | null>(null);

  // start: play by itself, unless motion is reduced (then the whole day shows)
  useEffect(() => {
    if (reduced) return;
    const go = setTimeout(() => setPlaying(true), 600);
    return () => clearTimeout(go);
  }, [reduced]);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last.current) / 1000);
      last.current = now;
      let stop = false;
      setT((prev) => {
        const next = prev + dt * (DAY_S / PLAY_S) * speed;
        if (next >= end) {
          stop = true;
          return end;
        }
        return next;
      });
      if (stop) setPlaying(false);
      else raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, end]);

  const toggle = useCallback(() => {
    setTouched(true);
    setPlaying((p) => {
      if (!p) setT((prev) => (prev >= end - 1 ? 0 : prev));
      return !p;
    });
  }, [end]);

  // space plays and pauses, unless a control that uses space has the focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.closest("input, textarea, select, button, a, [contenteditable]") || el.isContentEditable)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const seekTo = (s: number) => {
    setTouched(true);
    setT(Math.max(0, Math.min(end, s)));
  };
  const fromPointer = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    seekTo(((clientX - r.left) / r.width) * DAY_S);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = { wasPlaying: playing };
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e.clientX);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => dragging.current && fromPointer(e.clientX);
  const onUp = () => {
    if (dragging.current?.wasPlaying) setPlaying(true);
    dragging.current = null;
  };
  const onSliderKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 3600 : 900;
    const moves: Record<string, () => void> = {
      ArrowRight: () => seekTo(t + big),
      ArrowUp: () => seekTo(t + big),
      ArrowLeft: () => seekTo(t - big),
      ArrowDown: () => seekTo(t - big),
      PageUp: () => seekTo(t + 3600),
      PageDown: () => seekTo(t - 3600),
      Home: () => seekTo(0),
      End: () => seekTo(end),
      " ": toggle,
    };
    const fn = moves[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const idx = upTo(entries, t);
  const passed = entries.slice(0, idx + 1);
  const shown = passed.slice(-SHOWN).reverse();
  const counts = useMemo(() => {
    let events = 0;
    let lineCount = 0;
    let catches = 0;
    const who = new Set<string>();
    const lanes = Object.fromEntries(GROUP_ORDER.map((g) => [g, { n: 0, lastAt: -1 }])) as Record<GroupKey, { n: number; lastAt: number }>;
    for (const e of passed) {
      if (e.kind === "event") {
        events++;
        who.add(e.handle);
        lanes[e.group].n++;
        lanes[e.group].lastAt = e.at;
      } else {
        lineCount++;
        who.add(e.item.handle);
        if (isCatch(e.item.heat)) catches++;
      }
    }
    return { events, lines: lineCount, catches, who: [...who], lanes };
    // passed changes with idx only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, entries]);
  // the panel holds the latest hot catch for three played hours, then the latest line of any heat
  const passedLines = passed.filter((e): e is Extract<Entry, { kind: "line" }> => e.kind === "line");
  const lastHot = [...passedLines].reverse().find((e) => isCatch(e.item.heat));
  const moment = (lastHot && t - lastHot.at < 3 * 3600 ? lastHot : passedLines[passedLines.length - 1]) ?? null;
  const pct = (s: number) => `${(s / DAY_S) * 100}%`;
  const recentWho = counts.who.slice(-8).reverse();
  // a lane glows for a short while (in played time) after its last event
  const glow = (lastAt: number) => (lastAt < 0 ? 0 : Math.max(0, 1 - (t - lastAt) / 1500));

  return (
    <div className={`rp${playing ? " is-playing" : ""}`} style={{ "--head": pct(t), "--end": pct(end) } as CSSProperties}>
      <div className="rp-top">
        <div className="rp-clock" aria-live="off">
          <span className="rp-time">{clock(t)}</span>
          <span className="rp-utc">UTC</span>
        </div>
        <dl className="rp-counts">
          <div>
            <dt>events</dt>
            <dd>{num(counts.events)}</dd>
          </div>
          <div>
            <dt>feed lines</dt>
            <dd>{num(counts.lines)}</dd>
          </div>
          <div>
            <dt>hot catches</dt>
            <dd className={counts.catches ? "hot" : undefined}>{num(counts.catches)}</dd>
          </div>
          <div>
            <dt>builders</dt>
            <dd>{num(counts.who.length)}</dd>
          </div>
        </dl>
      </div>

      <div className="rp-main">
        <div className="rp-log" aria-label="Events so far, newest on top">
          <div className="rp-log-head">
            <span>
              <span className="acc">$</span> pushd replay {day.day} --tail
            </span>
            <span>
              {num(passed.length)} / {num(entries.length)}
            </span>
          </div>
          <ol className="rp-rows">
            {shown.length === 0 && (
              <li className="rp-empty">
                {entries.length === 0 ? "nothing to play: no activity stored for this day." : "press play. the day starts at 00:00 UTC."}
                <span className="cursor" aria-hidden="true"></span>
              </li>
            )}
            {shown.map((e) =>
              e.kind === "event" ? (
                <li key={e.key} className={`rp-row g-${e.group}`}>
                  <span className="rp-at">{clock(e.at).slice(0, 5)}</span>
                  <span className="rp-dot" aria-hidden="true"></span>
                  <span className="rp-txt">
                    <Link href={builderHref(e.handle)} className="rp-h">
                      {e.handle}
                    </Link>{" "}
                    <span className="rp-w">{e.what}</span> {e.repo && <span className="rp-r">{e.repo}</span>}
                  </span>
                </li>
              ) : (
                <li key={e.key} className={`rp-row is-line ${HEAT_CLASS[e.item.heat]}`}>
                  <span className="rp-at">{clock(e.at).slice(0, 5)}</span>
                  <span className="rp-dot" aria-hidden="true"></span>
                  <span className="rp-txt">
                    <b className="rp-tag">feed line</b>{" "}
                    <Link href={`/feed/${e.item.id}`} className="rp-h">
                      {e.item.handle} {KIND_VERB[e.item.kind]} {e.item.repo}
                      {e.item.version ? ` ${e.item.version}` : ""}
                    </Link>
                  </span>
                </li>
              ),
            )}
          </ol>
        </div>

        <aside className="rp-side">
          <div className={`rp-moment${moment && isCatch(moment.item.heat) ? " hot" : ""}`} key={moment?.key ?? "none"}>
            <div className="rp-mh">
              <span>{moment ? (isCatch(moment.item.heat) ? "hot moment" : "feed line") : "hot moments"}</span>
              {moment && <span>{clock(moment.at).slice(0, 5)} UTC</span>}
            </div>
            {moment ? (
              <>
                <h3>
                  {moment.item.handle} {KIND_VERB[moment.item.kind]} <span className="rp-mr">{moment.item.repo}</span>
                </h3>
                <p>{moment.item.summary}</p>
                <div className="rp-mf">
                  <Heat heat={moment.item.heat} />
                  <Link className="textlink" href={`/feed/${moment.item.id}`}>
                    open -&gt;
                  </Link>
                </div>
              </>
            ) : (
              <p className="rp-wait">{lines.length ? `${lines.length} feed line${lines.length === 1 ? "" : "s"} this day. Each one lands here as the playhead passes it.` : "No feed line this day. The log still plays every event."}</p>
            )}
          </div>
          <div className="rp-who">
            <div className="rp-mh">
              <span>active so far</span>
              <span>{num(counts.who.length)}</span>
            </div>
            <div className="rp-avs">
              {recentWho.length === 0 && <span className="rp-wait">nobody yet</span>}
              {recentWho.map((h) => (
                <Link key={h} href={builderHref(h)} className="rp-av" title={h}>
                  <Avatar handle={h} sample={day.sample} size={34} />
                  <span>{bare(h)}</span>
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <div className="rp-timeline">
        <div className="rp-lanes" aria-hidden="true">
          {GROUP_ORDER.map((g) => {
            const lane = counts.lanes[g];
            return (
              <div key={g} className={`rp-lane g-${g}`} style={{ "--glow": glow(lane.lastAt) } as CSSProperties}>
                <span className="rp-ln">
                  {GROUPS[g].chip}
                  <b>{num(lane.n)}</b>
                </span>
                <span className="rp-lt">
                  {passed.map((e) => (e.kind === "event" && e.group === g ? <i key={e.key} style={{ left: pct(e.at) }} /> : null))}
                </span>
              </div>
            );
          })}
        </div>
        <div className="rp-scrub">
          <span className="rp-ln rp-sl">UTC</span>
          <div
            className="rp-track"
            ref={track}
            role="slider"
            tabIndex={0}
            aria-label="Time of day"
            aria-valuemin={0}
            aria-valuemax={DAY_S}
            aria-valuenow={Math.round(t)}
            aria-valuetext={`${clock(t).slice(0, 5)} UTC`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onSliderKey}
          >
            <span className="rp-bins" aria-hidden="true">
              {bins.map((v, i) => (
                <i key={i} style={{ height: `${v ? Math.max(8, Math.round((v / binMax) * 100)) : 0}%` }} className={(i + 0.5) / BINS <= t / DAY_S ? "on" : undefined} />
              ))}
            </span>
            {end < DAY_S && <span className="rp-future" aria-hidden="true"></span>}
            {lines.map((l) => (
              <button
                key={l.key}
                type="button"
                className={`rp-pin ${HEAT_CLASS[l.item.heat]}${isCatch(l.item.heat) ? " hot" : ""}`}
                style={{ left: pct(l.at) }}
                title={`${clock(l.at).slice(0, 5)} UTC: ${l.item.handle} ${KIND_VERB[l.item.kind]} ${l.item.repo}, ${HEAT_LABEL[l.item.heat]} heat`}
                aria-label={`Jump to ${clock(l.at).slice(0, 5)}: ${l.item.handle} ${KIND_VERB[l.item.kind]} ${l.item.repo}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => seekTo(l.at - 120)}
              />
            ))}
            <span className="rp-head" aria-hidden="true"></span>
          </div>
        </div>
        <div className="rp-axis" aria-hidden="true">
          <span></span>
          <span className="rp-ticks">
            {["00", "03", "06", "09", "12", "15", "18", "21", "24"].map((h) => (
              <i key={h}>{h}</i>
            ))}
          </span>
        </div>
      </div>

      <div className="rp-ctrl">
        <button type="button" className="btn btn-acc rp-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
            </svg>
          )}
          {playing ? "Pause" : t >= end - 1 ? "Play again" : t > 0 ? "Resume" : "Play"}
        </button>
        <div className="viewsw rp-speed" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={speed === s ? "on" : undefined} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
        <button type="button" className="pill" onClick={() => seekTo(entries[Math.max(0, upTo(entries, t - 1))]?.at ?? 0)}>
          &lt; step
        </button>
        <button type="button" className="pill" onClick={() => seekTo(entries[idx + 1]?.at ?? end)}>
          step &gt;
        </button>
        <button type="button" className="pill" onClick={() => (setPlaying(false), seekTo(0))}>
          restart
        </button>
        <span className="rp-hint">
          {reduced ? "Reduced motion: the whole day is shown. Step or drag to move." : `${PLAY_S / speed} s for the whole day. Space plays and pauses, arrows move 15 min.`}
        </span>
      </div>
    </div>
  );
}
