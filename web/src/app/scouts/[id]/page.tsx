import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FollowScout } from "@/components/FollowScout";
import { repoName } from "@/components/ItemDetail";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { ModeNote } from "@/components/ScoutMode";
import { ScoutRead } from "@/components/ScoutRead";
import { getScout } from "@/lib/data";
import { agoWords, builderHref } from "@/lib/format";
import { GROUPS, HEAT_CLASS, KIND_LABEL } from "@/lib/groups";
import { callHeat, fmtSecs, NOT_ADVICE, SCOUT_BY_ID, SCOUTS, VERDICT_LABEL } from "@/lib/scouts";
import type { CallRef, ScoutId, Verdict } from "@/lib/types";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const s = SCOUT_BY_ID[id as ScoutId];
  if (!s) return { title: "PUSHD Scouts" };
  return { title: `${s.name}, ${s.title} . PUSHD Scouts`, description: `${s.personality} Its calls and its public record.`, alternates: { canonical: `/scouts/${s.id}` } };
}

function CallCard({ kind, r }: { kind: "best" | "worst"; r: CallRef | null }) {
  return (
    <div className={`panel callref ${kind}`}>
      <div className="k">{kind === "best" ? "best call" : "worst call"}</div>
      {r ? (
        <>
          <Link className="cr-what" href={`/feed/${r.id}`}>
            {r.handle} <span className="sl">/</span> <span className="r">{r.version ? `${r.repo} ${r.version}` : r.repo}</span>
          </Link>
          <div className="cr-nums">
            <span className={`h-${HEAT_CLASS[callHeat(r.heat)]}`}>
              called <b>{r.heat}/10</b>
            </span>
            <span>watcher {r.score}/10</span>
            <span className={r.source === "model" ? "stag model" : "stag tpl"}>{r.source}</span>
          </div>
          <p>{r.note}</p>
        </>
      ) : (
        <p className="muted">{kind === "best" ? "No call on a catch yet." : "No miss yet: no hot call that stayed cold, and no catch it called cold."}</p>
      )}
    </div>
  );
}

const VERDICT_ORDER: Verdict[] = ["tool", "experiment", "fork", "joke", "docs", "unclear"];

