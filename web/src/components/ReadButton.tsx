"use client";

import { useState } from "react";
import { HEAT_CLASS } from "@/lib/groups";
import { agoWords } from "@/lib/format";
import { callHeat, NOT_ADVICE, SCOUT_BY_ID, VERDICT_LABEL } from "@/lib/scouts";
import type { ReadAllowance, ScoutId, ScoutRead } from "@/lib/types";
import { Heat } from "./Heat";

// "Ask a scout to read it": the repo goes to the scout of its owner's camp (DeepSeek for open source), which reads the
// README, the file tree and a few main files with its deep model and says what the repo really is. Holders get a few
// free reads a day, everyone else shares a small daily number; all of it under the scouts' daily spend cap.

export function ScoutReadCard({ read }: { read: ScoutRead }) {
  const s = SCOUT_BY_ID[read.scout];
  return (
    <div className="sread">
      <div className="sread-top">
        <span className="stag model" title={`Written by ${read.model}`}>
          model . {read.model.split("/").pop()}
        </span>
        <span className="pill-v">{VERDICT_LABEL[read.verdict]}</span>
        <span className="muted">
          {s.name} read it {agoWords(read.readAt, new Date().toISOString())}
          {read.cached ? " (kept read)" : ""}
        </span>
      </div>
      <p className="sread-line">{read.line}</p>
      <p className="muted">{read.why}</p>
      {read.whatItIs && (
        <p>
          <b>What it is:</b> {read.whatItIs}
        </p>
      )}
      <div className="sread-heat">
        <Heat heat={callHeat(read.heat)} label={false} />
        <span className={`h-${HEAT_CLASS[callHeat(read.heat)]}`}>{read.heat}/10</span>
        <span className="muted">{read.heatReason}</span>
      </div>
      {read.flags.map((f) => (
        <p key={f} className="sread-flag">
          {f}
        </p>
      ))}
      <small className="muted">
        Read {read.read.readmeChars.toLocaleString("en-US")} characters of README, {read.read.treePaths} paths
        {read.read.files.length ? `, ${read.read.files.join(", ")}` : ""}. {NOT_ADVICE}
      </small>
    </div>
  );
}

export function ReadButton({ repo, scout, allowance, initial }: { repo: string; scout: ScoutId; allowance: ReadAllowance; initial: ScoutRead | null }) {
  const [read, setRead] = useState<ScoutRead | null>(initial);
  const [a, setA] = useState(allowance);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = SCOUT_BY_ID[scout];
  const left = a.holderLeft != null ? a.holderLeft : a.publicLeft;
  const canAsk = a.open && left > 0;

  const ask = async () => {
    setBusy(true);
    setMsg(`${s.name} is reading the repo. This takes up to a minute.`);
    const res = await fetch("/api/gh/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { read?: ScoutRead; allowance?: ReadAllowance; error?: string }) : {};
    setBusy(false);
    if (res?.ok && body.read) {
      setRead(body.read);
      if (body.allowance) setA(body.allowance);
      setMsg(null);
    } else setMsg(body.error ?? "The read did not come back. Try again in a minute.");
  };

  return (
    <div className="readbox">
      <div className="readbox-act">
        <button type="button" className="btn btn-acc" onClick={ask} disabled={!canAsk || busy}>
          {busy ? "Reading..." : read ? `Ask ${s.name} again` : `Ask ${s.name} to read it`}
        </button>
        <span className="muted readbox-left" role="status">
          {msg ??
            (!a.open
              ? (a.why ?? "Scout reads are not open right now.")
              : a.holderLeft != null
                ? `${a.holderLeft} of ${a.holderPerDay} free reads left today for you`
                : `${a.publicLeft} of ${a.publicPerDay} public reads left today. Holders get ${a.holderPerDay} a day.`)}
        </span>
      </div>
      {read ? (
        <ScoutReadCard read={read} />
      ) : (
        <div className="estate">
          <b>No read kept yet.</b>
          <span>A read is kept for a few hours, so the next visitor sees it without a new call.</span>
        </div>
      )}
    </div>
  );
}
