import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { ActivityGrid, HourBars, Sparkline } from "@/components/Charts";
import { CopyPost } from "@/components/CopyPost";
import { GalleryCard } from "@/components/Gallery";
import { Heat } from "@/components/Heat";
import { repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { MoveChip, ScoreBreakdown } from "@/components/ScoreBreakdown";
import { getBuilder, getProjectRank } from "@/lib/data";
import { TokenBox, TokenTag } from "@/components/TokenBox";
import { everyText } from "@/lib/lookup";
import { ago, agoWords, bare, num, reasonText, shortDate } from "@/lib/format";
import { GROUPS, KIND_LABEL } from "@/lib/groups";
import { langColor } from "@/lib/langs";
import { builderPost, busiestWeekday, currentStreak, longestStreak, peakHour, shipsAt } from "@/lib/profile";

type Props = { params: Promise<{ handle: string }> };

async function load(handle: string) {
  try {
    return { b: await getBuilder(decodeURIComponent(handle)), down: false };
  } catch {
    return { b: null, down: true };
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { b } = await load((await params).handle);
  if (!b) return { title: "PUSHD Builders" };
  const who = b.name && b.name !== b.handle ? `${b.handle} (${b.name})` : b.handle;
  return {
    title: `${who} . PUSHD`,
    description: `What ${b.handle} publishes on public GitHub, as PUSHD sees it: activity, hottest lines, repos.${b.sample ? " (Sample.)" : ""}`,
    alternates: { canonical: `/builders/${bare(b.handle)}` },
  };
}

export default async function BuilderPage({ params }: Props) {
  const { handle } = await params;
  const { b, down } = await load(handle);
  if (down)
    return (
      <section className="page-head">
        <div className="wrap">
          <Prompt path="~/pushd/builders" cmd={`pushd who ${decodeURIComponent(handle)}`} />
          <h1>
            Not answering<span className="acc">.</span>
          </h1>
          <p className="lede">The watcher is not answering right now, so this page has nothing to show. It comes back the moment it does.</p>
        </div>
      </section>
    );
  // not a watched project (any more): its page as any GitHub account
  if (!b) redirect(`/gh/${encodeURIComponent(decodeURIComponent(handle).replace(/^@/, ""))}`);
  const pr = b.sample ? null : await getProjectRank(b.handle);
  const lastChange = pr?.changes[0] ?? null;
  const asOf = b.days.length ? b.days[b.days.length - 1].day + "T23:59:59Z" : new Date().toISOString();
  const now = b.lastReadAt && b.lastReadAt > (b.lastActiveAt ?? "") ? b.lastReadAt : asOf;
  const peak = peakHour(b.hours);
  const streak = currentStreak(b.days);
  const best = longestStreak(b.days);
  const wd = busiestWeekday(b.days);
  const activeDays = b.days.filter((d) => d.events > 0).length;
  const hrs = b.lastActiveAt ? (Date.parse(now) - Date.parse(b.lastActiveAt)) / 3_600_000 : Infinity;
  const mixMax = Math.max(1, ...b.mix.map((m) => m.count));
  const touched = b.touched ?? [];
  const touchedMax = Math.max(1, ...touched.map((t) => t.count));
  const gh = b.sample ? null : `https://github.com/${bare(b.handle)}`;

  return (
    <>
      <section className={`bhead g-${b.group}`}>
        <div className="wrap">
          <Prompt path="~/pushd/builders" cmd={`pushd who ${bare(b.handle)}`}>
            {b.sample && <span className="tag sample">Sample</span>}
          </Prompt>
          <div className="bhead-grid">
            <Avatar handle={b.handle} sample={b.sample} size={104} />
            <div style={{ minWidth: 0 }}>
              <h1>
                {b.token && b.name ? (
                  b.name
                ) : (
                  <>
                    {b.handle.startsWith("@") ? <span className="at">@</span> : null}
                    {bare(b.handle)}
                  </>
                )}
              </h1>
              <div className="bname">
                {b.token && b.name ? <span className="mono">github.com/{bare(b.handle)}</span> : b.name && b.name !== b.handle && <span>{b.name}</span>}
                {b.token ? <TokenTag token={b.token} /> : b.org && <span className="muted">{b.org}</span>}
                <span className="tag">
                  <i className="gdot" /> {GROUPS[b.group].mid}
                </span>
                <span className="tag">{b.type === "org" ? "org" : "person"}</span>
                {b.followers != null && <span className="mono muted" style={{ fontSize: 13 }}>{num(b.followers)} followers when checked</span>}
              </div>
            </div>
            <div className="bstatus">
              <span className="last">
                <i className={hrs < 1 ? "dotlive" : hrs < 24 ? "dotlive amber" : "dotlive off"} aria-hidden="true"></i>
                {b.lastActiveAt ? `last seen ${agoWords(b.lastActiveAt, now)}` : b.read ? "no recent public activity" : "not read yet"}
              </span>
              {b.lastActiveAt && (
                <span>
                  {b.lastWhat} <span className="cy">{b.lastRepo}</span>
                </span>
              )}
              <span className="btns">
                <Link className="btn btn-line" href={`/compare?b=${bare(b.handle)}`}>
                  Compare
                </Link>
                {gh && (
                  <a className="btn btn-line" href={gh} target="_blank" rel="noopener noreferrer">
                    GitHub -&gt;
                  </a>
                )}
              </span>
            </div>
          </div>
          <div className="bstats">
            <div>
              <div className="k">events, 7 days</div>
              <div className="v">{num(b.events7d)}</div>
            </div>
            <div>
              <div className="k">events, 30 days</div>
              <div className="v">{num(b.events30d)}</div>
            </div>
            <div>
              <div className="k">feed lines</div>
              <div className="v">{num(b.items)}</div>
            </div>
            <div>
              <div className="k">hot catches</div>
              <div className="v" style={{ color: b.catches ? "var(--heat-vhigh)" : undefined }}>
                {num(b.catches)}
              </div>
            </div>
            <div>
              <div className="k">streak now</div>
              <div className="v">
                {streak}
                <small>day{streak === 1 ? "" : "s"}</small>
              </div>
            </div>
            <div>
              <div className="k">longest, 12 weeks</div>
              <div className="v">
                {best}
                <small>day{best === 1 ? "" : "s"}</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="bgrid2 b-act" id="activity">
          <div className="panel">
            <div className="ptitle">
              <h3>Activity, 12 weeks</h3>
              <span>
                {activeDays} active day{activeDays === 1 ? "" : "s"}
              </span>
            </div>
            <ActivityGrid days={b.days} label={`${b.handle}: public activity per day over 12 weeks`} />
            <p className="footnote">
              {b.sample
                ? "Sample: one square per sample line."
                : b.type === "org"
                  ? "Code activity in the org's repos (pushes, branches, releases), as GitHub listed it when PUSHD read the account."
                  : "Public events as GitHub listed them when PUSHD read the account (GitHub keeps about 90 days and the last 100 per read)."}
            </p>
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Usually ships at</h3>
              <span>last 30 days, UTC</span>
            </div>
            <HourBars hours={b.hours} mark={peak} label={`${b.handle}: activity by hour of day`} />
            <div className="ships">
              <span>
                peak <b>{shipsAt(peak)}</b>
              </span>
              {wd && (
                <span>
                  busiest day <b>{wd}</b>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="bgrid3">
          <div className="panel">
            <div className="ptitle">
              <h3>What they do</h3>
              <span>30 days</span>
            </div>
            {b.mix.length ? (
              <div className="mix">
                {b.mix.map((m) => (
                  <div key={m.label} className="mix-row">
                    <span>{m.label}</span>
                    <span className="bar">
                      <i style={{ width: `${Math.round((m.count / mixMax) * 100)}%` }} />
                    </span>
                    <b>{m.count}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="estate">
                <b>Quiet.</b>
                <span>No public activity in the last 30 days.</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Repos they touch most</h3>
              <span>30 days</span>
            </div>
            {touched.length ? (
              <div className="mix">
                {touched.map((t) => (
                  <div key={t.repo} className="mix-row" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr) 4ch" }}>
                    <a className="cy" href={b.sample ? undefined : `https://github.com/${t.repo}`} target="_blank" rel="noopener noreferrer" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}>
                      {t.repo.split("/")[0].toLowerCase() === bare(b.handle).toLowerCase() ? t.repo.split("/").pop() : t.repo}
                    </a>
                    <span className="bar">
                      <i style={{ width: `${Math.round((t.count / touchedMax) * 100)}%` }} />
                    </span>
                    <b>{t.count}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="estate">
                <b>Nothing yet.</b>
                <span>Repos show here once activity is read.</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Languages</h3>
              <span>their own repos</span>
            </div>
            {b.languages.length ? (
              <div className="mix">
                {b.languages.map((l) => (
                  <div key={l.name} className="mix-row">
                    <span className="lang" style={{ "--lc": langColor(l.name) } as CSSProperties}>
                      {l.name}
                    </span>
                    <span className="bar">
                      <i style={{ width: `${Math.round((l.repos / b.languages[0].repos) * 100)}%`, background: langColor(l.name) }} />
                    </span>
                    <b>{l.repos}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="estate">
                <b>No repo list read.</b>
                <span>{b.sample ? "The sample has no repo lists." : "The watcher reads it every few looks."}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {(b.token ?? pr?.row.token) && (
        <section className="wrap" style={{ marginTop: 24 }}>
          <TokenBox token={(b.token ?? pr?.row.token)!} project={b.name ?? null} />
        </section>
      )}

      {pr && (
        <section className="wrap">
          <div className={`panel whyrank g-${pr.row.group}`} id="rank">
            <div className="ptitle">
              <h3>Why it ranks here</h3>
              <span>{pr.row.inTop ? "on the list" : "outside the list"}</span>
            </div>
            <div className="wr-grid">
              <div className="wr-side">
                <div className="rank-line">
                  <span className="rank-n">#{pr.row.rank}</span>
                  <MoveChip movement={pr.row.movement} delta={pr.row.delta} />
                </div>
                <ul className="wr-facts">
                  <li>
                    score <b>{pr.row.score.toFixed(1)}</b> of 100
                  </li>
                  {pr.row.inTop && pr.row.tier != null && (
                    <li>
                      tier {pr.row.tier}, read <b>{everyText(pr.row.checkEveryMin)}</b>
                    </li>
                  )}
                  {pr.row.enteredAt && <li>in since {shortDate(pr.row.enteredAt)}</li>}
                  {pr.poolSince && <li>on the list since {shortDate(pr.poolSince)}</li>}
                </ul>
                {pr.history.length > 1 && (
                  <div className="wr-hist">
                    <span className="k">rank, last passes</span>
                    <Sparkline values={pr.history.map((h) => Math.max(...pr.history.map((x) => x.rank)) + 3 - h.rank)} label={`${b.handle}: rank over the last passes`} />
                  </div>
                )}
                {lastChange && (
                  <p className="wr-change">
                    <span className={`mv mv-${lastChange.change === "enter" ? "new" : "down"}`}>{lastChange.change === "enter" ? "in" : "out"}</span> {reasonText(lastChange.reason)}
                  </p>
                )}
              </div>
              <ScoreBreakdown row={pr.row} />
            </div>
          </div>
        </section>
      )}

      <section className="section" style={{ paddingTop: 72 }}>
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">hottest lines</div>
              <h2>What PUSHD showed.</h2>
            </div>
            <Link className="textlink" href={`/feed`}>
              the feed -&gt;
            </Link>
          </div>
          {b.hottest.length ? (
            <div className="relcards cols3">
              {b.hottest.map((it) => (
                <GalleryCard key={it.id} item={it} asOf={now} />
              ))}
              {b.hottest.length < 3 &&
                Array.from({ length: 3 - b.hottest.length }, (_, i) => (
                  <div key={i} className="estate" style={{ borderRadius: 18 }}>
                    <b>{i === 0 ? "Next line lands here." : "Room for more."}</b>
                    <span>Most pushes are noise; only what passes the filter becomes a line.</span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="estate">
              <b>No lines from {b.handle} yet.</b>
              <span>The filter drops bumps, CI and everyday pushes. New repos, releases and fun names land here.</span>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="wrap bgrid2" style={{ marginTop: 0 }}>
          <div className="panel">
            <div className="ptitle">
              <h3>Recent public activity</h3>
              <span>newest first</span>
            </div>
            {b.recent.length ? (
              <ul className="alog">
                {b.recent.map((r, i) => (
                  <li key={`${r.at}-${i}`}>
                    <span className="t">{ago(r.at, now)}</span>
                    <span className="x">
                      {r.what}{" "}
                      {r.repo && (r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer">
                          {r.repo}
                        </a>
                      ) : (
                        <span className="cy">{r.repo}</span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="estate">
                <b>{b.read ? "No public activity seen." : "Not read yet."}</b>
                <span>{b.read ? "GitHub listed nothing recent for this account." : "The watcher reads every account in turn; this one is coming."}</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Lines, newest first</h3>
              <span>{num(b.lines.length)}</span>
            </div>
            {b.lines.length ? (
              <ul className="alog">
                {b.lines.slice(0, 10).map((it) => (
                  <li key={it.id} style={{ gridTemplateColumns: "5.5ch minmax(0, 1fr) auto" }}>
                    <span className="t">{ago(it.githubAt, now)}</span>
                    <span className="x">
                      <span className="kind" style={{ marginRight: 8 }}>
                        {KIND_LABEL[it.kind]}
                      </span>
                      <Link href={`/feed/${it.id}`}>{repoName(it)}</Link>
                    </span>
                    <Heat heat={it.heat} label={false} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="estate">
                <b>No lines yet.</b>
                <span>Activity is read; nothing passed the filter.</span>
              </div>
            )}
            <div style={{ marginTop: "auto", paddingTop: 20 }}>
              <CopyPost text={builderPost(b, now)} />
            </div>
          </div>
        </div>
      </section>

      {b.repos.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">their repos</div>
                <h2>Pushed to lately.</h2>
              </div>
              <span className="mono muted" style={{ fontSize: 12.5 }}>
                as GitHub listed them {b.repos[0].readAt ? `on ${shortDate(b.repos[0].readAt)}` : ""}
              </span>
            </div>
            <div className="rcards">
              {b.repos.map((r) => (
                <a key={r.fullName} className="rcard" href={r.url} target="_blank" rel="noopener noreferrer">
                  <span className="rh">{r.name}</span>
                  <p>{r.description ?? "No description."}</p>
                  <span className="rm">
                    {r.language && (
                      <span className="lang" style={{ "--lc": langColor(r.language) } as CSSProperties}>
                        {r.language}
                      </span>
                    )}
                    <span>{num(r.stars)} stars</span>
                    <span>{num(r.forks)} forks</span>
                    {r.pushedAt && <span>pushed {shortDate(r.pushedAt)}</span>}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="wrap">
        {b.source && (
          <p className="verified">
            <b>why we are sure</b>
            {b.source}
          </p>
        )}
        <div className="item-nav">
          <Link className="textlink" href="/watchlist">
            &lt;- the list
          </Link>
          <Link className="textlink" href="/holders">
            follow {bare(b.handle)} as a holder -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
