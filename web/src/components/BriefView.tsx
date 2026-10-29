import Link from "next/link";
import { buildBrief, dayWords, lineWords } from "@/lib/brief";
import { neighbours } from "@/lib/data-days";
import type { DayDetail, DaySummary } from "@/lib/day-types";
import { bare, builderHref, hourLabel, num, utcTime } from "@/lib/format";
import { GROUPS, KIND_LABEL } from "@/lib/groups";
import { SITE } from "@/lib/site";
import { Avatar } from "./Avatar";
import { HourBars } from "./Charts";
import { CopyPost } from "./CopyPost";
import { CountUp } from "./CountUp";
import { DayStrip } from "./DayStrip";
import { Heat } from "./Heat";
import { Prompt } from "./Prompt";

// The daily brief: the day in fixed sentences built from the stored counts (src/lib/brief.ts), then the numbers
// behind them. No model writes any of it.

const VERDICT = { busy: "busy", quiet: "quiet", usual: "usual", unread: "not read yet" } as const;

export function BriefView({ day, days }: { day: DayDetail; days: DaySummary[] }) {
  const { older, newer } = neighbours(days, day.day);
  // a sample day is illustrative: it is never "today"
  const today = !day.sample && day.asOf.slice(0, 10) === day.day;
  const b = buildBrief(day, { url: `${SITE.url}/brief/${day.day}`, today });
  const campMax = Math.max(1, ...b.camps.flatMap((c) => [c.events, c.expected]));
  const latest = day.events.slice(-8).reverse();
  const topMax = Math.max(1, ...day.top.map((t) => t.events));
  return (
    <>
      <section className="page-head days-head brief-head">
        <div className="wrap">
          <Prompt path="~/pushd/brief" cmd={`pushd brief ${day.day}`}>
            {day.sample && <span className="tag sample">Sample data</span>}
            {today && <span className="tag acc live">today, so far</span>}
          </Prompt>
          <div className="brief-front">
            <div>
              <div className="eyebrow">the brief . {dayWords(day.day, true)}</div>
              <h1>{b.headline}</h1>
              <p className="lede">{b.lede}</p>
              <div className="hero-cta">
                <Link className="btn btn-acc" href={`/replay/${day.day}`}>
                  Replay this day <span aria-hidden="true">-&gt;</span>
                </Link>
                <a className="btn btn-line" href="#post">
                  Copy as post
                </a>
              </div>
            </div>
            <dl className="brief-nums">
              <div>
                <dt>public events</dt>
                <dd>
                  <CountUp value={day.totalEvents} />
                </dd>
              </div>
              <div>
                <dt>feed lines</dt>
                <dd>
                  <CountUp value={day.lines.length} />
                </dd>
              </div>
              <div>
                <dt>hot catches</dt>
                <dd className={day.catches ? "hot" : undefined}>
                  <CountUp value={day.catches} />
                </dd>
              </div>
              <div>
                <dt>builders active</dt>
                <dd>
                  <CountUp value={day.active} />
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className="wrap days-body">
        <DayStrip days={days} current={day.day} base="/brief" older={older} newer={newer} />

        <div className="brief-grid">
          <article className="panel brief-top">
            <div className="brief-ph">
              <span>
                <span className="acc">$</span> sort --by heat | head -5
              </span>
              <span>{num(day.lines.length)} lines</span>
            </div>
            {b.top.length === 0 ? (
              <>
                <p className="brief-none">
                  {today ? "No line has made the feed yet today." : "No line made the feed this day."} The watcher stored {num(day.totalEvents)} public event
                  {day.totalEvents === 1 ? "" : "s"}; the latest are below, and the replay plays them all.
                </p>
                {latest.length > 0 && (
                  <ol className="brief-latest">
                    {latest.map((e, i) => (
                      <li key={`${e.at}-${i}`} className={`g-${e.group}`}>
                        <span className="rp-at">{utcTime(e.at).slice(0, 5)}</span>
                        <span className="rp-dot" aria-hidden="true"></span>
                        <span className="rp-txt">
                          <Link className="rp-h" href={builderHref(e.handle)}>
                            {e.handle}
                          </Link>{" "}
                          {e.what} {e.repo && <span className="rp-r">{e.repo}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              <ol className="brief-list">
                {b.top.map((it, i) => (
                  <li key={it.id}>
                    <span className="brief-rank">{String(i + 1).padStart(2, "0")}</span>
                    <div className="brief-li">
                      <div className="brief-lt">
                        <span className="kind">{KIND_LABEL[it.kind]}</span>
                        <span className="brief-at">{utcTime(it.githubAt).slice(0, 5)} UTC</span>
                        {it.sample && <span className="tag sample">Sample</span>}
                      </div>
                      <Link className="brief-lw" href={`/feed/${it.id}`}>
                        {lineWords(it)}
                      </Link>
                      <p>{it.summary}</p>
                    </div>
                    <Heat heat={it.heat} />
                  </li>
                ))}
              </ol>
            )}
          </article>

          <article className="panel brief-camps">
            <div className="brief-ph">
              <span>
                <span className="acc">$</span> camps --vs last-7-days
              </span>
              <span>events</span>
            </div>
            <ul>
              {b.camps.map((c) => (
                <li key={c.group} className={`v-${c.verdict}`}>
                  <div className="bc-top">
                    <b>{GROUPS[c.group].chip}</b>
                    <span className="bc-tag">{VERDICT[c.verdict]}</span>
                  </div>
                  <div className="bc-bars" aria-hidden="true">
                    <span className="bc-day">
                      <i style={{ width: `${(c.events / campMax) * 100}%` }} />
                    </span>
                    <span className="bc-avg">
                      <i style={{ width: `${(c.expected / campMax) * 100}%` }} />
                    </span>
                  </div>
                  <p>{c.line}</p>
                </li>
              ))}
            </ul>
            <p className="brief-key">
              <span>
                <i className="k-day" /> this day
              </span>
              <span>
                <i className="k-avg" /> {today ? "usual pace by this hour" : "average day, the 7 days before"}
              </span>
            </p>
            <p className="brief-fine">The week before counts what GitHub still listed when the watcher read each account, so older days can read low.</p>
          </article>
        </div>

        <div className="brief-grid three">
          <article className="panel brief-who">
            <div className="brief-ph">
              <span>
                <span className="acc">$</span> busiest builders
              </span>
              <span>events</span>
            </div>
            {day.top.length === 0 ? (
              <p className="brief-none">Nobody was active this day, as far as the watcher has read.</p>
            ) : (
              <ul>
                {day.top.slice(0, 6).map((t) => (
                  <li key={t.handle}>
                    <Link href={builderHref(t.handle)} className="bw-who">
                      <Avatar handle={t.handle} sample={day.sample} size={30} />
                      <span>
                        <b>{bare(t.handle)}</b>
                        <small>{t.name ?? GROUPS[t.group].mid}</small>
                      </span>
                    </Link>
                    <span className="bw-bar" aria-hidden="true">
                      <i style={{ width: `${(t.events / topMax) * 100}%` }} />
                    </span>
                    <span className="bw-n">
                      {num(t.events)}
                      {t.lines > 0 && <small> . {t.lines} line{t.lines === 1 ? "" : "s"}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="panel brief-hours">
            <div className="brief-ph">
              <span>
                <span className="acc">$</span> busiest hour
              </span>
              <span>UTC</span>
            </div>
            <div className="bh-big">
              {b.busiestHour ? (
                <>
                  <b>{hourLabel(b.busiestHour.hour)}</b>
                  <span>{num(b.busiestHour.events)} events in that hour</span>
                </>
              ) : (
                <>
                  <b>--:--</b>
                  <span>no events stored</span>
                </>
              )}
            </div>
            <HourBars hours={day.hours} label={`Events by hour of ${dayWords(day.day)}, UTC`} mark={b.busiestHour?.hour ?? null} />
          </article>

          <article className="panel brief-fresh">
            <div className="brief-ph">
              <span>
                <span className="acc">$</span> new repos
              </span>
              <span>{num(day.fresh.length)}</span>
            </div>
            {day.fresh.length === 0 ? (
              <p className="brief-none">{day.sample ? "The sample has no repo list." : "No new repo in the stored repo lists for this day."}</p>
            ) : (
              <ul className={day.fresh.length < 3 ? "few" : undefined}>
                {day.fresh.slice(0, 5).map((r) => (
                  <li key={r.fullName}>
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      <b>{r.fullName}</b>
                    </a>
                    {r.description && <p>{r.description}</p>}
                    <small>
                      {[r.language, `${num(r.stars)} star${r.stars === 1 ? "" : "s"}`, `${utcTime(r.createdAt).slice(0, 5)} UTC`].filter(Boolean).join(" · ")}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            {day.fresh.length < 3 && (
              <div className="brief-fill">
                <span>
                  New repos land here as the watcher reads each builder&apos;s repo list.
                  <span className="cursor" aria-hidden="true"></span>
                </span>
                <Link className="textlink" href="/pulse">
                  fresh repos on pulse -&gt;
                </Link>
              </div>
            )}
          </article>
        </div>

        <div className="brief-post" id="post">
          <div>
            <div className="eyebrow">share the day</div>
            <h2>Copy as post.</h2>
            <p>The day in a few lines, with the link to this page. Plain text: nothing is posted for you.</p>
          </div>
          <CopyPost text={b.post} />
        </div>

        <div className="days-foot">
          <p>Written from the stored counts with fixed sentences. No model writes this page, and it says only what the counts say.</p>
          <Link className="textlink" href={`/replay/${day.day}`}>
            replay {dayWords(day.day)} -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
