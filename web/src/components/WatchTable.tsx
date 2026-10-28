"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ago, bare, builderHref, num } from "@/lib/format";
import { GROUPS, GROUP_ORDER } from "@/lib/groups";
import type { BuilderStats, GroupKey } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Sparkline } from "./Charts";

// Everyone on the watchlist in one table: sort by activity, recency, lines or name; filter by camp and a few letters;
// tick two or three to compare them side by side.

type Sort = "active" | "recent" | "lines" | "name";

export function WatchTable({ builders, asOf }: { builders: BuilderStats[]; asOf: string }) {
  const [sort, setSort] = useState<Sort>("active");
  const [group, setGroup] = useState<GroupKey | "all">("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const rows = useMemo(() => {
    const v = q.trim().toLowerCase();
    const list = builders.filter((b) => (group === "all" || b.group === group) && (!v || [b.handle, b.name, b.org].join(" ").toLowerCase().includes(v)));
    const by: Record<Sort, (a: BuilderStats, b: BuilderStats) => number> = {
      active: (a, b) => b.events7d - a.events7d || b.items - a.items,
      recent: (a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
      lines: (a, b) => b.items - a.items || b.catches - a.catches,
      name: (a, b) => bare(a.handle).localeCompare(bare(b.handle)),
    };
    return [...list].sort(by[sort]);
  }, [builders, sort, group, q]);
  const toggle = (h: string) => setPicked((p) => (p.includes(h) ? p.filter((x) => x !== h) : p.length >= 3 ? [...p.slice(1), h] : [...p, h]));

  return (
    <>
      <div className="wtable-tools">
        <div className="pills">
          <button className={group === "all" ? "pill on" : "pill"} type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>
            All <span style={{ opacity: 0.6, marginLeft: 6 }}>{builders.length}</span>
          </button>
          {GROUP_ORDER.map((g) => (
            <button key={g} className={group === g ? "pill on" : "pill"} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
              {GROUPS[g].chip}
            </button>
          ))}
        </div>
        <label className="fsearch">
          <span>grep</span>
          <input type="search" placeholder="a handle or a name" aria-label="Search the watchlist" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="panel" style={{ overflow: "hidden" }}>
        <table className="wtable">
          <thead>
            <tr>
              <th className="hide-s" style={{ width: 36 }}>
                <span className="sr">compare</span>
              </th>
              <th>
                <button type="button" aria-pressed={sort === "name"} onClick={() => setSort("name")}>
                  builder
                </button>
              </th>
              <th className="hide-m">camp</th>
              <th>
                <button type="button" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>
                  last seen
                </button>
              </th>
              <th className="hide-s">14 days</th>
              <th className="n">
                <button type="button" aria-pressed={sort === "active"} onClick={() => setSort("active")}>
                  7 days
                </button>
              </th>
              <th className="n hide-s">
                <button type="button" aria-pressed={sort === "lines"} onClick={() => setSort("lines")}>
                  lines
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.handle}>
                <td className="hide-s">
                  <input type="checkbox" checked={picked.includes(bare(b.handle))} onChange={() => toggle(bare(b.handle))} aria-label={`Compare ${b.handle}`} />
                </td>
                <td>
                  <span className="wb">
                    <Avatar handle={b.handle} sample={b.sample} size={32} />
                    <span style={{ minWidth: 0 }}>
                      <Link href={builderHref(b.handle)}>{b.handle}</Link>
                      <small>{b.name && b.name !== b.handle ? b.name : b.org ?? ""}</small>
                    </span>
                  </span>
                </td>
                <td className={`hide-m g-${b.group}`}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <i className="gdot" /> {GROUPS[b.group].short}
                  </span>
                </td>
                <td className={b.lastActiveAt ? undefined : "muted"}>{b.lastActiveAt ? `${ago(b.lastActiveAt, asOf)} ago` : b.read ? "quiet" : "not read yet"}</td>
                <td className="hide-s">
                  <Sparkline values={b.spark} label={`${b.handle}, 14 days`} />
                </td>
                <td className="n">
                  <b>{num(b.events7d)}</b>
                </td>
                <td className="n hide-s">
                  {num(b.items)}
                  {b.catches > 0 && <span style={{ color: "var(--heat-vhigh)" }}> . {b.catches} hot</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 28, textAlign: "center" }}>
                  grep: no match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {picked.length > 0 && (
        <div className="cmpbar" role="status">
          <span>
            compare: <b>{picked.join(", ")}</b> {picked.length < 2 && <span className="muted">(pick one or two more)</span>}
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="pill" type="button" onClick={() => setPicked([])}>
              clear
            </button>
            {picked.length >= 2 && (
              <Link className="btn btn-acc" style={{ height: 36 }} href={`/compare?b=${picked.join(",")}`}>
                Compare -&gt;
              </Link>
            )}
          </span>
        </div>
      )}
    </>
  );
}
