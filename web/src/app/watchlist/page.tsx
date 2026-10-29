import type { Metadata } from "next";
import Link from "next/link";
import { LookupBox } from "@/components/LookupBox";
import { Prompt } from "@/components/Prompt";
import { RulesPanel, SchedulePanel } from "@/components/SchedulePanel";
import { SuggestForm } from "@/components/SuggestForm";
import { TopTable } from "@/components/TopTable";
import { WatchTable } from "@/components/WatchTable";
import { getBuilders, getPulse, getTop } from "@/lib/data";
import { agoWords, bare, builderHref, num, reasonText } from "@/lib/format";
import { GROUPS, GROUP_ORDER } from "@/lib/groups";
import type { RankChange } from "@/lib/types";

export const metadata: Metadata = {
  title: "PUSHD: the list",
  description: "Every crypto project with a live token and a GitHub that keeps shipping, ranked every hour by activity.",
  alternates: { canonical: "/watchlist" },
};

function Changes({ list, asOf, empty }: { list: RankChange[]; asOf: string; empty: string }) {
  if (!list.length)
    return (
      <div className="estate">
        <b>None yet.</b>
        <span>{empty}</span>
      </div>
    );
  return (
    <ul className="chg">
      {list.slice(0, 8).map((c) => (
        <li key={`${c.handle}-${c.at}`} className={`g-${c.group}`}>
          <span className={`mv mv-${c.change === "enter" ? "new" : "down"}`}>{c.change === "enter" ? "in" : "out"}</span>
          <span className="chg-who">
            {c.handle.startsWith("@") ? <b>{bare(c.handle)}</b> : <Link href={builderHref(c.handle)}>{bare(c.handle)}</Link>}
            <small>
              <i className="gdot" /> {GROUPS[c.group].short} . #{c.rank} . {agoWords(c.at, asOf)}
            </small>
          </span>
          <span className="chg-why">{reasonText(c.reason)}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function WatchlistPage() {
  const [top, { builders, source }, pulse] = await Promise.all([getTop(), getBuilders(), getPulse()]);
  const asOf = top?.asOf ?? new Date().toISOString();
  const size = top?.rows.length ?? 0;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd" cmd="pushd list --live">
                {top?.sample && <span className="tag sample">Sample</span>}
              </Prompt>
              <h1>
                {top ? `${num(size)} projects` : "The list"}
                <span className="acc">.</span>
              </h1>
              <p className="lede">
                {top
                  ? `Every crypto project PUSHD finds with a live token, a real market and code pushed in the last 30 days: ${num(size)} right now. Ranked every hour by public activity. A project joins as soon as it passes and leaves when it stops.`
                  : "Every crypto project PUSHD finds with a live token, a real market and code pushed in the last 30 days, ranked every hour by public activity."}
              </p>
            </div>
            {top && (
              <div className="panel ls" aria-label="Places by camp">
                <div className="ls-row" style={{ color: "var(--dim)" }}>
                  <span>projects</span>
                  <span className="c">{size}</span>
                  <span>{top.lastPass ? `ranked ${agoWords(top.lastPass, asOf)}` : "not ranked yet"}</span>
                </div>
                {GROUP_ORDER.map((g) => (
                  <div key={g} className="ls-row">
                    <span className="d">{GROUPS[g].slug}/</span>
                    <span className="c">{top.byCamp[g] ?? 0}</span>
                    <span className="x">{GROUPS[g].short}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="top-lookup">
            <LookupBox compact />
            <span className="muted">Anything public on GitHub can be looked up. The projects on the list are simply watched first.</span>
          </div>
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 40 }}>
        {top ? (
          <TopTable rows={top.rows} />
        ) : (
          <div className="estate">
            <b>The ranking is not answering right now.</b>
            <span>The list and its numbers come back the moment it does.</span>
          </div>
        )}
      </section>

      {top && (
        <section className="section" style={{ paddingTop: 72 }} id="changes">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">rotation</div>
                <h2>Who came in, who left.</h2>
                <p>Every project that joins or leaves is logged with its reason.</p>
              </div>
            </div>
            <div className="top-moves">
              <div className="panel">
                <div className="ptitle">
                  <h3>Recently entered</h3>
                  <span>{top.entered.length}</span>
                </div>
                <Changes list={top.entered} asOf={asOf} empty="New projects show here as they pass." />
              </div>
              <div className="panel">
                <div className="ptitle">
                  <h3>Recently dropped out</h3>
                  <span>{top.dropped.length}</span>
                </div>
                <Changes list={top.dropped} asOf={asOf} empty="Nobody has left yet. A project leaves when it no longer passes." />
              </div>
            </div>
          </div>
        </section>
      )}

      {top && (
        <section className="section" id="plan">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">the ranking</div>
                <h2>Ranked by activity, read within budget.</h2>
                <p>
                  The score adds up public activity from the last day, week and month: commits, contributors, issues and pull requests,
                  releases, new repos, stars and forks, with a small weight for followers and PUSHD&apos;s own signals.
                  {top.lastDeepPass ? ` A pass every hour; the last deep pass was ${agoWords(top.lastDeepPass, asOf)}.` : " A pass every hour, and a deeper pass once a day."}
                </p>
              </div>
            </div>
            <div className="top-plan">
              <RulesPanel rules={top.rules} weights={top.weights} />
              <SchedulePanel plan={top.schedule} sample={top.sample} />
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="wrap">
          <div className="sec-head" style={{ marginBottom: 0 }} id="everyone">
            <div>
              <div className="eyebrow">live numbers</div>
              <h2>The list as the watcher reads them.</h2>
              <p>Sort by who is busiest, who was last seen, or who has the most lines. Tick two or three to compare them.</p>
            </div>
            {source === "sample" && <span className="tag sample">Sample</span>}
          </div>
          {builders.length ? (
            <WatchTable builders={builders} asOf={pulse?.asOf ?? asOf} />
          ) : (
            <div className="estate" style={{ marginTop: 24 }}>
              <b>The watcher is not answering right now.</b>
              <span>The list and its numbers come back the moment it does.</span>
            </div>
          )}
        </div>
      </section>

      <section className="section" id="suggest">
        <div className="wrap top-suggest">
          <div className="panel">
            <div className="ptitle">
              <h3>Suggest a project</h3>
              <span>the owner reads every one</span>
            </div>
            <p className="muted" style={{ marginBottom: 18 }}>
              Missing someone who ships in the open? Name them. A suggestion counts a little in the ranking; nothing is added to the list by itself.
            </p>
            <SuggestForm />
          </div>
          <div className="wl-note stack">
            <div className="panel">
              <h3>Ranked, not picked</h3>
              <p>The list ranks itself from public activity every hour. Bots, forks, mirrors and tutorial farms are filtered out first.</p>
            </div>
            <div className="panel">
              <h3>Public only</h3>
              <p>PUSHD reads public GitHub activity. Private repos stay private; it cannot see them.</p>
            </div>
            <div className="panel">
              <h3>Holders add their own</h3>
              <p>
                Holders can watch any account on top of the list, read less often than the list itself.{" "}
                <Link className="textlink" href="/holders">
                  holders -&gt;
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
