"use client";

import Link from "next/link";
import { useState } from "react";
import type { HolderWatchView } from "@/lib/types";

// "Watch this account", for a signed-in holder: it goes on their own list, read at a lower priority than the list,
// and its lines reach their inbox and alerts. Everyone else gets a plain link to what holders get.

export function WatchButton({ login, view }: { login: string; view: HolderWatchView | null }) {
  const [v, setV] = useState(view);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!v)
    return (
      <Link className="btn btn-line" href="/holders" title="Holders can watch any account">
        Holders can watch this -&gt;
      </Link>
    );
  const watching = v.accounts.some((a) => a.login.toLowerCase() === login.toLowerCase());
  const full = !watching && v.accounts.length >= v.allowed;

  const act = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(watching ? `/api/holder/watch/${encodeURIComponent(login)}` : "/api/holder/watch", {
      method: watching ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: watching ? undefined : JSON.stringify({ login }),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as Partial<HolderWatchView> & { error?: string }) : {};
    setBusy(false);
    if (res?.ok && Array.isArray(body.accounts)) {
      setV(body as HolderWatchView);
      setMsg(watching ? "Removed from your list." : "On your list. Its lines go to your inbox and alerts.");
    } else setMsg(body.error ?? "Not saved. Try again in a minute.");
  };

  return (
    <span className="watchbtn">
      <button type="button" className={watching ? "btn btn-line on" : "btn btn-acc"} onClick={act} disabled={busy || full} aria-pressed={watching}>
        {watching ? "Watching . remove" : "Watch this account"}
      </button>
      <small className="muted" role="status">
        {msg ?? (full ? `Your holding allows ${v.allowed}. Remove one on Holders first.` : `${v.accounts.length} of ${v.allowed} on your list`)}
      </small>
    </span>
  );
}
