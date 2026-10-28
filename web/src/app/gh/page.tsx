import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Heat } from "@/components/Heat";
import { LookupBox } from "@/components/LookupBox";
import { Prompt } from "@/components/Prompt";
import { lookupAll, visitorIp } from "@/lib/data";
import { agoWords, bare, builderHref, num } from "@/lib/format";
import { GROUPS, KIND_LABEL } from "@/lib/groups";
import { ghRepoHref, ghUserHref, itemHref } from "@/lib/lookup";

export const metadata: Metadata = {
  title: "PUSHD Look up",
  description: "Look up anyone on GitHub: a username, a repo or a few words. The list first, then everything else.",
  alternates: { canonical: "/gh" },
};

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export default async function LookupPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().slice(0, 100) ?? "";
  const { result, offline } = q ? await lookupAll(q, await visitorIp()) : { result: null, offline: false };
  const now = new Date().toISOString();
  const watched = result ? result.watch.builders.length + result.watch.items.length : 0;
  const outside = result ? result.github.users.length + result.github.repos.length : 0;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Prompt path="~/pushd/gh" cmd={q ? `pushd find "${q}"` : "pushd find"} />
          <h1>
            Look up anyone<span className="acc">.</span>
          </h1>
          <p className="lede">A username, a repo as owner/name, or a few words. The watched list come first, then anything public on GitHub.</p>
          <div style={{ marginTop: 28 }}>
            <LookupBox q={q} autoFocus={!q} />
          </div>
        </div>
      </section>

      {result && (
        <section className="wrap lk-res" style={{ paddingTop: 40 }}>
          {result.direct && (
            <Link className="panel lk-direct" href={result.direct.href}>
              <span className="k">{result.direct.kind === "user" ? "open the account" : "open the repo"}</span>
              <b>{result.direct.label}</b>
              <span className="acc">-&gt;</span>
            </Link>
          )}

          <div className="lk-grid">
            <div className="panel">
              <div className="ptitle">
                <h3>Watched</h3>
                <span>{watched ? `${watched} found` : "nothing"}</span>
              </div>
              {watched ? (
                <ul className="lk-list">
                  {result.watch.builders.map((b) => (
                    <li key={`b-${b.handle}`} className={`g-${b.group}`}>
                      <Avatar handle={b.handle} sample={b.sample} size={28} />
                      <Link href={builderHref(b.handle)}>{bare(b.handle)}</Link>
                      <small>
                        <i className="gdot" /> {GROUPS[b.group].short}
                        {b.name && b.name !== bare(b.handle) ? ` . ${b.name}` : ""}
                      </small>
                    </li>
                  ))}
                  {result.watch.items.map((it) => (
                    <li key={`i-${it.id}`}>
                      <Heat heat={it.heat} label={false} />
                      <Link href={itemHref(it)}>
                        {bare(it.handle)} / {it.version ? `${it.repo} ${it.version}` : it.repo}
                      </Link>
                      <small>
                        {KIND_LABEL[it.kind]} . {agoWords(it.githubAt, now)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="estate">
                  <b>Nobody on the list matches.</b>
                  <span>GitHub&apos;s own results are on the right.</span>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="ptitle">
                <h3>On GitHub</h3>
                <span className="tag outside">not on the watchlist</span>
              </div>
              {offline ? (
                <div className="estate">
                  <b>GitHub search is not connected here.</b>
                  <span>It runs through PUSHD&apos;s engine, which is not answering right now.</span>
                </div>
              ) : result.github.busy ? (
                <div className="estate">
                  <b>GitHub is busy, try in a minute.</b>
                  <span>
                    Search has its own small allowance{result.github.retryInSec ? `; there is room again in about ${result.github.retryInSec} s` : ""}. The watched results are on the left.
                  </span>
                </div>
              ) : outside ? (
                <ul className="lk-list">
                  {result.github.users.map((u) => (
                    <li key={`u-${u.login}`}>
                      <Avatar handle={u.login} size={28} />
                      <Link href={ghUserHref(u.login)}>{u.login}</Link>
                      <small>{u.type === "org" ? "org" : "person"}</small>
                    </li>
                  ))}
                  {result.github.repos.map((r) => (
                    <li key={`r-${r.fullName}`} className="lk-repo">
                      <span className="lk-ri" aria-hidden="true">
                        /
                      </span>
                      <Link href={ghRepoHref(r.fullName.split("/")[0], r.fullName.split("/")[1])}>{r.fullName}</Link>
                      <small>
                        {num(r.stars)} stars{r.language ? ` . ${r.language}` : ""}
                        {r.pushedAt ? ` . pushed ${agoWords(r.pushedAt, now)}` : ""}
                      </small>
                      {r.description && <p>{r.description}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="estate">
                  <b>GitHub found nothing for that.</b>
                  <span>Try a username, or owner/name for a repo.</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {!result && (
        <section className="wrap" style={{ paddingTop: 40 }}>
          <div className="wl-note">
            <div className="panel">
              <h3>A username</h3>
              <p>Any person or org on GitHub gets a page built on demand: activity, top repos, languages.</p>
            </div>
            <div className="panel">
              <h3>owner/name</h3>
              <p>Any public repo: stats, README, commits, releases, and a scout who can read it for you.</p>
            </div>
            <div className="panel">
              <h3>A few words</h3>
              <p>
                Lines from the feed, the list, then GitHub&apos;s own search.{" "}
                <Link className="textlink" href="/watchlist">
                  the list -&gt;
                </Link>
              </p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
