import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/CodeBlock";
import { Prompt } from "@/components/Prompt";
import { RunCard } from "@/components/RunCard";
import { agentsOn, getShipped } from "@/lib/build-server";
import { agoWords, num } from "@/lib/format";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; repo: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, repo } = await params;
  return {
    title: `${owner}/${repo}: shipped with a PUSHD agent`,
    description: `What ${owner}/${repo}'s PUSHD agent shipped: pull requests, commits and releases, each with its link.`,
    alternates: { canonical: `/shipped/${owner}/${repo}` },
  };
}

export default async function ShippedPage({ params }: Params) {
  if (!agentsOn()) notFound();
  const { owner, repo } = await params;
  const p = await getShipped(owner, repo);
  if (!p) notFound();
  const asOf = new Date().toISOString();
  const base = SITE.url.replace(/\/+$/, "");
  const badge = `${base}/shipped/${p.repo}/badge`;
  const page = `${base}/shipped/${p.repo}`;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/shipped" cmd={`pushd shipped ${p.repo}`} />
              <h1>
                {p.repo}
                <span className="acc">.</span>
              </h1>
              <p className="lede">
                What this project&apos;s PUSHD agent shipped, with a link to each pull request, commit and release on GitHub. The owner reviews and
                merges every change.
              </p>
            </div>
            <a className="textlink" href={`https://github.com/${p.repo}`} target="_blank" rel="noopener noreferrer">
              the repo on GitHub -&gt;
            </a>
          </div>
        </div>
      </section>
      <section className="wrap">
        <div className="bd-stats">
          <div className="panel">
            <div className="bd-k">runs</div>
            <div className="v">{num(p.counts.runs)}</div>
          </div>
          <div className="panel">
            <div className="bd-k">pull requests opened</div>
            <div className="v">{num(p.counts.pullRequests)}</div>
          </div>
          <div className="panel">
            <div className="bd-k">commits on agent branches</div>
            <div className="v">{num(p.counts.commits)}</div>
          </div>
          <div className="panel">
            <div className="bd-k">last 30 days</div>
            <div className="v">{num(p.counts.last30d)}</div>
          </div>
        </div>
        {p.since && <p className="small-note">First run {agoWords(new Date(p.since).toISOString(), asOf)}. Counted by PUSHD from each run&apos;s receipt.</p>}
      </section>
      {p.reports.length > 0 && (
        <section className="section" style={{ paddingBottom: 0 }}>
          <div className="wrap">
            <div className="sec-head slim">
              <div>
                <div className="eyebrow">weekly</div>
                <h2>What shipped, week by week.</h2>
              </div>
            </div>
            <div className="bd-runs">
              {p.reports.map((r) => (
                <div key={r.at} className="panel bd-run">
                  <div className="bd-k">{new Date(r.at).toISOString().slice(0, 10)}</div>
                  <pre className="bd-pre">{r.text}</pre>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="section">
        <div className="wrap bd-grid">
          <div className="bd-runs">
            {p.runs.map((r) => (
              <RunCard key={r.id} run={r} asOf={asOf} receipt={false} />
            ))}
          </div>
          <aside className="bd-side">
            <div className="panel bd-badge">
              <div className="bd-k">badge for your README or site</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/shipped/${p.repo}/badge`} alt="Shipped with a PUSHD agent" />
              <CodeBlock title="Markdown" code={`[![Shipped with a PUSHD agent](${badge})](${page})`} />
              <CodeBlock title="HTML" code={`<a href="${page}"><img src="${badge}" alt="Shipped with a PUSHD agent"></a>`} />
            </div>
            <div className="panel bd-pad">
              <h3>Your own agent</h3>
              <p className="muted" style={{ marginTop: 8 }}>
                Release notes, a post about what shipped, a key check on each push, pull requests on request.
              </p>
              <Link className="btn btn-acc" href="/build" style={{ marginTop: 14 }}>
                Build one -&gt;
              </Link>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
