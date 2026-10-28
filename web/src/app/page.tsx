import Link from "next/link";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { Sparkline } from "@/components/Charts";
import { CountUp } from "@/components/CountUp";
import { GalleryCard } from "@/components/Gallery";
import { Heat } from "@/components/Heat";
import { repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { RightNow } from "@/components/RightNow";
import { Ticker } from "@/components/Ticker";
import { getBuilders, getFeed, getPulse, getStats } from "@/lib/data";
import { agoWords, bare, builderHref, num, shortDate, utcTime } from "@/lib/format";
import { GROUPS, HEAT_RANK, KIND_LABEL, KIND_VERB, isCatch } from "@/lib/groups";
import { langColor } from "@/lib/langs";
import type { FeedItem } from "@/lib/types";

export default async function Home() {
  const [feed, stats, pulse, { builders }] = await Promise.all([getFeed(), getStats(), getPulse(), getBuilders()]);
  const sample = feed.source === "sample";
  const asOf = pulse?.asOf ?? feed.asOf;
  const catches = feed.items.filter((it) => isCatch(it.heat));
  // The real catch first when there is one: in the sample, the made-up lines have no link.
  const card = catches.find((it) => it.heat === "veryHigh" && it.url) ?? catches.find((it) => it.heat === "veryHigh") ?? catches[0];
  const tail = catches.filter((it) => it !== card).slice(0, 3);

  // the hero's panel: the hottest line of the day on top (the week's when today has none), then the newest lines
  const day = feed.items.filter((it) => Date.parse(asOf) - Date.parse(it.githubAt) < 86_400_000);
  const byHeat = (a: FeedItem, b: FeedItem) => HEAT_RANK[b.heat] - HEAT_RANK[a.heat] || (b.score ?? 0) - (a.score ?? 0);
  const featured = [...(day.length ? day : feed.items)].sort(byHeat).find((it) => HEAT_RANK[it.heat] >= HEAT_RANK.medium) ?? null;
  // one row per repo and kind: two pushes to the same repo would read as a repeat
  const seen = new Set<string>();
  const nowRows = feed.items.filter((it) => it !== featured && !seen.has(`${it.handle}/${it.repo}/${it.kind}`) && !!seen.add(`${it.handle}/${it.repo}/${it.kind}`)).slice(0, 5);
  const nowLabel = feed.live ? "live" : `public view, +${stats.publicDelayMinutes} min`;
  const leaders = (pulse?.leaders ?? []).slice(0, 6);
  const fresh = (pulse?.fresh ?? []).slice(0, 6);
  const active = (pulse?.active ?? []).slice(0, 5);
  const newest = feed.items.slice(0, 3);
  const t = pulse?.totals;

  return (
    <>
      <Ticker items={feed.items.slice(0, 14)} asOf={feed.asOf} label={sample ? "sample" : feed.live ? "live" : `public +${stats.publicDelayMinutes}m`} />

      <section className="hero hero-v2">
        <div className="wrap hero-grid">
          <div>
            <Prompt path="~/pushd" cmd="git push">
              <span className="tag acc">watching the top {stats.builders}</span>
            </Prompt>
            <h1>
              Know the moment builders{" "}
              <span className="nw">
                <span className="hl">push</span>
                <span className="cursor" aria-hidden="true"></span>
              </span>
            </h1>
            <p className="lede">
              PUSHD watches the public GitHub of the {stats.builders} most active crypto projects on GitHub right now. When one of them
              publishes, you get one plain line, the link, and a heat mark when it looks meme-able.
            </p>
            <div className="hero-cta">
              <Link className="btn btn-acc" href="/feed">
                Open the feed <span aria-hidden="true">-&gt;</span>
              </Link>
              <Link className="btn btn-line" href="/replay">
                Replay a day
              </Link>
            </div>
            <div className="hero-meta">
              <span>public info only</span>
              <span>never trades other coins</span>
              <span>holders see it live</span>
            </div>
          </div>
          <RightNow items={nowRows} featured={featured} asOf={asOf} label={nowLabel} sample={sample} />
        </div>
      </section>

      <section className="wrap" aria-label="Numbers">
        {t ? (
          <div className="livestats">
            <div>
              <div className="k">
                <span className="dotlive" aria-hidden="true"></span> events seen
              </div>
              <div className="v">
                <CountUp value={t.events} />
              </div>
              <p>Public GitHub events the watcher read{sample ? " (sample lines)" : ""}.</p>
            </div>
            <div>
              <div className="k">kept as lines</div>
              <div className="v">
                <CountUp value={t.lines} live />
              </div>
              <p>The rest was noise: bumps, CI, typos, everyday pushes.</p>
            </div>
            <div>
              <div className="k">hot catches</div>
              <div className="v" style={{ color: "var(--heat-vhigh)" }}>
                <CountUp value={t.catches} />
              </div>
              <p>High heat and up, logged with the time PUSHD showed them.</p>
            </div>
            <div>
              <div className="k">active today</div>
              <div className="v">
                <CountUp value={t.active24h} />
              </div>
              <p>Projects with public activity in the last 24 hours.</p>
            </div>
            <div>
              <div className="k">read so far</div>
              <div className="v">
                {num(t.accountsRead)}
                <small style={{ fontSize: 18, color: "var(--muted)", fontWeight: 500 }}> / {num(t.accounts)}</small>
              </div>
              <p>Accounts the watcher has read at least once. Holders see lines {stats.publicDelayMinutes} min sooner.</p>
            </div>
          </div>
        ) : (
          <div className="estate">
            <b>The watcher is not answering right now.</b>
            <span>The numbers come back the moment it does.</span>
          </div>
        )}
      </section>

      {active.length > 0 && (
        <section className="section" style={{ paddingTop: 64 }}>
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">last seen pushing</div>
                <h2>Who was just at it.</h2>
              </div>
              <Link className="textlink" href="/pulse">
                the pulse -&gt;
              </Link>
            </div>
            <div className="presence">
              {active.map((a) => {
                const hrs = (Date.parse(asOf) - Date.parse(a.at)) / 3_600_000;
                return (
                  <Link key={a.handle} className={`pcard g-${a.group}`} href={builderHref(a.handle)}>
                    <Avatar handle={a.handle} sample={sample} size={40} />
                    <span className="pw">
                      <span className="ph">
                        <i className={hrs < 1 ? "dotlive" : hrs < 24 ? "dotlive amber" : "dotlive off"} aria-hidden="true"></i>
                        <span>{a.handle}</span>
                      </span>
                      <span className="pt">
                        {a.what} {a.repo && <span className="cy">{a.repo.split("/").pop()}</span>}
                      </span>
                      <span className="pa">
                        {agoWords(a.at, asOf)} . {GROUPS[a.group].short}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">latest hot catch</div>
              <h2>The kind of push PUSHD is for.</h2>
              <p>
                {card && card.handle !== "toly" && card.handle !== "aeyakovenko"
                  ? "The latest high heat line the watcher kept: who, what, and the time PUSHD showed it."
                  : "27 Oct 2026. Solana's founder made a new repo, and a coin launched on it the same day. PUSHD puts moments like this in one line."}
              </p>
            </div>
            <Link className="textlink" href="/catches">
              catches log -&gt;
            </Link>
          </div>
          <div className="catch-grid">
            {card ? (
              <article className="panel catch-card brk">
                <div className="top">
                  <span className="kind">{KIND_LABEL[card.kind]}</span>
                  {card.sample && <span className="tag sample">Sample</span>}
                </div>
                <h3>
                  <Link className="who-link" href={builderHref(card.handle)}>
                    {card.handle}
                  </Link>{" "}
                  {KIND_VERB[card.kind]} <span className="repo">{repoName(card)}</span>
                </h3>
                <p className="sum">{card.summary}</p>
                <div className="bigheat">
                  <Heat heat={card.heat} />
                </div>
                <dl className="kv">
                  <div>
                    <dt>who</dt>
                    <dd>{[card.handle, card.org].filter(Boolean).join(", ")}</dd>
                  </div>
                  <div>
                    <dt>group</dt>
                    <dd>{GROUPS[card.group].mid}</dd>
                  </div>
                  <div>
                    <dt>shown at</dt>
                    <dd className="acc">{card.shownAt ? `${utcTime(card.shownAt)} UTC` : "replay pending"}</dd>
                  </div>
                  <div>
                    <dt>link</dt>
                    <dd>
                      <Link href={`/feed/${card.id}`}>details -&gt;</Link>
                    </dd>
                  </div>
                </dl>
              </article>
            ) : (
              <article className="panel catch-card">
                <h3>No catches yet.</h3>
                <p className="sum">Hot lines land here the moment the watcher shows them.</p>
              </article>
            )}
            <aside className="panel mini-log">
              <h4>
                <span className="acc">$</span> tail -3 catches.log
              </h4>
              {tail.map((it) => (
                <div key={it.id} className="mini-row">
                  <span className="w">
                    {it.handle} <em>/</em> {repoName(it)}
                  </span>
                  <Heat heat={it.heat} label={false} />
                  <span className="t">
                    {KIND_LABEL[it.kind]} . {GROUPS[it.group].short}
                  </span>
                  {it.sample && <span className="t">Sample</span>}
                </div>
              ))}
              {tail.length < 3 && (
                <div className="mini-more">
                  <span>More catches land here as projects push.</span>
                  <span className="cursor" aria-hidden="true"></span>
                </div>
              )}
              <p className="note">A catch is a time stamp: who, what, when PUSHD showed it. No prices, no buy links.</p>
              <Link className="textlink" href="/catches">
                full catches log -&gt;
              </Link>
            </aside>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">this week</div>
              <h2>Who ships, and what is new.</h2>
            </div>
            <Link className="textlink" href="/pulse">
              all leaderboards -&gt;
            </Link>
          </div>
          <div className="duo">
            <div className="panel">
              <h3>Most active builders</h3>
              <p className="sub">Public GitHub events in the last 7 days, as the watcher read them.</p>
              {leaders.length ? (
                <ol className="lb">
                  {leaders.map((b) => (
                    <li key={b.handle}>
                      <Avatar handle={b.handle} sample={b.sample} size={32} />
                      <span className="who">
                        <Link href={builderHref(b.handle)}>{b.handle}</Link>
                        <small>{[b.name !== b.handle ? b.name : null, GROUPS[b.group].short].filter(Boolean).join(" . ")}</small>
                      </span>
                      <Sparkline values={b.spark} label={`${b.handle}: activity over 14 days`} />
                      <span className="n">
                        {num(b.events7d)}
                        <small>events</small>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="estate">
                  <b>Nobody read this week yet.</b>
                  <span>The board fills as the watcher reads the list.</span>
                </div>
              )}
              <div className="foot">
                <span>{sample ? "sample: counts of sample lines" : "GitHub lists up to 100 recent events per read"}</span>
                <Link className="textlink" href="/watchlist">
                  everyone -&gt;
                </Link>
              </div>
            </div>
            <div className="panel">
              <h3>Fresh repos</h3>
              <p className="sub">Made in the last 14 days by watched projects, as GitHub lists them.</p>
              {fresh.length ? (
                <ul className="repo-list">
                  {fresh.map((r) => (
                    <li key={r.fullName}>
                      <a className="rn" href={r.url} target="_blank" rel="noopener noreferrer">
                        <em>{bare(r.handle)}/</em>
                        {r.name}
                      </a>
                      <span className="meta">
                        {r.language && (
                          <span className="lang" style={{ "--lc": langColor(r.language) } as CSSProperties}>
                            {r.language}
                          </span>
                        )}{" "}
                        . {shortDate(r.createdAt)}
                      </span>
                      {r.description && <p>{r.description}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="estate">
                  <b>{sample ? "No repo lists in the sample." : "No fresh repos read yet."}</b>
                  <span>New repos from the list show here once the watcher reads them.</span>
                </div>
              )}
              <div className="foot">
                <span>stars and forks on each repo page</span>
                <Link className="textlink" href="/pulse#fresh">
                  more -&gt;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {newest.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">newest lines</div>
                <h2>Straight from the feed.</h2>
              </div>
              <Link className="textlink" href="/feed?view=gallery">
                gallery -&gt;
              </Link>
            </div>
            <div className="gal-preview">
              {newest.map((it) => (
                <GalleryCard key={it.id} item={it} asOf={feed.asOf} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">explore</div>
              <h2>More ways to watch.</h2>
            </div>
            <span className="mono muted" style={{ fontSize: 13 }}>
              press <kbd className="tchip">Ctrl K</kbd> to jump anywhere
            </span>
          </div>
          <div className="explore">
            <Link className="xcard" href="/replay">
              <span className="xc">
                <b>$</b> pushd replay
              </span>
              <h3>Replay</h3>
              <p>A whole day of pushes, played back in 60 seconds, the hot moments flagged.</p>
              <span className="xart" aria-hidden="true">
                00:00 <b>|||| ||| |||||||</b> 24:00
              </span>
            </Link>
            <Link className="xcard" href="/brief">
              <span className="xc">
                <b>$</b> pushd brief
              </span>
              <h3>Daily brief</h3>
              <p>What the projects shipped today, the top five by heat, busy and quiet camps.</p>
              <span className="xart" aria-hidden="true">
                top 5 . camps . <b>new repos</b>
              </span>
            </Link>
            <Link className="xcard" href="/pulse">
              <span className="xc">
                <b>$</b> pushd pulse
              </span>
              <h3>Pulse</h3>
              <p>Activity by camp and hour, leaderboards, languages and the busiest days.</p>
              <span className="xart" aria-hidden="true">
                chain <b>||||</b> ai <b>|||||||</b> oss <b>||</b>
              </span>
            </Link>
            <Link className="xcard" href={builders.length >= 2 ? `/compare?b=${[...builders].sort((a, b) => b.events30d - a.events30d).slice(0, 2).map((b) => bare(b.handle)).join(",")}` : "/compare"}>
              <span className="xc">
                <b>$</b> pushd diff
              </span>
              <h3>Compare</h3>
              <p>Two or three builders side by side over 30 days.</p>
              <span className="xart" aria-hidden="true">
                a <b>||||||</b> b <b>|||</b> c <b>|||||||||</b>
              </span>
            </Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">how it works</div>
              <h2>Three commands. That is the whole thing.</h2>
            </div>
            <Link className="textlink" href="/how">
              read the manual -&gt;
            </Link>
          </div>
          <div className="steps">
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> pushd watch
                </span>
                <span className="n">01</span>
              </div>
              <div className="body">
                <h3>Watch</h3>
                <p>
                  The {stats.builders} most active crypto projects on GitHub, ranked every hour. New repos, pushes, releases and public
                  gists, read from GitHub&apos;s public activity.
                </p>
              </div>
              <div className="art">
                GET events?who=toly
                <br />
                <b>304</b> nothing new, costs nothing
                <br />
                <b>200</b> new event, keep going
              </div>
            </div>
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> pushd score
                </span>
                <span className="n">02</span>
              </div>
              <div className="body">
                <h3>Score</h3>
                <p>Dependency bumps, CI and typo fixes are dropped. A fun name, the word coin or a joke README raise the heat.</p>
              </div>
              <div className="art">
                <Heat heat="low" />
                <br />
                <Heat heat="medium" />
                <br />
                <Heat heat="high" />
                <br />
                <Heat heat="veryHigh" />
              </div>
            </div>
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> pushd show
                </span>
                <span className="n">03</span>
              </div>
              <div className="body">
                <h3>Show</h3>
                <p>One plain line, written only from what is in the repo, lands in the feed with the link and the heat.</p>
              </div>
              <div className="art">
                -&gt; holders: <b>live</b>
                <br />
                -&gt; public: {stats.publicDelayMinutes} min later
                <br />
                -&gt; hot ones: catches.log
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="panel holders-teaser">
            <div>
              <div className="eyebrow">holders</div>
              <h2>Hold $PUSHD. Skip the wait.</h2>
              <p>
                The public site runs {stats.publicDelayMinutes} minutes behind. Holders see the feed live, keep their own watchlist
                and get browser alerts. Part of every $PUSHD trade&apos;s fee buys $PUSHD back and burns
                it. Holding is read from the chain; nothing is paid, staked or promised.
              </p>
              <Link className="btn btn-line" href="/holders">
                What holders get <span aria-hidden="true">-&gt;</span>
              </Link>
            </div>
            <div className="diff" aria-label="Public view compared with holder view">
              <div className="dh">diff public.view holders.view</div>
              <div className="db">
                <div className="dl ctx">feed: same items, same summaries</div>
                <div className="dl minus">delay: {stats.publicDelayMinutes} min behind</div>
                <div className="dl plus">delay: none, live</div>
                <div className="dl minus">watchlist: the list</div>
                <div className="dl plus">watchlist: your own picks</div>
                <div className="dl plus">alerts: in your browser</div>
                <div className="dl ctx">sign-in: MetaMask, a signature, read only</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="panel dev-strip">
            <div>
              <div className="eyebrow">for builders</div>
              <h2>Take the feed with you.</h2>
              <p className="muted" style={{ marginTop: 14 }}>
                The public feed as RSS and JSON, and a small widget for any page. Same {stats.publicDelayMinutes} minute delay as
                this site.
              </p>
              <div className="dev-links">
                <a className="btn btn-line" href="/feed.xml">
                  RSS
                </a>
                <a className="btn btn-line" href="/feed.json">
                  JSON feed
                </a>
                <Link className="btn btn-line" href="/how#developers">
                  Embed
                </Link>
              </div>
            </div>
            <pre aria-label="Example">
              <b>$</b> curl {"https://pushd.fun/feed.json"}
              {"\n"}
              {`{ "items": [ { "title": "${feed.items[0] ? `${feed.items[0].handle} ${KIND_VERB[feed.items[0].kind]} ${feed.items[0].repo}` : "toly created dts02-6502-signer"}", ... } ] }`}
              {"\n\n"}
              <b>&lt;iframe</b> src=&quot;https://pushd.fun/embed&quot; width=&quot;380&quot; height=&quot;460&quot;<b>&gt;</b>
            </pre>
          </div>
        </div>
      </section>
    </>
  );
}
