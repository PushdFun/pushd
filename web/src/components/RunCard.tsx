import type { ReactNode } from "react";
import { STATUS_WORDS, type Output, type RunView } from "@/lib/build";
import { agoWords } from "@/lib/format";
import { CopyPost } from "./CopyPost";

// One run as its receipt: the job, the repo, the model, what it cost, what it made, and every action it took with its
// link on GitHub. `actions` slots in what the owner may still do (approve a reply, pay for the run).

const ACTION_WORDS: Record<string, string> = { branch: "made the branch", commit: "committed", pull_request: "opened the pull request", comment: "commented", labels: "labelled", release: "drafted the release", merge: "merged" };

function OutputView({ o }: { o: Output }) {
  switch (o.type) {
    case "draft":
      return (
        <div>
          <div className="bd-k">draft: {o.title}</div>
          <pre className="bd-pre">{o.text}</pre>
        </div>
      );
    case "report":
      return <pre className="bd-pre">{o.text}</pre>;
    case "post":
      return <CopyPost text={o.text} />;
    case "warning":
      return <div className="bd-warn">{o.text}</div>;
    case "findings":
      return (
        <table className="bd-table">
          <thead>
            <tr>
              <th>file</th>
              <th>line</th>
              <th>what</th>
              <th>masked</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((f, i) => (
              <tr key={i}>
                <td>{f.file}</td>
                <td>{f.line ?? ""}</td>
                <td>{f.kind}</td>
                <td>{f.masked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "deps":
      return (
        <table className="bd-table">
          <thead>
            <tr>
              <th>package</th>
              <th>yours</th>
              <th>latest</th>
              <th>why</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((d) => (
              <tr key={d.name}>
                <td>{d.name}</td>
                <td>{d.current}</td>
                <td>{d.latest ?? ""}</td>
                <td>{[d.vulns.length ? `known vulnerabilities: ${d.vulns.join(", ")}` : "", d.behind ? "two or more major versions behind" : ""].filter(Boolean).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "link":
      return (
        <div className="bd-links">
          <a href={o.url} target="_blank" rel="noopener noreferrer">
            {o.label} -&gt;
          </a>
        </div>
      );
    case "approval":
      return (
        <div>
          <div className="bd-k">
            reply to issue #{o.issue}: {o.state === "waiting" ? "waits for you" : o.state}
          </div>
          <pre className="bd-pre">{o.text}</pre>
          {o.url && (
            <div className="bd-links">
              <a href={o.url} target="_blank" rel="noopener noreferrer">
                the reply on GitHub -&gt;
              </a>
            </div>
          )}
        </div>
      );
  }
}

export function RunCard({ run, asOf, actions, receipt = true }: { run: RunView; asOf: string; actions?: ReactNode; receipt?: boolean }) {
  return (
    <article className="panel bd-run" id={`run-${run.id}`}>
      <div className="bd-run-top">
        <b>
          {run.jobTitle} <span className="muted">on {run.repo}</span>
        </b>
        <span className={`bd-status ${run.status}`}>{STATUS_WORDS[run.status] ?? run.status}</span>
      </div>
      <div className="bd-run-meta">
        <span>{agoWords(new Date(run.createdAt).toISOString(), asOf)}</span>
        <span>{run.trigger.replace(/_/g, " ")}</span>
        {run.model && <span>{run.model}</span>}
        {receipt && run.usd > 0 && <span>${run.usd.toFixed(4)} model cost</span>}
        {receipt && run.billing === "free" && <span>free run</span>}
        {receipt && run.billing === "paid" && <span>paid to the burn</span>}
        <span>receipt {run.id}</span>
      </div>
      {run.summary && <p>{run.summary}</p>}
      {run.error && <p className="bd-err">{run.error}</p>}
      {run.outputs.map((o, i) => (
        <OutputView key={i} o={o} />
      ))}
      {run.flags.length > 0 && (
        <div className="bd-flags">
          {run.flags.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
      {run.actions.length > 0 && (
        <ul className="bd-acts">
          {run.actions.map((a, i) => (
            <li key={i}>
              {ACTION_WORDS[a.action] ?? a.action}
              {a.note ? ` ${a.note}` : ""}{" "}
              {a.url && (
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  -&gt;
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {actions}
    </article>
  );
}
