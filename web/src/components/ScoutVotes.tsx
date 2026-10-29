"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScoutBuild } from "@/lib/build";

// A scout's ideas for its next build, and the holder's one vote on them for this round.
export function ScoutVotes({ scout, canVote }: { scout: ScoutBuild; canVote: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const voted = scout.myVote != null;

  const vote = async (option: number) => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/build/scouts/vote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scout: scout.id, option }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setErr(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? "That did not work.");
    router.refresh();
  };

  return (
    <>
      <ol>
        {scout.options.map((o, i) => (
          <li key={i}>
            <button type="button" className="bd-vote" disabled={!canVote || voted || busy} aria-pressed={scout.myVote === i} onClick={() => vote(i)}>
              <span>{o.text}</span>
              <span>
                {o.votes} vote{o.votes === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {err && <div className="bd-err">{err}</div>}
    </>
  );
}
