import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CopyPost } from "@/components/CopyPost";
import { GalleryCard } from "@/components/Gallery";
import { Heat } from "@/components/Heat";
import { GitHubLink, ItemDetail, grpLine, repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { getFeed, getItem, getItemMore, getStats } from "@/lib/data";
import { after, ago, agoWords, builderHref, num, shortDate, utcDate, utcTime } from "@/lib/format";
import { ScoutRead } from "@/components/ScoutRead";
import { TokenBox } from "@/components/TokenBox";
import { KIND_LABEL } from "@/lib/groups";
import { langColor } from "@/lib/langs";
import { itemPost } from "@/lib/profile";
import { SITE } from "@/lib/site";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await getItem((await params).id);
  if (!found) return { title: "PUSHD Feed" };
  const { item } = found;
  return {
    title: `${item.handle} / ${repoName(item)} . PUSHD Feed`,
    description: `${item.summary}${item.sample ? " (Sample line.)" : ""}`,
    alternates: { canonical: `/feed/${item.id}` },
  };
}

const TEXT_TITLE = { readme: "README.md, first lines", notes: "release notes", gist: "the gist" } as const;

export default async function ItemPage({ params }: Props) {
  const found = await getItem((await params).id);
  if (!found) notFound();
  const { item, asOf } = found;
  const [more, feed, stats] = await Promise.all([getItemMore(item), getFeed(), getStats()]);
  const at = feed.items.findIndex((it) => it.id === item.id);
  const newer = at > 0 ? feed.items[at - 1] : null;
  const older = at >= 0 && at < feed.items.length - 1 ? feed.items[at + 1] : null;
  const r = more.repo;

  return (
    <>
      <section className="page-head item-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/feed" cmd={`pushd show ${item.id}`} />
              <h1>
                <Link className="who-link" href={builderHref(item.handle)}>
                  {item.handle}
                </Link>{" "}
                <span className="sl">/</span> <span className="repo">{repoName(item)}</span>
              </h1>
              <p className="lede">{item.summary}</p>
            </div>
            <div className="statusbar">
              <span className="kind">{KIND_LABEL[item.kind]}</span>
              <Heat heat={item.heat} />
              <span>
                <b>{ago(item.githubAt, asOf)}</b> ago
              </span>
              {item.sample && <span className="tag sample">Sample</span>}
              {item.agent && <span className="tag acc">shipped with a PUSHD agent</span>}
            </div>
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="ihero">
          <div className="ileft">
          <div className="iart">
            {/* eslint-disable-next-line @next/next/no-img-element -- the repo's stored preview, or this line's own share picture */}
            <img src={item.mediaUrl ?? `/feed/${item.id}/opengraph-image`} alt={item.mediaUrl ? `GitHub preview of ${item.repo}` : `${item.handle} / ${repoName(item)}, ${item.heat} heat`} width={1200} height={item.mediaUrl ? 600 : 630} />
          </div>
        <div className="timing" style={{ marginTop: 0 }}>
          <div>
            <div className="k">on GitHub</div>
            <div className="v">{utcTime(item.githubAt)} UTC</div>
            <small>{utcDate(item.githubAt)}</small>
          </div>
          <div>
            <div className="k">shown by PUSHD</div>
            <div className="v" style={{ color: "var(--accent)" }}>
              {item.shownAt ? `${utcTime(item.shownAt)} UTC` : "replay pending"}
            </div>
            <small>
              {item.shownAt
                ? item.backfill
                  ? "seen on the first look at this account, after it happened"
                  : `${after(item.githubAt, item.shownAt)} after it happened. Holders saw it then.`
                : "measured before launch"}
            </small>
          </div>
          <div>
            <div className="k">public view</div>
            <div className="v">{item.shownAt ? `${utcTime(new Date(Date.parse(item.shownAt) + stats.publicDelayMinutes * 60_000).toISOString())} UTC` : "after the replay"}</div>
            <small>{stats.publicDelayMinutes} minutes after holders</small>
          </div>
        </div>

          </div>
          <div className="panel ifacts brk">
            <div className="ptitle" style={{ marginBottom: 0 }}>
              <h3>{r ? r.fullName : "The repo"}</h3>
              {r?.archived && <span className="tag">archived</span>}
            </div>
            {r ? (
              <>
                {r.description && <p className="desc">{r.description}</p>}
                <div className="nums">
                  <div>
                    <div className="k">stars</div>
                    <div className="v">{num(r.stars)}</div>
                  </div>
                  <div>
                    <div className="k">forks</div>
                    <div className="v">{num(r.forks)}</div>
                  </div>
                  <div>
                    <div className="k">language</div>
                    <div className="v" style={{ fontSize: 16, paddingTop: 4 }}>
                      {r.language ? (
                        <span className="lang" style={{ "--lc": langColor(r.language) } as CSSProperties}>
                          {r.language}
                        </span>
                      ) : (
                        "none"
                      )}
                    </div>
                  </div>
                </div>
                {r.topics.length > 0 && (
                  <div className="chipline">
                    {r.topics.slice(0, 8).map((t) => (
                      <span key={t} className="tchip">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <dl className="kv2" style={{ margin: 0 }}>
                  <div>
                    <dt>created</dt>
                    <dd>{utcDate(r.createdAt)}</dd>
                  </div>
                  {r.pushedAt && (
                    <div>
                      <dt>last push</dt>
                      <dd>{utcDate(r.pushedAt)}</dd>
                    </div>
                  )}
                  {r.license && (
                    <div>
                      <dt>license</dt>
                      <dd>{r.license}</dd>
                    </div>
                  )}
                  {r.openIssues != null && (
                    <div>
                      <dt>open issues and PRs</dt>
                      <dd>{num(r.openIssues)}</dd>
                    </div>
                  )}
                </dl>
                <p className="readat">numbers as GitHub showed them {r.readAt ? `on ${shortDate(r.readAt)} at ${utcTime(r.readAt)} UTC` : "when read"}</p>
              </>
            ) : (
              <div className="estate" style={{ flex: 1 }}>
                <b>{item.sample ? "A sample line has no repo to read." : item.kind === "gist" ? "A gist has no repo numbers." : "Not read yet."}</b>
                <span>
                  {more.pending.includes("repo facts")
                    ? "Asking GitHub now. Look again in a minute."
                    : item.sample || item.kind === "gist"
                      ? "Stars, forks and the language show here for real repos."
                      : "PUSHD reads repos slowly to stay inside GitHub's limits. It will be here soon."}
                </span>
              </div>
            )}
            <div className="share">
              <GitHubLink item={item} />
              <CopyButton text={`${SITE.url}/feed/${item.id}`} label="copy link" />
            </div>
          </div>
        </div>

        {item.call && (
          <div className="panel scout-panel">
            <div className="ptitle">
              <h3>The scout&apos;s read</h3>
              <span>called {agoWords(item.call.calledAt, asOf)}</span>
            </div>
            <ScoutRead item={item} call={item.call} />
          </div>
        )}

        {item.token && <TokenBox token={item.token} project={item.name ?? null} />}

        <div className="bgrid2" style={{ alignItems: "start" }}>
          <div className="panel item-page" style={{ padding: 0, overflow: "hidden", marginTop: 0 }}>
            <ItemDetail
              item={item}
              asOf={asOf}
              scout={false}
              links={
                <>
                  <GitHubLink item={item} />
                  <Link href={`/feed#${item.id}`}>In the feed</Link>
                  <Link href={builderHref(item.handle)}>All of {item.handle}</Link>
                </>
              }
            />
          </div>
          {more.text ? (
            <div className="term readme-wrap">
              <div className="term-bar">
                <div className="tabs">
                  <span className="tab on">{TEXT_TITLE[more.text.kind]}</span>
                </div>
                <div className="right">
                  <span>read {shortDate(more.text.readAt)}</span>
                </div>
              </div>
              <pre className="readme">{more.text.body}</pre>
            </div>
          ) : (
            <div className="panel">
              <div className="ptitle">
                <h3>{item.kind === "release" ? "Release notes" : item.kind === "gist" ? "The gist" : "README"}</h3>
              </div>
              <div className="estate" style={{ flex: 1 }}>
                <b>{more.pending.length ? "Fetching from GitHub." : item.sample ? "Sample line." : "Nothing stored."}</b>
                <span>{more.pending.length ? "Look again in a minute." : item.sample ? "Real lines show the README's first lines here." : "The repo may have no README, or it was not read yet."}</span>
              </div>
            </div>
          )}
        </div>

        {(more.commits?.length || more.change) && (
          <div className="bgrid2">
            <div className="panel">
              <div className="ptitle">
                <h3>Latest commits as of this push</h3>
                {more.change && (
                  <span>
                    <span className="acc">+{num(more.change.additions)}</span> <span style={{ color: "var(--heat-vhigh)" }}>-{num(more.change.deletions)}</span> . {more.change.files} files in the head commit
                  </span>
                )}
              </div>
              {more.commits?.length ? (
                <ul className="commits">
                  {more.commits.map((c) => (
                    <li key={c.sha}>
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.sha.slice(0, 7)}
                      </a>
                      <span>
                        <span className="m">{c.message}</span>
                        <small>
                          {c.author ?? "unknown"}
                          {c.at ? ` . ${utcDate(c.at)} ${utcTime(c.at)} UTC` : ""}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="estate">
                  <b>{more.pending.includes("commits") ? "Fetching the commits." : "Commits not read."}</b>
                  <span>Without a GitHub token PUSHD asks for them sparingly.</span>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="ptitle">
                <h3>What changed</h3>
              </div>
              {more.change ? (
                <div className="mix">
                  {[
                    ["added", more.change.additions, "var(--accent)"],
                    ["removed", more.change.deletions, "var(--heat-vhigh)"],
                  ].map(([k, v, c]) => (
                    <div key={k as string} className="mix-row">
                      <span>{k as string}</span>
                      <span className="bar">
                        <i style={{ width: `${Math.round(((v as number) / Math.max(1, more.change!.additions, more.change!.deletions)) * 100)}%`, background: c as string }} />
                      </span>
                      <b>{num(v as number)}</b>
                    </div>
                  ))}
                  <p className="footnote">Lines in the head commit, as GitHub counted them.</p>
                </div>
              ) : (
                <div className="estate">
                  <b>No size read.</b>
                  <span>The head commit was not read for this push.</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="panel share-card" style={{ marginTop: 20 }}>
          <div>
            <div className="eyebrow">share</div>
            <h3 style={{ fontSize: 26, marginBottom: 10 }}>Pass it on.</h3>
            <p className="muted">
              Every line has its own link and its own share picture, so a post shows the card above. The text is plain: no price, no buy
              link, just what happened.
            </p>
            <div className="share" style={{ marginTop: 18 }}>
              <CopyButton text={`${SITE.url}/feed/${item.id}`} label="copy link" />
              <a className="textlink" href={`/feed/${item.id}/opengraph-image`} target="_blank" rel="noopener noreferrer">
                open the picture -&gt;
              </a>
            </div>
          </div>
          <div>
            <CopyPost text={itemPost(item)} />
          </div>
        </div>

        {more.related.length > 0 && (
          <div style={{ marginTop: 56 }}>
            <div className="sec-head" style={{ marginBottom: 22 }}>
              <div>
                <div className="eyebrow">more from {item.handle}</div>
                <h2 style={{ fontSize: "clamp(26px, 2.6vw, 34px)" }}>Their other lines.</h2>
              </div>
              <Link className="textlink" href={builderHref(item.handle)}>
                {item.handle}&apos;s page -&gt;
              </Link>
            </div>
            <div className={`relcards n${more.related.length}`}>
              {more.related.map((it) => (
                <GalleryCard key={it.id} item={it} asOf={asOf} />
              ))}
            </div>
          </div>
        )}

        {(newer || older) && (
          <nav className="inav" aria-label="Next and previous lines">
            {older ? (
              <Link href={`/feed/${older.id}`}>
                <small>&lt;- older</small>
                <b>
                  {older.handle} / {repoName(older)}
                </b>
              </Link>
            ) : (
              <span />
            )}
            {newer ? (
              <Link className="next" href={`/feed/${newer.id}`}>
                <small>newer -&gt;</small>
                <b>
                  {newer.handle} / {repoName(newer)}
                </b>
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}

        <div className="item-nav">
          <Link className="textlink" href="/feed">
            &lt;- back to the feed
          </Link>
          <span className="mono muted" style={{ fontSize: 12.5 }}>
            {grpLine(item)}
          </span>
          <Link className="textlink" href="/holders">
            holders see this live -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
