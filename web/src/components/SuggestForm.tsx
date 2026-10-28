"use client";

import { useState } from "react";
import { GROUPS, GROUP_ORDER } from "@/lib/groups";
import { validLogin } from "@/lib/lookup";
import type { GroupKey } from "@/lib/types";

// Suggest a builder: a login, a camp and one line on why. The engine stores it for the owner, rate limited; nothing is
// added to the list by itself.

export function SuggestForm({ login = "", camp = "oss", compact = false }: { login?: string; camp?: GroupKey; compact?: boolean }) {
  const [who, setWho] = useState(login);
  const [group, setGroup] = useState<GroupKey>(camp);
  const [why, setWhy] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "ok" | "err"; text: string }>({ kind: "idle", text: "" });

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const l = who.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/.*$/, "");
    if (!validLogin(l)) return setState({ kind: "err", text: "That is not a GitHub username." });
    if (why.trim().length < 8) return setState({ kind: "err", text: "Say in one line why (a few words at least)." });
    setState({ kind: "busy", text: "sending" });
    const res = await fetch("/api/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, camp: group, why: why.trim() }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; message?: string }) : {};
    if (res?.ok) {
      setState({ kind: "ok", text: body.message ?? "Thanks. The owner reads every suggestion." });
      setWhy("");
    } else if (res?.status === 429) setState({ kind: "err", text: body.error ?? "That is a lot of suggestions from here. Try again later." });
    else setState({ kind: "err", text: body.error ?? "Not sent. Try again in a minute." });
  };

  return (
    <form className={compact ? "suggest compact" : "suggest"} onSubmit={send}>
      <div className="sg-fields">
        <label className="sg-f">
          <span className="k">github login</span>
          <input className="sg-in" value={who} onChange={(e) => (setWho(e.target.value), setState({ kind: "idle", text: "" }))} placeholder="username or org" maxLength={60} autoComplete="off" spellCheck={false} required />
        </label>
        <label className="sg-f">
          <span className="k">camp</span>
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value as GroupKey)}>
            {GROUP_ORDER.map((g) => (
              <option key={g} value={g}>
                {GROUPS[g].title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="sg-f">
        <span className="k">why, in one line</span>
        <input className="sg-in" value={why} onChange={(e) => (setWhy(e.target.value), setState({ kind: "idle", text: "" }))} placeholder="what they build and why people watch it" maxLength={140} required />
      </label>
      <div className="sg-foot">
        <button className="btn btn-acc" type="submit" disabled={state.kind === "busy"}>
          Suggest
        </button>
        <span role="status" className={`sg-msg ${state.kind}`}>
          {state.text || "Nothing is added by itself: the owner looks at every one."}
        </span>
      </div>
    </form>
  );
}
