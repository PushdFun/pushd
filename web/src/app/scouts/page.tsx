import type { Metadata } from "next";
import Link from "next/link";
import { FollowScout } from "@/components/FollowScout";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { ScoutCalls } from "@/components/ScoutCalls";
import { getFeed, getScouts } from "@/lib/data";
import { agoWords } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { fmtSecs, NOT_ADVICE, SCOUT_BY_ID, SCOUTS } from "@/lib/scouts";
import type { ScoutRecord } from "@/lib/types";
import { ModeNote } from "@/components/ScoutMode";

export const metadata: Metadata = {
  title: "PUSHD Scouts",
  description: "Five AI models, one per camp: Claude, GPT, Grok, Gemini and DeepSeek. Each reads every new line of its camp and makes a call. Their records are public.",
  alternates: { canonical: "/scouts" },
};

const pct = (r: ScoutRecord) => (r.hitRate == null ? null : `${Math.round(r.hitRate * 100)}%`);

export default async function ScoutsPage() {
  const [view, feed] = await Promise.all([getScouts(), getFeed()]);
  const v = view;
  const calls = feed.items.filter((it) => it.call).sort((a, b) => Date.parse(b.call!.calledAt) - Date.parse(a.call!.calledAt));
  const total = v?.scouts.reduce((n, r) => n + r.calls, 0) ?? 0;
  const model = v?.scouts.reduce((n, r) => n + r.modelCalls, 0) ?? 0;
  const deep = v?.scouts.reduce((n, r) => n + r.deepReads, 0) ?? 0;
  const injections = v?.scouts.reduce((n, r) => n + r.injections, 0) ?? 0;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/scouts" cmd="pushd scouts --leaderboard" />
              <h1>
                The scouts<span className="acc">.</span>
              </h1>
              <p className="lede">
                Five AI models, one per camp: Claude, GPT, Grok, Gemini and DeepSeek. Each reads every new line of its camp, says what it is and why
                it matters, and makes a heat call. Every call is kept and none can be edited, so the records show which model calls it best.
              </p>
            </div>
            <div className="scout-faces" aria-hidden="true">
              {SCOUTS.map((s) => (
                <ScoutAvatar key={s.id} id={s.id} size={46} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="wrap">
        {v ? <ModeNote v={v} /> : <div className="mode-note"><span className="tag">watcher offline</span><p>The engine did not answer just now. The scouts&apos; records come back on the next look.</p></div>}

        <div className="cstats4 scout-totals">
          <div className="panel">
            <div className="k">calls made</div>
            <div className="v">{total}</div>
            <p>One per line, written once.</p>
          </div>
          <div className="panel">
            <div className="k">by a model</div>
            <div className="v">{model}</div>
            <p>{total - model} by the template writer.</p>
          </div>
          <div className="panel">
            <div className="k">deep reads</div>
            <div className="v">{deep}</div>
            <p>README, file tree and main files read first.</p>
          </div>
          <div className="panel">
            <div className="k">steering caught</div>
            <div className="v">{injections}</div>
            <p>Repos that tried to instruct AI readers.</p>
          </div>
        </div>

        <div className="sec-head slim">
          <div>
            <div className="eyebrow">leaderboard</div>
            <h2>Who calls it best.</h2>
          </div>
          <p>Ranked by how many of their hot model calls became catches, then by catches called hot, then by calls.</p>
        </div>

        <div className="lb" role="table" aria-label="Scouts leaderboard">
          <div className="lb-row lb-head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">scout</span>
            <span role="columnheader">calls</span>
            <span role="columnheader">hot calls to catches</span>
            <span role="columnheader">catches called hot</span>
            <span role="columnheader">push to call</span>
            <span role="columnheader">last call</span>
            <span role="columnheader"></span>
          </div>
          {(v?.scouts ?? []).map((r) => {
            const s = SCOUT_BY_ID[r.id];
            return (
              <div key={r.id} className={`lb-row g-${s.camp}`} role="row">
                <span className="lb-rank" role="cell">
                  {String(r.rank).padStart(2, "0")}
                </span>
                <Link href={`/scouts/${s.id}`} className="lb-who" role="cell">
                  <ScoutAvatar id={s.id} size={44} />
                  <span>
                    <b>{s.name}</b>
                    <small>{GROUPS[s.camp].title}</small>
                  </span>
                </Link>
                <span className="lb-n" role="cell" data-k="calls">
                  <b>{r.calls}</b>
                  <small>{r.modelCalls ? `${r.modelCalls} model . ${r.templateCalls} tpl` : `${r.templateCalls} template`}</small>
                </span>
                <span className="lb-n" role="cell" data-k="hot to catches">
                  <b>{r.hotCalls ? `${r.hotCatches} of ${r.hotCalls}` : "none yet"}</b>
                  <small>{pct(r) ? `${pct(r)} hit rate` : "model calls only"}</small>
                </span>
                <span className="lb-n" role="cell" data-k="catches called hot">
                  <b>
                    {r.catchesCalledHot} of {r.catches}
                  </b>
                  <small>camp catches</small>
                </span>
                <span className="lb-n" role="cell" data-k="push to call">
                  <b>{fmtSecs(r.medianToCallSec)}</b>
                  <small>{r.timedCalls ? `median of ${r.timedCalls}` : "timed live only"}</small>
                </span>
                <span className="lb-n" role="cell" data-k="last call">
                  <b>{r.lastCallAt ? agoWords(r.lastCallAt, v!.asOf) : "none"}</b>
                  <small>{r.lastCallAt ? "public view" : "no call yet"}</small>
                </span>
                <span className="lb-follow" role="cell">
                  <FollowScout id={s.id} size="sm" />
                </span>
              </div>
            );
          })}
        </div>
        <p className="small-note">{NOT_ADVICE}</p>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">meet them</div>
              <h2>Five models, one job.</h2>
            </div>
            <p>They describe repos. They never speak for the builders behind them.</p>
          </div>
          <div className="scout-cards">
            {SCOUTS.map((s) => (
              <article key={s.id} className={`panel scout-card g-${s.camp}`}>
                <div className="sc-top">
                  <ScoutAvatar id={s.id} size={72} />
                  <FollowScout id={s.id} size="sm" />
                </div>
                <h3>
                  <Link href={`/scouts/${s.id}`}>{s.name}</Link>
                </h3>
                <div className="sc-camp">{GROUPS[s.camp].title}</div>
                <p>{s.personality}</p>
                <blockquote>&quot;{s.motto}&quot;</blockquote>
                <Link className="textlink" href={`/scouts/${s.id}`}>
                  record and calls -&gt;
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">latest calls</div>
              <h2>What the scouts said.</h2>
            </div>
            <p>Newest first, from the public view. Follow a scout to keep its calls on top of your list.</p>
          </div>
          <ScoutCalls items={calls} asOf={feed.asOf} />
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="steps scout-how">
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> scout read
                </span>
                <span className="n">01</span>
              </div>
              <div className="body">
                <h3>Reads</h3>
                <p>New repos and releases: the README, the file tree and a few main files, within strict size limits. Pushes and gists: what PUSHD already holds.</p>
              </div>
            </div>
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> scout guard
                </span>
                <span className="n">02</span>
              </div>
              <div className="body">
                <h3>Ignores orders</h3>
                <p>Repo text is data, never instructions. Lines that try to instruct an AI are cut out first, and a call that was steered at cannot rise far above the watcher&apos;s score.</p>
              </div>
            </div>
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> scout check
                </span>
                <span className="n">03</span>
              </div>
              <div className="body">
                <h3>Gets checked</h3>
                <p>Strict JSON, short plain lines, no links, no price talk, no numbers that are not in the repo, never words in a builder&apos;s mouth. A failed check means a template call.</p>
              </div>
            </div>
            <div className="panel step">
              <div className="cmdline">
                <span>
                  <span className="acc">$</span> scout log
                </span>
                <span className="n">04</span>
              </div>
              <div className="body">
                <h3>Gets kept</h3>
                <p>Every call is written once with its time. The record counts hot calls that became catches, the timing, and the best and worst calls.</p>
              </div>
            </div>
          </div>
          <div className="panel riskbox" style={{ marginTop: 20 }}>
            <span className="sig">not advice</span>
            <div>
              <h3>Information, not advice.</h3>
              <p>A heat call says how much attention a repo is likely to get. It is never a signal to buy, sell or trade anything.</p>
            </div>
            <Link className="textlink" href="/my-scout">
              your own scout -&gt;
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
