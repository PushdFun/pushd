import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cache, type CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { ActivityGrid, HourBars } from "@/components/Charts";
import { GhState } from "@/components/GhState";
import { Prompt } from "@/components/Prompt";
import { MoveChip, ScoreBreakdown } from "@/components/ScoreBreakdown";
import { SuggestForm } from "@/components/SuggestForm";
import { WatchButton } from "@/components/WatchButton";
import { getGhUser, getHolder, getHolderWatch } from "@/lib/data";
import { ago, agoWords, num, shortDate } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { langColor } from "@/lib/langs";
import { everyText, ghRepoHref } from "@/lib/lookup";
import { busiestWeekday, peakHour, shipsAt } from "@/lib/profile";
import type { RepoCard } from "@/lib/types";

type Props = { params: Promise<{ login: string }> };

const load = cache(async (login: string) => getGhUser(decodeURIComponent(login)));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { login } = await params;
  const l = await load(login);
  if (l.state !== "ok") return { title: "PUSHD Lookup", robots: { index: false } };
  const u = l.page.user;
  return {
    title: `${u.login}${u.name && u.name !== u.login ? ` (${u.name})` : ""} on GitHub . PUSHD`,
    description: `${u.login}'s public GitHub activity as PUSHD read it: activity, repos, languages. Not on PUSHD's watchlist.`,
    alternates: { canonical: `/gh/${u.login}` },
  };
}

function Repos({ list, owner }: { list: RepoCard[]; owner: string }) {
  return (
    <div className="rcards">
      {list.map((r) => (
        <Link key={r.fullName} className="rcard" href={ghRepoHref(owner, r.name)}>
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
        </Link>
      ))}
    </div>
  );
}

