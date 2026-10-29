"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { agoWords } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import { ghUserHref } from "@/lib/lookup";
import type { Suggestion } from "@/lib/types";

// The admin page's two client parts: the key form (the key goes to this site's server once, never into the page or a
// script), and the suggestions with approve and decline. Approving marks it for the owner; nothing is added by itself.

export function AdminLogin() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
    setBusy(false);
    setKey("");
    if (res?.ok) router.refresh();
    else setMsg(body.error ?? "Not signed in. Try again.");
  };
  return (
    <form className="panel admin-login" onSubmit={send}>
      <div className="ptitle">
        <h3>Admin key</h3>
        <span>PUSHD_ADMIN_KEY</span>
      </div>
      <input className="sg-in" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="current-password" aria-label="Admin key" placeholder="the key from the site's settings" required />
      <div className="sg-foot">
        <button className="btn btn-acc" type="submit" disabled={busy || !key}>
          Sign in
        </button>
        <span role="status" className="sg-msg err">
          {msg}
        </span>
      </div>
    </form>
  );
}

export function AdminLogout() {
  const router = useRouter();
  return (
    <button type="button" className="btn btn-line" onClick={async () => (await fetch("/api/admin/logout", { method: "POST" }).catch(() => null), router.refresh())}>
      Sign out
    </button>
  );
}

type Filter = "new" | "approved" | "declined" | "all";

export function AdminSuggestions({ list }: { list: Suggestion[] }) {
  const [rows, setRows] = useState(list);
  const [filter, setFilter] = useState<Filter>("new");
  const [msg, setMsg] = useState<string | null>(null);
  const now = new Date().toISOString();
  const shown = rows.filter((r) => filter === "all" || r.status === filter);

  const mark = async (id: number, status: Suggestion["status"]) => {
    setMsg(null);
    const res = await fetch(`/api/admin/suggestions/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { suggestion?: Suggestion; error?: string }) : {};
    if (res?.ok && body.suggestion) setRows((rs) => rs.map((r) => (r.id === id ? body.suggestion! : r)));
    else setMsg(body.error ?? "Not saved.");
  };

  return (
    <div className="panel admin-sug">
      <div className="ptitle">
        <h3>Suggestions</h3>
        <span>{rows.filter((r) => r.status === "new").length} new</span>
      </div>
      <div className="pills" role="group" aria-label="Filter">
        {(["new", "approved", "declined", "all"] as Filter[]).map((f) => (
          <button key={f} type="button" className={filter === f ? "pill on" : "pill"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f} <span className="pc">{f === "all" ? rows.length : rows.filter((r) => r.status === f).length}</span>
          </button>
        ))}
      </div>
      {shown.length ? (
        <ul className="ad-rows">
          {shown.map((s) => (
            <li key={s.id} className={`g-${s.camp} st-${s.status}`}>
              <div className="ad-who">
                <Link href={ghUserHref(s.login)}>{s.login}</Link>
                <small>
                  <i className="gdot" />
                  <span>
                    {GROUPS[s.camp].short} . {s.count > 1 ? `${s.count} times . ` : ""}
                    {agoWords(s.at, now)} . {s.inTop ? "on the list" : s.rank ? `#${s.rank} in the pool` : "not in the pool"}
                  </span>
                </small>
              </div>
              <p className="ad-why">{s.why}</p>
              <div className="ad-act">
                <span className={`ad-st ${s.status}`}>{s.status}</span>
                {s.status !== "approved" && (
                  <button type="button" className="chip" onClick={() => mark(s.id, "approved")}>
                    approve
                  </button>
                )}
                {s.status !== "declined" && (
                  <button type="button" className="chip" onClick={() => mark(s.id, "declined")}>
                    decline
                  </button>
                )}
                {s.status !== "new" && (
                  <button type="button" className="chip" onClick={() => mark(s.id, "new")}>
                    undo
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="estate">
          <b>Nothing here.</b>
          <span>Suggestions from the list page and the lookup pages land here.</span>
        </div>
      )}
      <p className="footnote">
        Approving marks it for the owner; nothing is added automatically. {msg && <span className="sg-msg err">{msg}</span>}
      </p>
    </div>
  );
}
