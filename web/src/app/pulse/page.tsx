import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { ActivityGrid, Sparkline } from "@/components/Charts";
import { Clock24, GroupLegend } from "@/components/Clock24";
import { CountUp } from "@/components/CountUp";
import { Heat } from "@/components/Heat";
import { repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { getPulse, getStats } from "@/lib/data";
import { agoWords, bare, builderHref, num, shortDate, utcTime, weekday } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { langColor } from "@/lib/langs";

export const metadata: Metadata = {
  title: "PUSHD Pulse",
  description: "The list at a glance: activity by camp and hour, leaderboards, languages, fresh repos and the busiest days.",
  alternates: { canonical: "/pulse" },
};

export default async function PulsePage() {
  const [p, stats] = await Promise.all([getPulse(), getStats()]);
  const head = (
    <section className="page-head">
      <div className="wrap">
        <div className="page-head-row">
          <div>
            <Prompt path="~/pushd" cmd="pushd pulse --all" />
            <h1>
              Pulse<span className="acc">.</span>
            </h1>
            <p className="lede">The list at a glance: who is busy, which camps are loud, what is new, and when they ship.</p>
          </div>
          <div className="statusbar">
            {p?.sample ? <span className="tag sample">Sample data</span> : <span className="tag live">public view</span>}
            {p && (
              <span>
                as of <b>{utcTime(p.asOf)}</b> UTC
              </span>
            )}
            <span>
              <b>{stats.publicDelayMinutes} min</b> behind
            </span>
          </div>
        </div>
      </div>
    </section>
  );
  if (!p)
    return (
      <>
        {head}
        <section className="wrap" style={{ marginTop: 36 }}>
          <div className="estate">
            <b>The watcher is not answering right now.</b>
            <span>The pulse comes back the moment it does.</span>
          </div>
        </section>
      </>
    );

  const t = p.totals;
  const campMax = Math.max(1, ...p.groups.map((g) => g.events7d));
  const dayMax = Math.max(1, ...p.busiestDays.map((d) => d.events));
  const langMax = Math.max(1, ...p.languages.map((l) => l.repos));

  return (
    <>
      {head}
      <section className="wrap" style={{ marginTop: 36 }}>
        <div className="livestats">
          <div>
            <div className="k">
              <span className="dotlive" aria-hidden="true"></span> events, 24h
            </div>
            <div className="v">
              <CountUp value={t.events24h} />
            </div>
            <p>Public GitHub activity by watched projects in the last day.</p>
          </div>
          <div>
            <div className="k">lines, 24h</div>
            <div className="v">
              <CountUp value={t.lines24h} live />
            </div>
            <p>What passed the filter and reached the feed.</p>
          </div>
          <div>
            <div className="k">catches, 7 days</div>
            <div className="v" style={{ color: "var(--heat-vhigh)" }}>
              <CountUp value={t.catches7d} />
            </div>
            <p>High heat and up.</p>
          </div>
          <div>
            <div className="k">active today</div>
            <div className="v">
              <CountUp value={t.active24h} />
            </div>
            <p>Builders with activity in the last 24 hours.</p>
          </div>
          <div>
            <div className="k">last read</div>
            <div className="v" style={{ fontSize: "clamp(22px, 2.2vw, 30px)" }}>
              {t.lastReadAt ? agoWords(t.lastReadAt, p.asOf) : "never"}
            </div>
            <p>
              {num(t.accountsRead)} of {num(t.accounts)} accounts read so far.
            </p>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 40 }}>
        <div className="wrap pulse-top">
          <div className="panel brk">
            <div className="ptitle">
              <h3>The last 24 hours</h3>
              <span>by camp and hour, UTC</span>
            </div>
            <Clock24 hours={p.hours} />
            <GroupLegend />
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Camps</h3>
              <span>events in 7 days</span>
            </div>
            <div className="camps">
              {p.groups.map((g) => (
                <div key={g.group} className={`camp g-${g.group}`}>
                  <span className="cn">
                    <i className="gdot" /> {GROUPS[g.group].title}
                  </span>
                  <span className="cb">
                    <i style={{ width: `${Math.round((g.events7d / campMax) * 100)}%` }} />
                  </span>
                  <span className="cv">
                    <b style={{ color: "var(--text)" }}>{num(g.events7d)}</b> . {g.active24h}/{g.accounts} today
                  </span>
                </div>
              ))}
            </div>
            <div className="ptitle" style={{ marginTop: 28 }}>
              <h3>Who was just at it</h3>
              <span>most recent first</span>
            </div>
            <ul className="alog">
              {p.active.slice(0, 6).map((a) => (
                <li key={a.handle} style={{ gridTemplateColumns: "7ch minmax(0, 1fr)" }}>
                  <span className="t">{agoWords(a.at, p.asOf).replace(" ago", "")}</span>
                  <span className="x">
                    <i className={`gdot g-${a.group}`} style={{ marginRight: 8 }} />
                    <Link href={builderHref(a.handle)} style={{ color: "var(--text)", fontWeight: 700 }}>
                      {a.handle}
                    </Link>{" "}
                    {a.what} <span className="cy">{a.repo}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap bgrid2" style={{ marginTop: 0 }}>
          <div className="panel">
            <div className="ptitle">
              <h3>The whole list, 12 weeks</h3>
              <span>{num(p.days.reduce((n, d) => n + d.events, 0))} events</span>
            </div>
            <ActivityGrid days={p.days} label="Public activity of the whole list per day, 12 weeks" />
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Busiest days</h3>
              <span>12 weeks</span>
            </div>
            {p.busiestDays.length ? (
              <ol className="days5">
                {p.busiestDays.map((d) => (
                  <li key={d.day}>
                    <Link href={`/brief/${d.day}`}>
                      {weekday(d.day)} {shortDate(d.day)}
                    </Link>
                    <span className="bar">
                      <i style={{ width: `${Math.round((d.events / dayMax) * 100)}%` }} />
                    </span>
                    <span>
                      <b>{num(d.events)}</b> <span className="muted">{d.items ? `. ${d.items} lines` : ""}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="estate">
                <b>No days yet.</b>
              </div>
            )}
            <p className="footnote">Each day opens its daily brief. Top builder that day: {p.busiestDays[0]?.top ?? "none"}.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">leaderboards</div>
              <h2>Who ships, what is hot, in what.</h2>
            </div>
            <Link className="textlink" href="/watchlist">
              everyone -&gt;
            </Link>
          </div>
          <div className="pulse-3">
            <div className="panel">
              <div className="ptitle">
                <h3>Most active, 7 days</h3>
              </div>
              {p.leaders.length ? (
                <ol className="lb">
                  {p.leaders.slice(0, 8).map((b) => (
                    <li key={b.handle}>
                      <Avatar handle={b.handle} sample={b.sample} size={30} />
                      <span className="who">
                        <Link href={builderHref(b.handle)}>{b.handle}</Link>
                        <small>{GROUPS[b.group].short}</small>
                      </span>
                      <Sparkline values={b.spark} label={`${b.handle}, 14 days`} />
                      <span className="n">{num(b.events7d)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="estate">
                  <b>Nobody yet.</b>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="ptitle">
                <h3>Hottest lines, 30 days</h3>
              </div>
              {p.hottest.length ? (
                <ul className="alog">
                  {p.hottest.map((it) => (
                    <li key={it.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto", padding: "10px 0" }}>
                      <span className="x" style={{ whiteSpace: "normal" }}>
                        <Link href={`/feed/${it.id}`} style={{ color: "var(--text)", fontWeight: 700 }}>
                          {it.handle} / <span className="cy">{repoName(it)}</span>
                        </Link>
                        <span style={{ display: "block", fontFamily: "var(--sans)", fontSize: 13.5, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.summary}</span>
                      </span>
                      <Heat heat={it.heat} label={false} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="estate">
                  <b>Nothing hot yet.</b>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="ptitle">
                <h3>Languages</h3>
                <span>repos pushed, 30 days</span>
              </div>
              {p.languages.length ? (
                <div className="mix">
                  {p.languages.map((l) => (
                    <div key={l.name} className="mix-row">
                      <span className="lang" style={{ "--lc": langColor(l.name) } as CSSProperties}>
                        {l.name}
                      </span>
                      <span className="bar">
                        <i style={{ width: `${Math.round((l.repos / langMax) * 100)}%`, background: langColor(l.name) }} />
                      </span>
                      <b>{l.repos}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="estate">
                  <b>{p.sample ? "No repo lists in the sample." : "No repo lists read yet."}</b>
                </div>
              )}
              {p.topics.length > 0 && (
                <>
                  <div className="ptitle" style={{ marginTop: 24, marginBottom: 12 }}>
                    <h3>Topics</h3>
                  </div>
                  <div className="chipline">
                    {p.topics.slice(0, 12).map((x) => (
                      <span key={x.name} className="tchip">
                        {x.name}
                        <b>{x.repos}</b>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="fresh">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">fresh repos</div>
              <h2>Made in the last 14 days.</h2>
              <p>New repos by watched projects, as GitHub listed them when PUSHD read the account.</p>
            </div>
          </div>
          {p.fresh.length ? (
            <div className="rcards">
              {p.fresh.slice(0, 6).map((r) => (
                <a key={r.fullName} className={`rcard g-${r.group}`} href={r.url} target="_blank" rel="noopener noreferrer">
                  <span className="rh">
                    <span className="muted">{bare(r.handle)}/</span>
                    {r.name}
                  </span>
                  <p>{r.description ?? "No description."}</p>
                  <span className="rm">
                    <span>
                      <i className="gdot" /> {GROUPS[r.group].short}
                    </span>
                    {r.language && (
                      <span className="lang" style={{ "--lc": langColor(r.language) } as CSSProperties}>
                        {r.language}
                      </span>
                    )}
                    <span>{num(r.stars)} stars</span>
                    <span>made {shortDate(r.createdAt)}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <div className="estate">
              <b>{p.sample ? "The sample has no repo lists." : "No fresh repos read yet."}</b>
              <span>They show here once the watcher reads the accounts&apos; repo lists.</span>
            </div>
          )}
          <p className="footnote">
            Counts are what GitHub listed when PUSHD read each account: about the last 90 days and up to 100 events a read. Orgs count
            code only (pushes, branches, releases), since anyone can star or comment in an org&apos;s repos. The public view runs{" "}
            {stats.publicDelayMinutes} minutes behind.
          </p>
        </div>
      </section>
    </>
  );
}
