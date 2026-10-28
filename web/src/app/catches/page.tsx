import type { Metadata } from "next";
import Link from "next/link";
import { Heat } from "@/components/Heat";
import { repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { getCatches } from "@/lib/data";
import { after, builderHref, utcDate, utcTime } from "@/lib/format";
import { GROUPS, HEAT_CLASS, KIND_LABEL } from "@/lib/groups";

const fmtLag = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

/** What the "after the ..." time counts from. */
const SINCE = { repo: "repo was made", push: "push", release: "release", gist: "gist" } as const;

export const metadata: Metadata = {
  title: "PUSHD Catches",
  description: "The catches log: hot items and the time PUSHD showed them.",
  alternates: { canonical: "/catches" },
};

export default async function CatchesPage() {
  const feed = await getCatches();
  const catches = feed.items;
  const vhigh = catches.filter((it) => it.heat === "veryHigh").length;
  const timed = catches.filter((it) => it.shownAt && !it.backfill).map((it) => Date.parse(it.shownAt!) - Date.parse(it.githubAt)).sort((a, b) => a - b);
  const median = timed.length ? timed[Math.floor(timed.length / 2)] : null;
  const days: [string, typeof catches][] = [];
  for (const it of catches) {
    const d = utcDate(it.shownAt ?? it.githubAt);
    const last = days[days.length - 1];
    if (last && last[0] === d) last[1].push(it);
    else days.push([d, [it]]);
  }

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/catches" cmd="cat catches.log" />
              <h1>
                Catches<span className="acc">.</span>
              </h1>
              <p className="lede">
                The hot items, and the exact time PUSHD showed them. A catch is a time stamp. No prices, no buy links, no charts.
              </p>
            </div>
            {feed.source === "sample" && <span className="tag sample">Sample data</span>}
            {feed.source === "offline" && <span className="tag">watcher offline</span>}
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="cstats4">
          <div className="panel">
            <div className="k">catches logged</div>
            <div className="v">{catches.length}</div>
            <p>Kept for good. The log refuses edits.</p>
          </div>
          <div className="panel">
            <div className="k">very high heat</div>
            <div className="v" style={{ color: "var(--heat-vhigh)" }}>
              {vhigh}
            </div>
            <p>Fun names, jokes, coin words.</p>
          </div>
          <div className="panel">
            <div className="k">high heat</div>
            <div className="v" style={{ color: "var(--heat-high)" }}>
              {catches.length - vhigh}
            </div>
            <p>New, short and catchy.</p>
          </div>
          <div className="panel">
            <div className="k">median time to show</div>
            <div className="v">{median != null ? fmtLag(median) : "n/a"}</div>
            <p>{median != null ? `From GitHub to PUSHD, over ${timed.length} timed catch${timed.length === 1 ? "" : "es"}.` : "Shown once catches are timed live (first looks at an account do not count)."}</p>
          </div>
        </div>

        {catches.length ? (
          <div className="ctl" aria-label="Catches, newest first">
            {days.map(([day, list]) => (
              <div key={day}>
                <div className="ctl-day">{day}</div>
                {list.map((it) => {
                  const lag = it.shownAt && !it.backfill ? Date.parse(it.shownAt) - Date.parse(it.githubAt) : null;
                  return (
                    <div key={it.id} className={`ctl-row h-${HEAT_CLASS[it.heat]}`}>
                      <div className="ctl-time">
                        {it.shownAt ? (
                          <>
                            <b>{utcTime(it.shownAt)}</b>
                            <small>shown, UTC</small>
                          </>
                        ) : (
                          <>
                            <b className="pending">pending</b>
                            <small>replay</small>
                          </>
                        )}
                      </div>
                      <div className="ctl-node">
                        <i aria-hidden="true"></i>
                      </div>
                      <article className="ctl-card">
                        <span className="cw">
                          <Link className="who-link" href={builderHref(it.handle)}>
                            {it.handle}
                          </Link>{" "}
                          <span className="sl">/</span>{" "}
                          <Link className="r" href={`/feed/${it.id}`} style={{ textDecoration: "none" }}>
                            {repoName(it)}
                          </Link>
                        </span>
                        <Heat heat={it.heat} />
                        <p>{it.summary}</p>
                        <div className="cmeta">
                          <span className="kind">{KIND_LABEL[it.kind]}</span>
                          <span>{GROUPS[it.group].label}</span>
                          {lag != null ? (
                            <span className="lag" title="from the moment on GitHub to the moment PUSHD showed it">
                              <i style={{ width: `${Math.min(120, Math.max(4, Math.round(Math.sqrt(lag / 1000) * 3)))}px` }} />
                              {after(it.githubAt, it.shownAt!)} after the {SINCE[it.kind]}
                            </span>
                          ) : (
                            <span>{it.shownAt ? "seen on the first look at this account" : `${utcDate(it.githubAt)}, measured before launch`}</span>
                          )}
                          {it.sample && <span className="tag sample">Sample</span>}
                          <Link href={`/feed/${it.id}`}>details -&gt;</Link>
                        </div>
                      </article>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="estate">
            <b>No catches yet.</b>
            <span>The first high heat line lands here with the exact time PUSHD showed it.</span>
          </div>
        )}

        <div className="notbox">
          <div className="panel">
            <h3>What a catch is</h3>
            <p>A line in a public log. It cannot be edited after the fact.</p>
            <ul className="xlist ok">
              <li>the time PUSHD showed it</li>
              <li>who pushed and what</li>
              <li>the heat at that moment</li>
              <li>the link to the source</li>
            </ul>
          </div>
          <div className="panel">
            <h3>What a catch is not</h3>
            <p>PUSHD shows public activity. It does not tell anyone what to do with it.</p>
            <ul className="xlist">
              <li>a price or a chart</li>
              <li>a buy link</li>
              <li>a tip or a call</li>
              <li>a promise of anything</li>
            </ul>
          </div>
        </div>

        <div className="panel riskbox" style={{ marginTop: 20 }}>
          <span className="sig">replay</span>
          <div>
            <h3>The 27 Oct replay</h3>
            <p>
              Before launch, toly&apos;s new repo from 27 Oct runs through the watcher. The times it would have shown them go in
              this log when they are measured, not before.
            </p>
          </div>
          <Link className="textlink" href="/how#limits">
            limits -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
