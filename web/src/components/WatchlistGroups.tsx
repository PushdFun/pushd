"use client";

import { useState } from "react";
import Link from "next/link";
import { builderHref } from "@/lib/format";
import { GROUPS } from "@/lib/groups";
import type { WatchGroup } from "@/lib/types";

// The watchlist's groups, with a grep box that keeps the groups whose name, text or handles match.

export function WatchlistGroups({ groups, sample }: { groups: WatchGroup[]; sample: boolean }) {
  const [q, setQ] = useState("");
  const max = Math.max(1, ...groups.map((g) => g.count));
  const rows = groups.map((g) => {
    const G = GROUPS[g.group];
    const more = g.count - g.members.length;
    const text = [g.count, G.title, `watchlist/${G.slug}/`, G.about, ...g.members.map((m) => m.handle), more > 0 ? `+${more} more` : ""]
      .join(" ")
      .toLowerCase();
    return { g, G, more, text };
  });
  const v = q.trim().toLowerCase();
  const hit = (text: string) => !v || text.includes(v);
  const any = rows.some((r) => hit(r.text));

  return (
    <>
      <div className="wl-tools">
        <label className="search">
          <span>grep</span>
          <input type="search" placeholder="a group or a handle" aria-label="Search the watchlist" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {sample && <span className="tag sample">Sample counts and handles. Full list at launch.</span>}
      </div>
      <div className="groups">
        {rows.map(({ g, G, more, text }) => (
          <article key={g.group} className={hit(text) ? "panel group" : "panel group hide"}>
            <div className="count">{g.count}</div>
            <div className="gname">
              <h3>{G.title}</h3>
              <div className="slug">watchlist/{G.slug}/</div>
            </div>
            <p>{G.about}</p>
            <div className="members">
              {g.members.map((m) => (
                <Link key={m.handle} className={m.sample ? "member" : "member real"} href={builderHref(m.handle)}>
                  {m.handle}
                </Link>
              ))}
              {more > 0 && (
                <a className="member more" href="#everyone">
                  +{more} more
                </a>
              )}
            </div>
            <div className="cbar" aria-hidden="true">
              <i style={{ width: `${Math.round((g.count / max) * 100)}%` }}></i>
            </div>
          </article>
        ))}
        <p className="muted mono" hidden={any} style={{ padding: "24px 0" }}>
          grep: no match. Try a group name or a handle.
        </p>
      </div>
    </>
  );
}
