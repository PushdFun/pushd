"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { JOB_IDS, JOBS, TRIGGER_LABEL, type AgentSpec, type JobId, type JobSpec, type Trigger } from "@/lib/build";
import { SCOUTS } from "@/lib/scouts";
import { ScoutAvatar } from "./ScoutAvatar";

// The builder: plain words to an agent spec (the engine drafts it with a model, or its keyword reader), the spec read
// and changed here, then confirmed. The engine checks every field again on save against its whitelist of jobs and
// triggers and the repos this person installed the app on.

const EXAMPLES = ["after every push, write release notes and a post about what shipped", "check every push for keys, and review my pull requests", "every week, a report of what shipped and a dependency check"];

async function call<T>(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: { error: "PUSHD did not answer. Try again in a minute." } as T & { error?: string } };
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

export function BuildEditor({ repos, full, allowed, used }: { repos: string[]; full: boolean; allowed: number; used: number }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [info, setInfo] = useState<{ source: "model" | "template"; notes: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const draft = async () => {
    setErr(null);
    setBusy("draft");
    const r = await call<{ spec: AgentSpec; source: "model" | "template"; notes: string[] }>("/api/build/draft", "POST", { text });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    setSpec(r.data.spec);
    setInfo({ source: r.data.source, notes: r.data.notes });
  };

  const save = async () => {
    if (!spec) return;
    setErr(null);
    setBusy("save");
    const r = await call<{ agent: { id: string } }>("/api/build/agents", "POST", { spec, text });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    router.push(`/build/${r.data.agent.id}`);
  };

  const set = (patch: Partial<AgentSpec>) => spec && setSpec({ ...spec, ...patch });
  const jobOf = (id: JobId) => spec?.jobs.find((j) => j.job === id) ?? null;
  const toggleJob = (id: JobId) => {
    if (!spec) return;
    const on = jobOf(id);
    const next: JobSpec = { job: id, trigger: JOBS[id].byDefault, ...(id === "release_notes" ? { deliver: "draft" as const } : {}), ...(id === "issue_helper" ? { post: false } : {}), ...(id === "dependency_watch" ? { bumpPr: false } : {}) };
    set({ jobs: on ? spec.jobs.filter((j) => j.job !== id) : [...spec.jobs, next] });
  };
  const patchJob = (id: JobId, patch: Partial<JobSpec>) => spec && set({ jobs: spec.jobs.map((j) => (j.job === id ? { ...j, ...patch } : j)) });
  const toggleRepo = (r: string) => spec && set({ repos: spec.repos.includes(r) ? spec.repos.filter((x) => x !== r) : [...spec.repos, r] });

  if (full)
    return (
      <div className="panel bd-pad">
        <div className="bd-head">
          <h3>Your agents</h3>
          <span className="bd-count">
            {used} of {allowed}
          </span>
        </div>
        <p className="muted">
          {allowed === 1 ? "You have your one agent. Open it below to run it, pause it or delete it. Holding $PUSHD allows more." : `Your holding allows ${allowed} agents and you have them all. Delete one, or hold more for the next tier.`}
        </p>
      </div>
    );

  return (
    <div className="panel bd-pad" id="editor">
      <div className="bd-head">
        <h3>Describe your agent</h3>
        <span className="bd-count">
          {used} of {allowed} agent{allowed === 1 ? "" : "s"}
        </span>
      </div>
      <label className="sr" htmlFor="bd-text">
        What the agent should do, in plain words
      </label>
      <textarea id="bd-text" className="bd-input" value={text} maxLength={600} placeholder={EXAMPLES[0]} onChange={(e) => setText(e.target.value)} />
      <div className="bd-actions" style={{ marginTop: 12 }}>
        <div className="chips">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="chip" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
      </div>
      <div className="bd-actions" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-acc" disabled={text.trim().length < 6 || !!busy} onClick={draft}>
          {busy === "draft" ? "Reading it" : "Turn it into an agent"}
        </button>
        {!repos.length && <span className="bd-note">Install the PUSHD GitHub App on a repo first; the agent can only work there.</span>}
      </div>

      {spec && (
        <div className="bd-spec">
          {info && (
            <div className="bd-k">
              {info.source === "model" ? "drafted by the model" : "read by the keyword reader"}. Check it, change anything, then confirm.
            </div>
          )}
          {info?.notes.map((n) => (
            <div key={n} className="bd-note">
              {n}
            </div>
          ))}
          <div className="bd-field">
            <span className="bd-k">name</span>
            <input className="bd-name" value={spec.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} aria-label="The agent's name" />
          </div>
          <div className="bd-field">
            <span className="bd-k">model</span>
            <div className="bd-models">
              {SCOUTS.map((s) => (
                <button key={s.id} type="button" className="bd-model" aria-pressed={spec.model === s.id} onClick={() => set({ model: s.id })} title={`${s.modelName} by ${s.maker}`}>
                  <ScoutAvatar id={s.id} size={24} />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="bd-field">
            <span className="bd-k">repos</span>
            <div className="chips">
              {repos.length ? (
                repos.map((r) => (
                  <button key={r} type="button" className={spec.repos.includes(r) ? "chip on" : "chip"} aria-pressed={spec.repos.includes(r)} onClick={() => toggleRepo(r)}>
                    {r}
                  </button>
                ))
              ) : (
                <span className="muted">No repos yet.</span>
              )}
            </div>
          </div>
          <div className="bd-field">
            <span className="bd-k">jobs</span>
            <div className="bd-jobs">
              {JOB_IDS.map((id) => {
                const j = jobOf(id);
                const info = JOBS[id];
                return (
                  <div key={id} className={j ? "bd-job on" : "bd-job"}>
                    <input type="checkbox" checked={!!j} onChange={() => toggleJob(id)} aria-label={info.title} />
                    <div>
                      <b>{info.title}</b>
                      {info.free && <span className="bd-free">free</span>}
                      <p>{info.what}</p>
                    </div>
                    {j && info.triggers.length > 1 ? (
                      <select className="select" value={j.trigger} onChange={(e) => patchJob(id, { trigger: e.target.value as Trigger })} aria-label={`When ${info.title} runs`}>
                        {info.triggers.map((t) => (
                          <option key={t} value={t}>
                            {TRIGGER_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="bd-k">{TRIGGER_LABEL[info.byDefault]}</span>
                    )}
                    {j && id === "release_notes" && (
                      <div className="bd-opt">
                        <label>
                          <input type="radio" name="deliver" checked={j.deliver !== "pr"} onChange={() => patchJob(id, { deliver: "draft" })} /> a draft here
                        </label>
                        <label>
                          <input type="radio" name="deliver" checked={j.deliver === "pr"} onChange={() => patchJob(id, { deliver: "pr" })} /> a pull request
                        </label>
                      </div>
                    )}
                    {j && id === "issue_helper" && (
                      <div className="bd-opt">
                        <label>
                          <input type="checkbox" checked={!!j.post} onChange={(e) => patchJob(id, { post: e.target.checked })} /> post replies without asking me
                        </label>
                      </div>
                    )}
                    {j && id === "dependency_watch" && (
                      <div className="bd-opt">
                        <label>
                          <input type="checkbox" checked={!!j.bumpPr} onChange={(e) => patchJob(id, { bumpPr: e.target.checked })} /> open a pull request to bump them
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="bd-actions">
            <button type="button" className="btn btn-acc" disabled={!spec.repos.length || !spec.jobs.length || !!busy} onClick={save}>
              {busy === "save" ? "Saving" : "Confirm and make the agent"}
            </button>
            <button type="button" className="btn btn-line" onClick={() => (setSpec(null), setInfo(null))}>
              Start over
            </button>
          </div>
        </div>
      )}
      {err && <div className="bd-err">{err}</div>}
    </div>
  );
}
