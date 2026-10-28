"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { GROUP_ORDER, GROUPS } from "@/lib/groups";
import {
  cleanKeyword,
  EMPTY_RULE,
  KIND_CHIP,
  matchesAll,
  readable,
  RULE_KINDS,
} from "@/lib/rules";
import type {
  Builder,
  FeedItem,
  MyScout,
  MyScoutsView,
  Rule,
  RuleDraft,
} from "@/lib/types";

// A holder's own scouts: plain words to a rule (the engine drafts it with its model, or its template parser), the
// rule edited by hand, a preview of what it would have caught lately (no model), then saved. The engine checks
// everything again on save: the holding, the tier, every builder and word.

const EXAMPLES = [
  "tell me when a Solana project creates a repo about agents or payments",
  "very hot releases from AI agent projects",
  "new repos from elizaOS or Phala-Network",
];

async function call<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const r = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r)
    return {
      ok: false,
      status: 0,
      data: { error: "PUSHD did not answer. Try again in a minute." } as T & {
        error?: string;
      },
    };
  return {
    ok: r.ok,
    status: r.status,
    data: (await r.json().catch(() => ({}))) as T & { error?: string },
  };
}

export function MyScoutEditor({
  view,
  builders,
  watched = [],
}: {
  view: MyScoutsView;
  builders: Builder[];
  /** the holder's added accounts: a rule may name them too */
  watched?: string[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [rule, setRule] = useState<Rule | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftInfo, setDraftInfo] = useState<{
    source: RuleDraft["source"];
    notes: string[];
  } | null>(null);
  const [preview, setPreview] = useState<{
    items: { item: FeedItem; why: string }[];
    looked: number;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [pick, setPick] = useState("");
  const used = view.scouts.length;
  const full = !editing && used >= view.allowed;
  const byHandle = useMemo(
    () => new Map(builders.map((b) => [b.handle, b])),
    [builders],
  );

  const draft = async () => {
    setErr(null);
    setBusy("draft");
    const r = await call<RuleDraft>("/api/holder/scouts/draft", "POST", {
      text,
    });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    setRule(r.data.rule);
    setDraftInfo({ source: r.data.source, notes: r.data.notes });
    setPreview(null);
    if (!name) setName(text.trim().slice(0, 40));
  };

  const doPreview = async () => {
    if (!rule) return;
    setErr(null);
    setBusy("preview");
    const r = await call<{
      items: { item: FeedItem; why: string }[];
      looked: number;
    }>("/api/holder/scouts/preview", "POST", { rule });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    setPreview(r.data);
  };

  const save = async () => {
    if (!rule) return;
    setErr(null);
    setBusy("save");
    const r = await call<{ scout: MyScout }>("/api/holder/scouts", "POST", {
      id: editing ?? undefined,
      name: name || "My scout",
      text,
      rule,
    });
    setBusy(null);
    if (!r.ok) return setErr(r.data.error ?? "That did not work.");
    setRule(null);
    setText("");
    setName("");
    setEditing(null);
    setDraftInfo(null);
    setPreview(null);
    router.refresh();
  };

  const edit = (s: MyScout) => {
    setEditing(s.id);
    setRule(s.rule);
    setName(s.name);
    setText(s.text);
    setDraftInfo(null);
    setPreview(null);
    setErr(null);
    document
      .getElementById("editor")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const remove = async (s: MyScout) => {
    if (!window.confirm(`Delete "${s.name}" and its hits?`)) return;
    setBusy(`del-${s.id}`);
    const r = await call(`/api/holder/scouts/${s.id}`, "DELETE");
    setBusy(null);
    if (!r.ok)
      return setErr(
        (r.data as { error?: string }).error ?? "That did not work.",
      );
    router.refresh();
  };

  const set = (patch: Partial<Rule>) => {
    setRule({ ...(rule ?? EMPTY_RULE), ...patch });
    setPreview(null);
  };
  const toggle = <T,>(xs: T[], x: T) =>
    xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x];
  const addKw = () => {
    const w = cleanKeyword(kw);
    if (!w || !rule) return;
    if (!rule.keywords.includes(w) && rule.keywords.length < 12)
      set({ keywords: [...rule.keywords, w] });
    setKw("");
  };

  return (
    <div className="myscout">
      <div className="panel ms-editor" id="editor">
        <div className="ms-head">
          <h3>{editing ? "Edit your scout" : "Describe what to watch"}</h3>
          <span className="ms-count">
            {used} of {view.allowed} scout{view.allowed === 1 ? "" : "s"}
          </span>
        </div>
        {full ? (
          <p className="muted">
            Your holding allows {view.allowed} scout
            {view.allowed === 1 ? "" : "s"}, and you have them all. Edit or
            delete one below, or hold more for the next tier.
          </p>
        ) : (
          <>
            <label className="sr" htmlFor="ms-text">
              What to watch, in plain words
            </label>
            <textarea
              id="ms-text"
              className="ms-text"
              maxLength={300}
              rows={3}
              value={text}
              placeholder="tell me when a Solana project creates a repo about agents or payments"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="ms-row">
              <div className="chips">
                {EXAMPLES.map((x) => (
                  <button
                    key={x}
                    type="button"
                    className="chip"
                    onClick={() => setText(x)}
                  >
                    {x}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-acc"
                disabled={busy !== null || text.trim().length < 4}
                onClick={draft}
              >
                {busy === "draft"
                  ? "drafting..."
                  : rule
                    ? "draft again"
                    : "draft the rule"}
              </button>
            </div>
          </>
        )}

        {rule && (
          <div className="ms-rule">
            <div className="ms-readable">
              <span className="k">your rule</span>
              <p>{readable(rule)}</p>
              {draftInfo && (
                <span
                  className={
                    draftInfo.source === "model" ? "stag model" : "stag tpl"
                  }
                >
                  {draftInfo.source === "model"
                    ? "drafted by the model"
                    : "drafted by the template parser"}
                </span>
              )}
            </div>
            {draftInfo?.notes.map((n) => (
              <p key={n} className="ms-note">
                {n}
              </p>
            ))}

            <div className="ms-field">
              <span className="k">who</span>
              <div>
                <div className="chips">
                  {rule.builders.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className="chip on"
                      onClick={() =>
                        set({ builders: rule.builders.filter((x) => x !== h) })
                      }
                      aria-label={`Remove ${h}`}
                    >
                      {h}
                      {byHandle.get(h)?.org ? (
                        <span className="n">{byHandle.get(h)!.org}</span>
                      ) : null}{" "}
                      <span aria-hidden="true">x</span>
                    </button>
                  ))}
                  <select
                    className="select ms-pick"
                    value={pick}
                    aria-label="Add a project"
                    onChange={(e) => {
                      const h = e.target.value;
                      setPick("");
                      if (h && !rule.builders.includes(h))
                        set({ builders: [...rule.builders, h] });
                    }}
                  >
                    <option value="">+ add a project</option>
                    {GROUP_ORDER.map((g) => (
                      <optgroup key={g} label={GROUPS[g].title}>
                        {builders
                          .filter(
                            (b) =>
                              b.group === g &&
                              !rule.builders.includes(b.handle),
                          )
                          .map((b) => (
                            <option key={b.handle} value={b.handle}>
                              {b.handle}
                              {b.org ? ` (${b.org})` : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                    {watched.filter((h) => !rule.builders.includes(h)).length > 0 && (
                      <optgroup label="Accounts you watch">
                        {watched
                          .filter((h) => !rule.builders.includes(h))
                          .map((h) => (
                            <option key={`w-${h}`} value={h}>
                              {h}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <div className="chips" style={{ marginTop: 8 }}>
                  {GROUP_ORDER.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={
                        rule.camps.includes(g) ? `chip on g-${g}` : "chip"
                      }
                      aria-pressed={rule.camps.includes(g)}
                      onClick={() => set({ camps: toggle(rule.camps, g) })}
                    >
                      {rule.camps.includes(g) ? "anyone in " : ""}
                      {GROUPS[g].chip}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="ms-field">
              <span className="k">what</span>
              <div className="chips">
                {RULE_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={rule.kinds.includes(k) ? "chip on" : "chip"}
                    aria-pressed={rule.kinds.includes(k)}
                    onClick={() => set({ kinds: toggle(rule.kinds, k) })}
                  >
                    {KIND_CHIP[k]}
                  </button>
                ))}
                <span className="ms-hint">
                  {rule.kinds.length ? "" : "none picked: any kind"}
                </span>
              </div>
            </div>

            <div className="ms-field">
              <span className="k">about</span>
              <div className="chips">
                {rule.keywords.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="chip on"
                    onClick={() =>
                      set({ keywords: rule.keywords.filter((x) => x !== k) })
                    }
                    aria-label={`Remove ${k}`}
                  >
                    {k} <span aria-hidden="true">x</span>
                  </button>
                ))}
                <input
                  className="ms-kw"
                  value={kw}
                  maxLength={30}
                  placeholder="+ a word"
                  aria-label="Add a word"
                  onChange={(e) => setKw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addKw();
                    }
                  }}
                  onBlur={addKw}
                />
              </div>
            </div>

            <div className="ms-field">
              <span className="k">heat</span>
              <div className="ms-heat">
                <input
                  type="range"
                  min={0}
                  max={10}
                  value={rule.heatFloor}
                  aria-label="Heat floor"
                  onChange={(e) => set({ heatFloor: Number(e.target.value) })}
                />
                <b>
                  {rule.heatFloor === 0
                    ? "any heat"
                    : `${rule.heatFloor} and up`}
                </b>
              </div>
            </div>

            <div className="ms-field">
              <label className="k" htmlFor="ms-name">
                name
              </label>
              <input
                id="ms-name"
                className="ms-name"
                maxLength={40}
                value={name}
                placeholder="My scout"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="ms-actions">
              <button
                type="button"
                className="btn btn-line"
                disabled={busy !== null || matchesAll(rule)}
                onClick={doPreview}
              >
                {busy === "preview"
                  ? "looking..."
                  : "what it would have caught"}
              </button>
              <button
                type="button"
                className="btn btn-acc"
                disabled={busy !== null || matchesAll(rule)}
                onClick={save}
              >
                {busy === "save"
                  ? "saving..."
                  : editing
                    ? "save changes"
                    : "save this scout"}
              </button>
              {editing && (
                <button
                  type="button"
                  className="btn btn-line"
                  onClick={() => {
                    setEditing(null);
                    setRule(null);
                    setName("");
                    setText("");
                  }}
                >
                  cancel
                </button>
              )}
              {matchesAll(rule) && (
                <span className="ms-hint">
                  Name a project, a camp, a kind, a word or a heat floor.
                </span>
              )}
            </div>

            {preview && (
              <div className="ms-preview">
                <span className="k">
                  {preview.items.length
                    ? `would have caught ${preview.items.length} of the last ${preview.looked} lines`
                    : `nothing in the last ${preview.looked} lines`}
                </span>
                <ul>
                  {preview.items.map((p) => (
                    <li key={p.item.id}>
                      <Link href={`/feed/${p.item.id}`}>
                        {p.item.handle} / {p.item.repo}
                      </Link>
                      <small>{p.why}</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {err && (
          <p className="ms-err" role="alert">
            {err}
          </p>
        )}
      </div>

      <div className="ms-list">
        {view.scouts.map((s) => (
          <article key={s.id} className="panel ms-card">
            <div className="ms-card-top">
              <h3>{s.name}</h3>
              <span className="tag">
                {s.hits} hit{s.hits === 1 ? "" : "s"}
              </span>
            </div>
            <p>{s.readable}</p>
            {s.text && <small>&quot;{s.text}&quot;</small>}
            <div className="ms-card-actions">
              <button
                type="button"
                className="textlink"
                onClick={() => edit(s)}
              >
                edit
              </button>
              <button
                type="button"
                className="textlink danger"
                disabled={busy === `del-${s.id}`}
                onClick={() => remove(s)}
              >
                delete
              </button>
            </div>
          </article>
        ))}
        {view.scouts.length === 0 && (
          <div className="estate">
            <b>No scout of your own yet.</b>
            <span>
              Describe what to watch above. Nothing is saved until you press
              save.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
