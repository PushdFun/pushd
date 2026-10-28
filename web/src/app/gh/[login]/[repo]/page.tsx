import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cache, type CSSProperties } from "react";
import { GhState } from "@/components/GhState";
import { Prompt } from "@/components/Prompt";
import { ReadButton } from "@/components/ReadButton";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { getGhRepo } from "@/lib/data";
import { ago, agoWords, builderHref, num, shortDate } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { langColor } from "@/lib/langs";
import { ghUserHref } from "@/lib/lookup";
import { NOT_ADVICE, SCOUT_BY_ID } from "@/lib/scouts";

type Props = { params: Promise<{ login: string; repo: string }> };

const load = cache(async (owner: string, repo: string) => getGhRepo(decodeURIComponent(owner), decodeURIComponent(repo)));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { login, repo } = await params;
  const l = await load(login, repo);
  if (l.state !== "ok") return { title: "PUSHD Lookup", robots: { index: false } };
  const r = l.page.repo;
  return {
    title: `${r.fullName} . PUSHD`,
    description: r.description ?? `${r.fullName} on GitHub, as PUSHD read it: stats, README, commits, releases.`,
    alternates: { canonical: `/gh/${r.fullName}` },
  };
}

export default async function GhRepoPage({ params }: Props) {
  const { login, repo } = await params;
  const l = await load(login, repo);
  if (l.state === "redirect") redirect(l.to);
  if (l.state !== "ok") return <GhState load={l} path="~/pushd/gh" cmd={`pushd read ${decodeURIComponent(login)}/${decodeURIComponent(repo)}`} />;
  const p = l.page;
  const r = p.repo;
  const [owner, name] = r.fullName.split("/");
  const s = SCOUT_BY_ID[p.scout];
  const now = new Date().toISOString();
  const ownerHref = p.owner.onWatchlist || p.owner.inTop ? builderHref(owner) : ghUserHref(owner);

  return (
    <>
      <section className={`page-head rhead${p.owner.group ? ` g-${p.owner.group}` : ""}`}>
        <div className="wrap">
          <Prompt path="~/pushd/gh" cmd={`pushd read ${r.fullName}`}>
            {p.owner.inTop ? <span className="tag acc">on the list</span> : <span className="tag outside">not on the watchlist</span>}
          </Prompt>
          <h1 className="rh1">
            <Link href={ownerHref} className="rh-owner">
              {owner}
            </Link>
            <span className="sl">/</span>
            <span className="rh-name">{name}</span>
          </h1>
          <p className="lede">{r.description ?? "No description."}</p>
          <div className="rtags">
            {r.language && (
              <span className="tag lang" style={{ "--lc": langColor(r.language) } as CSSProperties}>
                {r.language}
              </span>
            )}
            {r.license && <span className="tag">{r.license}</span>}
            {r.fork && <span className="tag">fork{r.parent ? ` of ${r.parent}` : ""}</span>}
            {r.archived && <span className="tag sample">archived</span>}
            {p.owner.group && (
              <span className="tag">
                <i className="gdot" /> {GROUPS[p.owner.group].mid}
              </span>
            )}
            {r.topics.slice(0, 6).map((t) => (
              <span key={t} className="tag topic">
                {t}
              </span>
            ))}
          </div>
          <div className="bstats rstats">
            <div>
              <div className="k">stars</div>
              <div className="v">{num(r.stars)}</div>
            </div>
            <div>
              <div className="k">forks</div>
              <div className="v">{num(r.forks)}</div>
            </div>
            <div>
              <div className="k">watchers</div>
              <div className="v">{r.watchers != null ? num(r.watchers) : "?"}</div>
            </div>
            <div>
              <div className="k">open issues</div>
              <div className="v">{r.openIssues != null ? num(r.openIssues) : "?"}</div>
            </div>
            <div>
              <div className="k">created</div>
              <div className="v sm">{shortDate(r.createdAt)} {new Date(r.createdAt).getUTCFullYear()}</div>
            </div>
            <div>
              <div className="k">last push</div>
              <div className="v sm">{r.pushedAt ? agoWords(r.pushedAt, now) : "never"}</div>
            </div>
          </div>
          <div className="rbtns">
            <a className="btn btn-line" href={r.url} target="_blank" rel="noopener noreferrer">
              GitHub -&gt;
            </a>
            {r.homepage && (
              <a className="btn btn-line" href={r.homepage} target="_blank" rel="noopener noreferrer nofollow">
                Site -&gt;
              </a>
            )}
            <span className={p.stale ? "readnote stale" : "readnote"}>
              Read from GitHub {agoWords(p.readAt, now)}
              {p.stale ? ". GitHub was busy, so this is the last good read." : "."}
            </span>
          </div>
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 48 }}>
        <div className="rgrid">
          <div className="panel">
            <div className="ptitle">
              <h3>README</h3>
              <span>the first lines</span>
            </div>
            {p.readme ? (
              <div className="readme">{p.readme}</div>
            ) : (
              <div className="estate">
                <b>No README read.</b>
                <span>This repo has no README, or it could not be read just now.</span>
              </div>
            )}
          </div>
          <div className={`panel askscout g-${s.camp}`}>
            <div className="ptitle">
              <h3>Ask a scout</h3>
              <span>a deep read</span>
            </div>
            <div className="as-who">
              <ScoutAvatar id={p.scout} size={52} />
              <div>
                <b>{s.name}</b>
                <small>
                  {s.maker} . {s.deepModelName} for the deep read
                </small>
                <p className="muted">{p.scoutWhy}</p>
              </div>
            </div>
            <ReadButton repo={r.fullName} scout={p.scout} allowance={p.allowance} initial={p.read} />
            <p className="small-note">{NOT_ADVICE}</p>
          </div>
        </div>

        <div className="bgrid2" style={{ marginTop: 24 }}>
          <div className="panel">
            <div className="ptitle">
              <h3>Recent commits</h3>
              <span>default branch</span>
            </div>
            {p.commits.length ? (
              <ul className="alog">
                {p.commits.slice(0, 10).map((c) => (
                  <li key={c.sha}>
                    <span className="t">{c.at ? ago(c.at, now) : ""}</span>
                    <span className="x">
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.message}
                      </a>
                      {c.author && <small className="muted"> . {c.author}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="estate">
                <b>No commits read.</b>
                <span>An empty repo, or GitHub did not list them just now.</span>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptitle">
              <h3>Releases</h3>
              <span>newest first</span>
            </div>
            {p.releases.length ? (
              <ul className="alog">
                {p.releases.slice(0, 8).map((x) => (
                  <li key={x.tag}>
                    <span className="t">{x.at ? ago(x.at, now) : ""}</span>
                    <span className="x">
                      <a href={x.url} target="_blank" rel="noopener noreferrer">
                        {x.tag}
                      </a>
                      {x.name && x.name !== x.tag && <span className="muted"> {x.name}</span>}
                      {x.prerelease && <span className="kind" style={{ marginLeft: 8 }}>pre</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="estate">
                <b>No releases.</b>
                <span>This repo has not published a release on GitHub.</span>
              </div>
            )}
          </div>
        </div>

        <div className="item-nav">
          <Link className="textlink" href={ownerHref}>
            &lt;- {owner}
          </Link>
          <Link className="textlink" href="/gh">
            look up something else -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