export default async function GhUserPage({ params }: Props) {
  const { login } = await params;
  const l = await load(login);
  if (l.state === "redirect") redirect(l.to);
  if (l.state !== "ok") return <GhState load={l} path="~/pushd/gh" cmd={`pushd who ${decodeURIComponent(login)}`} />;
  const p = l.page;
  const u = p.user;
  const [holder] = await Promise.all([getHolder()]);
  const watch = holder?.status.holder ? await getHolderWatch() : null;
  const now = p.readAt;
  const last = p.recent[0] ?? null;
  const hrs = last ? (Date.parse(now) - Date.parse(last.at)) / 3_600_000 : Infinity;
  const days30 = p.days.slice(-30).reduce((n, d) => n + d.events, 0);
  const activeDays = p.days.filter((d) => d.events > 0).length;
  const peak = peakHour(p.hours);
  const wd = busiestWeekday(p.days);
  const mixMax = Math.max(1, ...p.mix.map((m) => m.count));
  const stars = p.repos.reduce((n, r) => n + r.stars, 0);
  const group = p.rank?.group ?? null;
  const blog = u.blog && /^https?:\/\//.test(u.blog) ? u.blog : u.blog ? `https://${u.blog}` : null;

  return (
    <>
      <section className={`bhead${group ? ` g-${group}` : ""}`}>
        <div className="wrap">
          <Prompt path="~/pushd/gh" cmd={`pushd who ${u.login}`}>
            <span className="tag outside">not on the watchlist</span>
          </Prompt>
          <div className="bhead-grid">
            <Avatar handle={u.login} size={104} />
            <div style={{ minWidth: 0 }}>
              <h1>{u.login}</h1>
              <div className="bname">
                {u.name && u.name !== u.login && <span>{u.name}</span>}
                {u.company && <span className="muted">{u.company}</span>}
                <span className="tag">{u.type === "org" ? "org" : "person"}</span>
                {p.rank && (
                  <span className="tag">
                    <i className="gdot" /> {GROUPS[p.rank.group].mid}
                  </span>
                )}
                {u.followers != null && <span className="mono muted" style={{ fontSize: 13 }}>{num(u.followers)} followers</span>}
              </div>
              {u.bio && <p className="gh-bio">{u.bio}</p>}
            </div>
            <div className="bstatus">
              <span className="last">
                <i className={hrs < 1 ? "dotlive" : hrs < 24 ? "dotlive amber" : "dotlive off"} aria-hidden="true"></i>
                {last ? `last seen ${agoWords(last.at, now)}` : "no recent public activity"}
              </span>
              {last && (
                <span>
                  {last.what} <span className="cy">{last.repo}</span>
                </span>
              )}
              <span className="btns">
                <WatchButton login={u.login} view={watch} />
                <a className="btn btn-line" href={u.url} target="_blank" rel="noopener noreferrer">
                  GitHub -&gt;
                </a>
              </span>
            </div>
          </div>
          <div className="bstats">
            <div>
              <div className="k">events, 30 days</div>
              <div className="v">{num(days30)}</div>
            </div>
            <div>
              <div className="k">active days, 12 weeks</div>
              <div className="v">{num(activeDays)}</div>
            </div>
            <div>
              <div className="k">public repos</div>
              <div className="v">{u.publicRepos != null ? num(u.publicRepos) : "?"}</div>
            </div>
            <div>
              <div className="k">stars, top repos</div>
              <div className="v">{num(stars)}</div>
            </div>
            <div>
              <div className="k">rank on the list</div>
              <div className="v">{p.rank ? `#${p.rank.rank}` : "none"}</div>
            </div>
            <div>
              <div className="k">holders watching</div>
              <div className="v">{num(p.watchers)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap">
        <p className={p.stale ? "readnote stale" : "readnote"}>
          Read from GitHub {agoWords(p.readAt, new Date().toISOString())}
          {p.stale ? ". GitHub was busy, so this is the last good read; it is read again when there is room." : ", kept for a while so a busy page costs GitHub nothing."}
          {u.createdAt ? ` On GitHub since ${shortDate(u.createdAt)} ${new Date(u.createdAt).getUTCFullYear()}.` : ""}
          {blog && (
            <>
              {" "}
              <a href={blog} target="_blank" rel="noopener noreferrer nofollow">
                {u.blog}
              </a>
            </>
          )}
        </p>
        <div className="bgrid2 b-act" id="activity">
          <div className="panel">
            <div className="ptitle">
              <h3>Activity, 12 weeks</h3>
              <span>
                {activeDays} active day{activeDays === 1 ? "" : "s"}
              </span>
            </div>
            <ActivityGrid days={p.days} label={`${u.login}: public activity per day over 12 weeks`} />
            <p className="footnote">Public events as GitHub listed them when PUSHD read the account (GitHub keeps about 90 days and the last few hundred).</p>
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Usually active at</h3>
              <span>UTC</span>
            </div>
            <HourBars hours={p.hours} mark={peak} label={`${u.login}: activity by hour of day`} />
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
              <span>public events</span>
            </div>
            {p.mix.length ? (
              <div className="mix">
                {p.mix.map((m) => (
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
                <span>No public events in GitHub&apos;s list.</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Languages</h3>
              <span>their own repos</span>
            </div>
            {p.languages.length ? (
              <div className="mix">
                {p.languages.map((x) => (
                  <div key={x.name} className="mix-row">
                    <span className="lang" style={{ "--lc": langColor(x.name) } as CSSProperties}>
                      {x.name}
                    </span>
                    <span className="bar">
                      <i style={{ width: `${Math.round((x.repos / p.languages[0].repos) * 100)}%`, background: langColor(x.name) }} />
                    </span>
                    <b>{x.repos}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="estate">
                <b>No languages.</b>
                <span>No public repos with code.</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>In the ranking</h3>
              <span>{p.rank ? `#${p.rank.rank} on the list` : "not on the list"}</span>
            </div>
            {p.rank ? (
              <>
                <div className="rank-line">
                  <span className="rank-n">#{p.rank.rank}</span>
                  <MoveChip movement={p.rank.movement} delta={p.rank.delta} />
                  <span className="muted">{p.rank.inTop ? `on the list, read ${everyText(p.rank.checkEveryMin)}` : "outside the list"}</span>
                </div>
                <ScoreBreakdown row={p.rank} compact />
              </>
            ) : (
              <div className="estate">
                <b>Not ranked.</b>
                <span>The ranking looks at crypto token projects with a public GitHub. If this one belongs, suggest it below.</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 72 }}>
        <div className="wrap bgrid2" style={{ marginTop: 0 }}>
          <div className="panel">
            <div className="ptitle">
              <h3>Latest public activity</h3>
              <span>newest first</span>
            </div>
            {p.recent.length ? (
              <ul className="alog">
                {p.recent.slice(0, 14).map((r, i) => (
                  <li key={`${r.at}-${i}`}>
                    <span className="t">{ago(r.at, now)}</span>
                    <span className="x">
                      {r.what}{" "}
                      {r.repo &&
                        (r.repo.includes("/") ? (
                          <Link href={ghRepoHref(r.repo.split("/")[0], r.repo.split("/")[1])}>{r.repo}</Link>
                        ) : (
                          <span className="cy">{r.repo}</span>
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="estate">
                <b>No public activity seen.</b>
                <span>GitHub listed nothing recent for this account.</span>
              </div>
            )}
          </div>
          <div className="panel" id="suggest">
            <div className="ptitle">
              <h3>Suggest {u.login}</h3>
              <span>for the ranking&apos;s pool</span>
            </div>
            <p className="muted" style={{ marginBottom: 18 }}>
              Think {u.login} belongs with the crypto projects PUSHD ranks? Say why. The owner reads every suggestion; nothing is added by itself.
            </p>
            <SuggestForm login={u.login} camp={group ?? "oss"} compact />
          </div>
        </div>
      </section>

      {p.repos.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">their repos</div>
                <h2>Most starred.</h2>
              </div>
              <span className="mono muted" style={{ fontSize: 12.5 }}>
                as GitHub listed them on {shortDate(p.readAt)}
              </span>
            </div>
            <Repos list={p.repos.slice(0, 6)} owner={u.login} />
          </div>
        </section>
      )}

      {p.fresh.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">lately</div>
                <h2>Pushed to lately.</h2>
              </div>
            </div>
            <Repos list={p.fresh.slice(0, 6)} owner={u.login} />
          </div>
        </section>
      )}

      <section className="wrap">
        <div className="item-nav">
          <Link className="textlink" href="/gh">
            &lt;- look up someone else
          </Link>
          <Link className="textlink" href="/watchlist">
            the list -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