export default async function ScoutPage({ params }: Props) {
  const { id } = await params;
  const p = await getScout(id);
  if (!p) notFound();
  const r = p.record;
  const s = SCOUT_BY_ID[r.id];
  const vTotal = VERDICT_ORDER.reduce((n, v) => n + r.verdicts[v], 0);
  const camp = GROUPS[s.camp];
  const others = SCOUTS.filter((x) => x.id !== s.id);

  return (
    <>
      <section className={`page-head scout-head g-${s.camp}`}>
        <div className="wrap">
          <Prompt path="~/pushd/scouts" cmd={`pushd scout ${s.id}`} />
          <div className="sh-grid">
            <ScoutAvatar id={s.id} size={132} className="sh-av" />
            <div className="sh-main">
              <h1>
                {s.name}
                <span className="acc">.</span>
              </h1>
              <div className="sh-camp">
                <span className="tchip">{camp.title}</span>
                <span className="muted">rank {r.rank} of 5</span>
              </div>
              <p className="lede">{s.personality}</p>
              <p className="sh-voice">
                <b>writes</b> {s.voice}
              </p>
            </div>
            <div className="sh-side">
              <blockquote>&quot;{s.motto}&quot;</blockquote>
              <div className="sh-actions">
                <FollowScout id={s.id} />
                <Link className="btn btn-line" href={`/feed?group=${camp.slug}`}>
                  its camp&apos;s feed -&gt;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap">
        <ModeNote v={{ scouts: [r], mode: p.mode, model: p.model, deepModel: p.deepModel, asOf: p.asOf, sample: r.sample }} />
        <div className="srec">
          <div className="panel">
            <div className="k">calls made</div>
            <div className="v">{r.calls}</div>
            <p>
              {r.modelCalls} by a model, {r.templateCalls} template
            </p>
          </div>
          <div className="panel">
            <div className="k">hot calls caught</div>
            <div className="v">{r.hotCalls ? `${r.hotCatches}/${r.hotCalls}` : "0"}</div>
            <p>{r.hitRate == null ? "Model calls at 6 and up only." : `${Math.round(r.hitRate * 100)}% became catches.`}</p>
          </div>
          <div className="panel">
            <div className="k">catches called</div>
            <div className="v">
              {r.catchesCalledHot}/{r.catches}
            </div>
            <p>The camp&apos;s catches it called 6 or more.</p>
          </div>
          <div className="panel">
            <div className="k">push to call</div>
            <div className="v">{fmtSecs(r.medianToCallSec)}</div>
            <p>{r.timedCalls ? `Median over ${r.timedCalls} live calls.` : "Counted on live calls only."}</p>
          </div>
          <div className="panel">
            <div className="k">deep reads</div>
            <div className="v">{r.deepReads}</div>
            <p>Repos it read before calling.</p>
          </div>
          <div className="panel">
            <div className="k">steering seen</div>
            <div className="v">{r.injections}</div>
            <p>Repos that tried to instruct it.</p>
          </div>
        </div>

        <div className="srec-row">
          <CallCard kind="best" r={r.best} />
          <CallCard kind="worst" r={r.worst} />
          <div className="panel vmix">
            <div className="k">what the repos were</div>
            {vTotal ? (
              <ul>
                {VERDICT_ORDER.map((v) => (
                  <li key={v}>
                    <span className={`verdict v-${v}`}>{VERDICT_LABEL[v]}</span>
                    <i>
                      <b style={{ width: `${Math.round((r.verdicts[v] / vTotal) * 100)}%` }} />
                    </i>
                    <em>{r.verdicts[v]}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No new repo or release read yet.</p>
            )}
          </div>
        </div>
        <p className="small-note">{NOT_ADVICE}</p>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">its calls</div>
              <h2>Every call, newest first.</h2>
            </div>
            <p>
              From the public view. Each opens the line with its links. {s.name} watches {camp.label}.
            </p>
          </div>
          {p.calls.length ? (
            <div className="scout-log">
              {p.calls.map((it) => (
                <article key={it.id} className="scout-log-row">
                  <div className="slr-top">
                    <span className="kind">{KIND_LABEL[it.kind]}</span>
                    <span>
                      <Link className="who-link" href={builderHref(it.handle)}>
                        {it.handle}
                      </Link>{" "}
                      <span className="sl">/</span>{" "}
                      <Link className="r" href={`/feed/${it.id}`}>
                        {repoName(it)}
                      </Link>
                    </span>
                    {it.call && (
                      <span className={`slr-heat h-${HEAT_CLASS[callHeat(it.call.heat)]}`}>
                        <b>{it.call.heat}</b>/10
                      </span>
                    )}
                    <span className="muted">{agoWords(it.githubAt, p.asOf)}</span>
                  </div>
                  {it.call && <ScoutRead item={it} call={it.call} compact bare />}
                </article>
              ))}
            </div>
          ) : (
            <div className="estate">
              <b>No calls yet.</b>
              <span>{s.name}&apos;s first call lands here when a line from its camp clears the public delay.</span>
            </div>
          )}
          <p className="small-note">Calls marked late were made when the scouts caught up, after the line was stored; their timing is not counted. {NOT_ADVICE}</p>
        </div>
      </section>

      <section className="wrap">
        <div className="scout-others">
          <span className="k">the other scouts</span>
          {others.map((o) => (
            <Link key={o.id} href={`/scouts/${o.id}`} className={`so g-${o.camp}`}>
              <ScoutAvatar id={o.id} size={30} />
              <span>{o.name}</span>
            </Link>
          ))}
          <Link className="textlink" href="/scouts">
            leaderboard -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
