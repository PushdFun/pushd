import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentPanel } from "@/components/AgentPanel";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { JOBS, TRIGGER_LABEL } from "@/lib/build";
import { agentsOn, getBuildAgent, getBuildMe } from "@/lib/build-server";
import { SCOUT_BY_ID } from "@/lib/scouts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PUSHD Build: your agent",
  description: "One of your agents: its runs and receipts, its settings, a run on request.",
  robots: { index: false, follow: false },
};

export default async function AgentPage({ params }: { params: Promise<{ agent: string }> }) {
  if (!agentsOn()) notFound();
  const { agent: id } = await params;
  const [one, me] = await Promise.all([getBuildAgent(id), getBuildMe()]);
  if (!me) {
    return (
      <section className="page-head">
        <div className="wrap">
          <Prompt path="~/pushd/build" cmd={`pushd agent show ${id.slice(0, 16)}`} />
          <h1>
            Sign in first<span className="acc">.</span>
          </h1>
          <p className="lede">
            An agent&apos;s page is for its owner. <Link className="textlink" href="/build">Sign in with GitHub on Build -&gt;</Link>
          </p>
        </div>
      </section>
    );
  }
  if (!one) notFound();
  const { agent, runs } = one;
  const s = SCOUT_BY_ID[agent.spec.model];
  const asOf = new Date().toISOString();

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/build" cmd={`pushd agent show ${agent.id}`} />
              <h1>
                {agent.name}
                <span className="acc">.</span>
              </h1>
              <p className="lede">{agent.spec.jobs.map((j) => `${JOBS[j.job].title} ${TRIGGER_LABEL[j.trigger]}`).join(". ")}.</p>
              <div className="bd-run-meta" style={{ marginTop: 14, alignItems: "center" }}>
                <ScoutAvatar id={s.id} size={22} />
                <span>
                  {s.name}, {s.modelName}
                </span>
                <span>{agent.spec.repos.join(", ")}</span>
                <span>{agent.proof ? "on the public page" : "not on the public page"}</span>
              </div>
            </div>
            <Link className="textlink" href="/build">
              all your agents -&gt;
            </Link>
          </div>
        </div>
      </section>
      <section className="section" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <AgentPanel agent={agent} runs={runs} asOf={asOf} price={me.price} />
          {agent.proof && (
            <p className="small-note">
              Public page:{" "}
              {agent.spec.repos.map((r, i) => (
                <span key={r}>
                  {i > 0 && ", "}
                  <Link className="textlink" href={`/shipped/${r}`}>
                    /shipped/{r}
                  </Link>
                </span>
              ))}
              . Private repos never show there.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
