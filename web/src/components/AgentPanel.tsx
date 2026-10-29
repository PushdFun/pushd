"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { JOBS, requestable, type AgentView, type JobId, type RunView } from "@/lib/build";
import { injectedWallet, metamaskLink, METAMASK_DOWNLOAD, onPhone, toRobinhoodChain, utf8Hex, walletError } from "@/lib/wallet";
import { RunCard } from "./RunCard";

// One agent's page, the parts the owner acts on: pause, the public page, delete; a run now; the receipts, with a
// drafted reply to approve and a run to pay for. A payment is an ordinary ETH transfer to the burn pot from the
// owner's own wallet, then a signature over "PUSHD payment <hash>" (signing sends nothing); the engine checks both on
// the chain before the run starts.

async function call<T>(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: { error: "PUSHD did not answer. Try again in a minute." } as T & { error?: string } };
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string; code?: string } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AgentPanel({ agent, runs, asOf, price }: { agent: AgentView; runs: RunView[]; asOf: string; price: { wei: string; eth: string; payTo: string | null; open: boolean } }) {
  const router = useRouter();
  const jobs = requestable(agent.spec);
  const [job, setJob] = useState<JobId | "">(jobs[0] ?? "");
  const [repo, setRepo] = useState(agent.spec.repos[0] ?? "");
  const [request, setRequest] = useState("");
  const [kind, setKind] = useState<"fix" | "docs" | "readme" | "tests">("fix");
  const [num, setNum] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const settings = async (patch: { paused?: boolean; proof?: boolean }) => {
    setBusy("settings");
    const r = await call(`/api/build/agents/${agent.id}`, "PATCH", patch);
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    router.refresh();
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${agent.name}"? Its receipts stay; they leave the public page.`)) return;
    setBusy("delete");
    const r = await call(`/api/build/agents/${agent.id}`, "DELETE");
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    router.push("/build");
  };

  const runNow = async () => {
    setErr(null);
    setNote(null);
    setBusy("run");
    const body: Record<string, unknown> = { job, repo };
    if (job === "small_change") Object.assign(body, { request, kind });
    if (job === "pr_review") body.pr = Number(num);
    if (job === "issue_helper") body.issue = Number(num);
    const r = await call<{ run: RunView; runId?: string }>(`/api/build/agents/${agent.id}/run`, "POST", body);
    setBusy(null);
    if (r.status === 402) {
      setNote(`Your free runs for today are used. This run waits below: pay ${price.eth} ETH to run it now. Every paid run buys $PUSHD and burns it.`);
      return router.refresh();
    }
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    setNote("Queued. It runs in a moment; this page shows the receipt when it is done.");
    router.refresh();
  };

  const approve = async (run: RunView, index: number, post: boolean) => {
    setBusy(`approve-${run.id}`);
    const r = await call(`/api/build/runs/${run.id}/approve`, "POST", { index, post });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    router.refresh();
  };

  const pay = async (run: RunView) => {
    setErr(null);
    if (!price.open || !price.payTo) return setErr("Paid runs open at launch.");
    const eth = injectedWallet();
    if (!eth) {
      if (onPhone()) window.location.assign(metamaskLink("pay"));
      else window.open(METAMASK_DOWNLOAD, "_blank", "noopener");
      return;
    }
    let from = "";
    try {
      setBusy(`pay-${run.id}`);
      setNote("Open MetaMask to connect.");
      const list = (await eth.request({ method: "eth_requestAccounts" })) as unknown;
      from = Array.isArray(list) && typeof list[0] === "string" ? list[0] : "";
      await toRobinhoodChain(eth);
    } catch (e) {
      setBusy(null);
      setNote(null);
      return setErr(walletError(e, "connect").message);
    }
    let tx: unknown;
    try {
      setNote(`Confirm the payment of ${price.eth} ETH in MetaMask. It goes to the burn pot.`);
      tx = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: price.payTo, value: `0x${BigInt(price.wei).toString(16)}` }] });
    } catch (e) {
      setBusy(null);
      setNote(null);
      return setErr(walletError(e, "send").message);
    }
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
      setBusy(null);
      return setErr("MetaMask did not say which transaction it sent. Look at its activity before paying again.");
    }
    let signature: unknown;
    try {
      setNote("Sign the message in MetaMask. It sends nothing; it shows the payment is yours.");
      signature = await eth.request({ method: "personal_sign", params: [utf8Hex(`PUSHD payment ${tx.toLowerCase()}`), from] });
    } catch (e) {
      setBusy(null);
      setNote(`Paid in ${tx}. Signing was declined; press Pay again and sign to use this payment.`);
      return setErr(walletError(e, "sign").message);
    }
    // the transaction may need a few seconds to land in a block
    for (let i = 0; i < 8; i++) {
      setNote("Checking the payment on the chain.");
      const r = await call(`/api/build/runs/${run.id}/pay`, "POST", { tx, signature });
      if (r.ok) {
        setBusy(null);
        setNote("Paid. The run is queued.");
        return router.refresh();
      }
      if (r.status !== 402 || (r.data.code !== "pending" && r.data.code !== "not_found")) {
        setBusy(null);
        setNote(null);
        return setErr(r.data.error ?? "The payment was not accepted.");
      }
      await wait(4000);
    }
    setBusy(null);
    setErr(`The payment is not in a block yet. Wait a minute and press Pay again: the same payment (${tx.slice(0, 10)}) will be checked, nothing new is sent.`);
  };

  return (
    <div className="bd-grid">
      <div className="bd-runs">
        {runs.length ? (
          runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              asOf={asOf}
              actions={
                <>
                  {r.status === "waiting_payment" && (
                    <div className="bd-actions">
                      <button type="button" className="btn btn-acc" disabled={!!busy} onClick={() => pay(r)}>
                        {busy === `pay-${r.id}` ? "Paying" : `Pay ${price.eth} ETH to run it`}
                      </button>
                      <span className="muted" style={{ fontSize: 13.5 }}>
                        Paid to the burn pot: it buys $PUSHD and burns it.
                      </span>
                    </div>
                  )}
                  {r.outputs.map((o, i) =>
                    o.type === "approval" && o.state === "waiting" ? (
                      <div key={i} className="bd-actions">
                        <button type="button" className="btn btn-acc" disabled={!!busy} onClick={() => approve(r, i, true)}>
                          Post this reply on #{o.issue}
                        </button>
                        <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => approve(r, i, false)}>
                          Dismiss
                        </button>
                      </div>
                    ) : null,
                  )}
                </>
              }
            />
          ))
        ) : (
          <div className="panel bd-pad">
            <b>No runs yet.</b>
            <p className="muted">Runs start on the triggers you picked, or when you press Run it. Each one leaves a receipt here.</p>
          </div>
        )}
      </div>
      <div className="bd-side">
        <div className="panel bd-pad">
          <div className="bd-head">
            <h3>Settings</h3>
            <span className={agent.paused ? "tag" : "tag acc live"}>{agent.paused ? "paused" : "on"}</span>
          </div>
          <div className="bd-settings">
            <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => settings({ paused: !agent.paused })}>
              {agent.paused ? "Switch on" : "Pause"}
            </button>
            <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => settings({ proof: !agent.proof })}>
              {agent.proof ? "Hide from the public page" : "Show on the public page"}
            </button>
            <button type="button" className="btn btn-line danger" disabled={!!busy} onClick={remove}>
              Delete
            </button>
          </div>
        </div>

        <div className="panel bd-pad">
          <div className="bd-head">
            <h3>Run now</h3>
          </div>
          {jobs.length ? (
            <div className="bd-runform">
              <div className="row">
                <select className="select" value={job} onChange={(e) => setJob(e.target.value as JobId)} aria-label="Which job">
                  {jobs.map((j) => (
                    <option key={j} value={j}>
                      {JOBS[j].title}
                    </option>
                  ))}
                </select>
                <select className="select" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Which repo">
                  {agent.spec.repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {(job === "pr_review" || job === "issue_helper") && <input type="number" min={1} value={num} onChange={(e) => setNum(e.target.value)} placeholder={job === "pr_review" ? "PR #" : "issue #"} aria-label="Number" />}
              </div>
              {job === "small_change" && (
                <>
                  <div className="chips">
                    {(["fix", "docs", "readme", "tests"] as const).map((k) => (
                      <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                        {k}
                      </button>
                    ))}
                  </div>
                  <textarea className="bd-input small" maxLength={600} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Say what to change, and name the files: fix the typo in src/cli.ts" aria-label="What to change" />
                </>
              )}
              <div className="bd-actions">
                <button type="button" className="btn btn-acc" disabled={!!busy || !job || agent.paused || (job === "small_change" && request.trim().length < 6) || ((job === "pr_review" || job === "issue_helper") && !(Number(num) > 0))} onClick={runNow}>
                  {busy === "run" ? "Asking" : "Run it"}
                </button>
                <span className="muted" style={{ fontSize: 13.5 }}>
                  {JOBS[job as JobId]?.what}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted">This agent&apos;s jobs run on their own triggers only.</p>
          )}
          {note && <div className="bd-ok">{note}</div>}
          {err && <div className="bd-err">{err}</div>}
        </div>
      </div>
    </div>
  );
}
