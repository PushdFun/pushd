"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { bare, builderHref } from "@/lib/format";
import { GROUPS, GROUP_ORDER } from "@/lib/groups";
import { everyText, topReason } from "@/lib/lookup";
import type { GroupKey, RankRow } from "@/lib/types";
import { Avatar } from "./Avatar";
import { TokenTag } from "./TokenBox";
import { MoveChip, ScoreBar, ScoreBreakdown } from "./ScoreBreakdown";

// The list as a list: rank, movement, the project, its camp, its score and how often it is read. Each row opens
// (a plain <details>, so the keyboard works) to show the score's parts. Filter by camp and a few letters.

export function TopTable({ rows, label = "The list" }: { rows: RankRow[]; label?: string }) {
  const [group, setGroup] = useState<GroupKey | "all">("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const v = q.trim().toLowerCase().replace(/^@/, "");
    return rows.filter((r) => (group === "all" || r.group === group) && (!v || [r.handle, r.name, r.org].join(" ").toLowerCase().includes(v)));
  }, [rows, group, q]);
  const count = (g: GroupKey) => rows.filter((r) => r.group === g).length;

  return (
    <div className="top">
      <div className="wtable-tools">
        <div className="pills" role="group" aria-label="Filter by camp">
          <button className={group === "all" ? "pill on" : "pill"} type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>
            All <span className="pc">{rows.length}</span>
          </button>
          {GROUP_ORDER.map((g) => (
            <button key={g} className={group === g ? "pill on" : "pill"} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
              {GROUPS[g].chip} <span className="pc">{count(g)}</span>
            </button>
          ))}
        </div>
        <label className="fsearch">
          <span>grep</span>
          <input type="search" placeholder="a project or a name" aria-label={`Search ${label}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="panel top-list" aria-label={label}>
        <div className="top-head" aria-hidden="true">
          <span>#</span>
          <span>move</span>
          <span>project</span>
          <span className="hide-s">read</span>
          <span>score</span>
        </div>
        {shown.length === 0 && (
          <div className="estate" style={{ margin: 16 }}>
            <b>Nothing matches.</b>
            <span>Try another camp or fewer letters.</span>
          </div>
        )}
        <ol className="top-rows">
          {shown.map((r) => {
            const why = topReason(r);
            return (
              <li key={r.handle} className={`g-${r.group}`}>
                <details className="top-row">
                  <summary>
                    <span className="tr-rank">{r.rank}</span>
                    <MoveChip movement={r.movement} delta={r.delta} />
                    <span className="tr-who">
                      <Avatar handle={r.handle} sample={r.sample} size={30} />
                      <span className="tr-names">
                        <b>
                          {r.name ?? bare(r.handle)}
                          <TokenTag token={r.token} />
                        </b>
                        <small>
                          <i className="gdot" /> {GROUPS[r.group].short} . github.com/{bare(r.handle)}
                        </small>
                      </span>
                    </span>
                    <span className="tr-read hide-s">{r.checkEveryMin != null ? everyText(r.checkEveryMin) : "not read"}</span>
                    <span className="tr-score">
                      <ScoreBar score={r.score} />
                      <b>{r.score.toFixed(1)}</b>
                    </span>
                    <span className="tr-open" aria-hidden="true" />
                  </summary>
                  <div className="tr-body">
                    <div className="tr-meta">
                      {why && (
                        <span>
                          led by <b>{why}</b>
                        </span>
                      )}
                      {r.tier != null && <span>tier {r.tier}, read {everyText(r.checkEveryMin)}</span>}
                      <span>{r.type === "org" ? "org" : "person"}</span>
                      {!r.sample && (
                        <>
                          <Link className="textlink" href={builderHref(r.handle)}>
                            page -&gt;
                          </Link>
                          <a className="textlink" href={`https://github.com/${bare(r.handle)}`} target="_blank" rel="noopener noreferrer">
                            GitHub -&gt;
                          </a>
                        </>
                      )}
                    </div>
                    <ScoreBreakdown row={r} />
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
