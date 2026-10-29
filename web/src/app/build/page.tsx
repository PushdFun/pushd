import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildEditor } from "@/components/BuildEditor";
import { BuildSignOut } from "@/components/BuildSignOut";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { ScoutVotes } from "@/components/ScoutVotes";
import { JOB_IDS, JOBS, TRIGGER_LABEL } from "@/lib/build";
import { agentsOn, getBuildConfig, getBuildMe, getScoutBuilds } from "@/lib/build-server";
import { getHolder } from "@/lib/data";
import { agoWords, num } from "@/lib/format";
import { SCOUT_BY_ID } from "@/lib/scouts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PUSHD Build",
  description: "Build your own agent that helps you ship on GitHub: release notes, a post about what shipped, a key check on each push, pull requests on request.",
  alternates: { canonical: "/build" },
};

const SIGNIN_WORDS: Record<string, string> = {
  again: "The sign-in did not match this browser. Start it again.",
  failed: "GitHub did not finish the sign-in. Start it again.",
  off: "Sign-in with GitHub is not open yet.",
};

export default async function BuildPage({ searchParams }: { searchParams: Promise<{ signin?: string; installed?: string }> }) {
  if (!agentsOn()) notFound();
  const sp = await searchParams;
  const [config, me, scouts, holder] = await Promise.all([getBuildConfig(), getBuildMe(), getScoutBuilds(), getHolder()]);
  const asOf = new Date().toISOString();
  const tag = !config ? "not connected" : !config.ready ? "opens soon" : me ? `signed in . ${me.user.login}` : "sign in with GitHub";

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/build" cmd="pushd agent new" />
              <h1>
                Build your agent<span className="acc">.</span>
              </h1>
              <p className="lede">
                Say in plain words what it should do. It works only on the repos you pick, through the PUSHD GitHub App, and every change it makes is a
                pull request on a new branch. You read the plan before it starts.
              </p>
            </div>
            <span className={me ? "tag acc live" : "tag acc"}>{tag}</span>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 48 }}>
        <div className="wrap bd-grid">
          {!config ? (
            <div className="panel bd-pad">
              <h3>The engine is not connected here.</h3>
              <p className="muted" style={{ marginTop: 10 }}>
                The builder runs with PUSHD&apos;s engine. The jobs an agent can do are listed below.
              </p>
            </div>
          ) : !config.ready ? (
            <div className="panel bd-pad">
              <h3>Opens soon.</h3>
              <p className="muted" style={{ marginTop: 10 }}>
                The PUSHD GitHub App is being set up. The jobs an agent will do are listed below.
              </p>
            </div>
          ) : me ? (
            <div className="bd-side">
              <BuildEditor repos={me.repos} full={me.agents.length >= me.allowed} allowed={me.allowed} used={me.agents.length} />
              {me.agents.map((a) => (
                <Link key={a.id} href={`/build/${a.id}`} className="panel bd-card">
                  <div className="bd-card-top">
                    <h3>{a.name}</h3>
                    <span className={a.paused ? "tag" : "tag acc"}>{a.paused ? "paused" : "on"}</span>
                  </div>
                  <p>{a.spec.jobs.map((j) => `${JOBS[j.job].title} ${TRIGGER_LABEL[j.trigger]}`).join(". ")}.</p>
                  <small>
                    {a.spec.repos.join(", ")} . {SCOUT_BY_ID[a.spec.model].name} . {num(a.runs)} run{a.runs === 1 ? "" : "s"}
                    {a.lastRunAt ? `, last ${agoWords(new Date(a.lastRunAt).toISOString(), asOf)}` : ""}
                  </small>
                </Link>
              ))}
            </div>
          ) : (
            <div className="panel bd-pad bd-who">
              <h3>Sign in with GitHub to start.</h3>
              <p className="muted">
                Signing in tells PUSHD who you are and which repos you installed the app on. PUSHD keeps no GitHub token: the agent works through the
                app, with a short-lived key for one repo at a time.
              </p>
              {sp.signin && SIGNIN_WORDS[sp.signin] && <div className="bd-err">{SIGNIN_WORDS[sp.signin]}</div>}
              {config.signIn ? (
                // a plain link: the sign-in route redirects to GitHub and must never be prefetched
                // eslint-disable-next-line @next/next/no-html-link-for-pages
                <a className="btn btn-acc" href="/api/build/github/login">
                  Sign in with GitHub -&gt;
                </a>
              ) : (
                <span className="btn btn-off">Sign-in opens soon</span>
              )}
            </div>
          )}

          <aside className="bd-side">
            {me && (
              <div className="panel bd-pad bd-who">
                <div className="bd-head">
                  <h3>{me.user.login}</h3>
                  <span className={me.holder ? "tag acc" : "tag"}>{me.holder ? "holder" : "free"}</span>
                </div>
                <dl className="kv2" style={{ marginTop: 0 }}>
                  <div>
                    <dt>runs today</dt>
                    <dd>{me.holder ? "no daily count" : `${me.freeLeft} of ${me.freePerDay} free left`}</dd>
                  </div>
                  <div>
                    <dt>after that</dt>
                    <dd>{me.holder ? "holders run without a count" : me.price.open ? `${me.price.eth} ETH a run, to the burn` : "paid runs open at launch"}</dd>
                  </div>
                  <div>
                    <dt>agents</dt>
                    <dd>
                      {me.agents.length} of {me.allowed}
                    </dd>
                  </div>
                  <div>
                    <dt>repos with the app</dt>
                    <dd>{me.repos.length}</dd>
                  </div>
                  <div>
                    <dt>wallet</dt>
                    <dd>{me.wallet ? `${me.wallet.slice(0, 6)}...${me.wallet.slice(-4)}` : "none linked"}</dd>
                  </div>
                </dl>
                {me.paused && <div className="bd-note">Agent runs are paused for today. They start again at 00:00 UTC.</div>}
                {!me.wallet && <p className="muted" style={{ fontSize: 14 }}>Hold $PUSHD? Sign in as a holder on the Holders page in this browser, then come back: the wallet links to this account.</p>}
                {sp.installed && <div className="bd-ok">The app is installed. Sign out and in again if a new repo is missing.</div>}
                <div className="bd-actions">
                  {me.installUrl && (
                    <a className="btn btn-line" href={me.installUrl} target="_blank" rel="noopener noreferrer">
                      Pick repos on GitHub
                    </a>
                  )}
                  <BuildSignOut />
                </div>
              </div>
            )}
            {me && me.inbox.length > 0 && (
              <div className="panel bd-pad bd-inbox">
                <div className="bd-head">
                  <h3>Inbox</h3>
                  <span className="bd-count">{me.inbox.length} latest</span>
                </div>
                <ol>
                  {me.inbox.slice(0, 8).map((n) => (
                    <li key={n.n}>
                      <b>{n.title}</b>
                      <p>{n.body}</p>
                      <small>{agoWords(new Date(n.at).toISOString(), asOf)}</small>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {!me && (
              <div className="panel bd-pad">
                <h3>How it works</h3>
                <ol className="pay-steps tight">
                  <li>
                    <b>Say it.</b> In plain words, like &quot;after every push, write release notes and a post about what shipped&quot;.
                  </li>
                  <li>
                    <b>Read it.</b> PUSHD turns it into a plan: jobs, when each runs, which repos, which model. Change anything, then confirm.
                  </li>
                  <li>
                    <b>Install the app</b> on the repos you pick. Nothing else is reachable.
                  </li>
                  <li>
                    <b>Get the work.</b> Pull requests on new branches, drafts to copy, a receipt for every run.
                  </li>
                </ol>
                {config && <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>{config.freePerDay} runs a day are free. Holders of $PUSHD run without a daily count.</p>}
              </div>
            )}
          </aside>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">jobs</div>
              <h2>What an agent can do.</h2>
            </div>
            <p>Only these jobs, only on these triggers. It never pushes to your default branch, never touches workflows and never posts to X.</p>
          </div>
          <div className="panel tool-table bd-jobtable">
            {JOB_IDS.map((id) => (
              <div key={id} className="tt-row">
                <code className="tt-name">{JOBS[id].title}</code>
                <span className="tt-rest">{JOBS[id].triggers.map((t) => TRIGGER_LABEL[t]).join(", ")}</span>
                <span className="tt-what">{JOBS[id].what}</span>
                <span className="tt-price">{JOBS[id].free ? "free" : "a run"}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {scouts && (
        <section className="section" id="scouts">
          <div className="wrap">
            <div className="sec-head slim">
              <div>
                <div className="eyebrow">scouts that push</div>
                <h2>The scouts build too.</h2>
              </div>
              <p>
                Each scout has its own repo and its own agent. Once a day it builds something small from what it watched. Holders vote on what each
                one builds next: one vote per scout per round.
              </p>
            </div>
            <div className="bd-scouts">
              {scouts.scouts.map((s) => (
                <div key={s.id} className="panel bd-scout">
                  <div className="bd-scout-top">
                    <ScoutAvatar id={s.id} size={40} />
                    <div>
                      <b>{s.name}</b>
                      <small>{s.repo}</small>
                    </div>
                  </div>
                  {s.latest[0] ? (
                    <div className="bd-last">
                      {s.latest[0].url ? (
                        <a href={s.latest[0].url} target="_blank" rel="noopener noreferrer">
                          {s.latest[0].title ?? "latest build"} -&gt;
                        </a>
                      ) : (
                        s.latest[0].summary
                      )}
                    </div>
                  ) : (
                    <div className="bd-last">{s.installed ? "First build today after 12:00 UTC." : "No builds yet."}</div>
                  )}
                  <div className="bd-k">next build, {s.round}</div>
                  <ScoutVotes scout={s} canVote={!!holder?.status.holder} />
                  <Link className="textlink" href={`/shipped/${s.repo}`}>
                    what it shipped -&gt;
                  </Link>
                </div>
              ))}
            </div>
            <p className="small-note">{holder?.status.holder ? "You can vote: one vote per scout in each round." : "Voting is for holders, signed in with MetaMask on the Holders page."}</p>
          </div>
        </section>
      )}
    </>
  );
}
