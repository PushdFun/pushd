"use client";

import Link from "next/link";
import { useState } from "react";
import { agoWords } from "@/lib/format";
import { everyText, ghUserHref, parseQuery } from "@/lib/lookup";
import type { HolderWatchView } from "@/lib/types";
import { Avatar } from "./Avatar";

// A holder's added accounts: any GitHub account on top of the list, read less often than the list itself. Their
// lines reach the inbox (on My scout) and the alerts, and a holder's own scouts can name them.

export function WatchedAccounts({ view }: { view: HolderWatchView }) {
  const [v, setV] = useState(view);
  const [add, setAdd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = new Date().toISOString();

  const call = async (method: "POST" | "DELETE", login: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(method === "POST" ? "/api/holder/watch" : `/api/holder/watch/${encodeURIComponent(login)}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ login }) : undefined,
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as Partial<HolderWatchView> & { error?: string }) : {};
    setBusy(false);
    if (res?.ok && Array.isArray(body.accounts)) {
      setV(body as HolderWatchView);
      setMsg(method === "POST" ? `${login} is on your list.` : `${login} removed.`);
      if (method === "POST") setAdd("");
    } else setMsg(body.error ?? "Not saved. Try again in a minute.");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseQuery(add);
    if (p.kind !== "user") return setMsg("Type a GitHub username, for example vbuterin.");
    void call("POST", p.login);
  };
  const full = v.accounts.length >= v.allowed;

  return (
    <div className="panel wa" id="watching">
      <div className="ht-head">
        <div>
          <div className="eyebrow">accounts you watch</div>
          <h3>Anyone on GitHub, on top of the list.</h3>
          <p className="muted">
            Read {everyText(v.everyMin)}, after the list. Their lines go to your inbox on{" "}
            <Link className="textlink" href="/my-scout#inbox">
              My scout
            </Link>{" "}
            and to your alerts. {v.accounts.length} of {v.allowed} used.
          </p>
        </div>
        <form className="wa-add" onSubmit={submit}>
          <input className="ht-search" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="a GitHub username" aria-label="Add an account" maxLength={60} disabled={full} spellCheck={false} autoComplete="off" />
          <button className="btn btn-acc" type="submit" disabled={busy || full || !add.trim()}>
            Watch
          </button>
        </form>
      </div>
      {v.accounts.length ? (
        <ul className="wa-rows">
          {v.accounts.map((a) => (
            <li key={a.login}>
              <Avatar handle={a.login} size={30} />
              <span className="wa-who">
                <Link href={ghUserHref(a.login)}>{a.login}</Link>
                <small>
                  {a.name && a.name !== a.login ? `${a.name} . ` : ""}
                  {a.type === "org" ? "org" : "person"} . {a.lastReadAt ? `read ${agoWords(a.lastReadAt, now)}` : "not read yet"} . {a.lines} line{a.lines === 1 ? "" : "s"}
                </small>
              </span>
              <button type="button" className="chip" onClick={() => call("DELETE", a.login)} disabled={busy} aria-label={`Stop watching ${a.login}`}>
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="estate">
          <b>None yet.</b>
          <span>Add a username here, or press Watch on any account&apos;s page (search with Ctrl K).</span>
        </div>
      )}
      <div className="wa-foot">
        <div className="tiers">
          <span className="k">accounts by holding</span>
          {v.tiers.map((t) => (
            <span key={t.minWhole} className="tchip">
              {Number(t.minWhole).toLocaleString("en-US")} $PUSHD: {t.accounts}
            </span>
          ))}
        </div>
        {msg ? (
          <span role="status" className="muted">
            {msg}
          </span>
        ) : v.globalLeft <= 0 ? (
          <span className="muted">The server-wide room for added accounts is full right now.</span>
        ) : null}
      </div>
    </div>
  );
}
