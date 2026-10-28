"use client";

import Link from "next/link";
import { useState } from "react";
import { agoWords } from "@/lib/format";
import { HEAT_CLASS, KIND_LABEL } from "@/lib/groups";
import { callHeat, SCOUT_BY_ID, VERDICT_LABEL } from "@/lib/scouts";
import type { FeedItem } from "@/lib/types";
import { useFollowed } from "./FollowScout";
import { repoName } from "./ItemDetail";
import { ScoutAvatar } from "./ScoutAvatar";
import { SourceTag } from "./ScoutRead";

/** The latest calls, newest first, with a switch to the scouts this browser follows. */
export function ScoutCalls({ items, asOf, filter = true, empty }: { items: FeedItem[]; asOf: string; filter?: boolean; empty?: string }) {
  const followed = useFollowed();
  const [mine, setMine] = useState(false);
  const shown = items.filter((it) => it.call && (!mine || followed.includes(it.call.scout)));
  return (
    <div className="scalls">
      {filter && (
        <div className="scalls-bar" role="group" aria-label="Which calls">
          <button type="button" className={mine ? "chip" : "chip on"} aria-pressed={!mine} onClick={() => setMine(false)}>
            All scouts
          </button>
          <button type="button" className={mine ? "chip on" : "chip"} aria-pressed={mine} onClick={() => setMine(true)}>
            Scouts I follow <span className="n">{followed.length}</span>
          </button>
        </div>
      )}
      {shown.length === 0 ? (
        <div className="estate">
          <b>{mine ? (followed.length ? "No calls from the scouts you follow yet." : "You follow no scout yet.") : (empty ?? "No calls yet.")}</b>
          <span>{mine && !followed.length ? "Press follow on a scout above. It is kept in this browser, and in your prefs when you are signed in as a holder." : "Calls land here as the scouts make them."}</span>
        </div>
      ) : (
        <ol className="scall-list">
          {shown.slice(0, 40).map((it) => {
            const c = it.call!;
            const s = SCOUT_BY_ID[c.scout];
            return (
              <li key={it.id} className={`scall g-${s.camp}`}>
                <Link href={`/scouts/${s.id}`} className="scall-av" aria-label={s.name}>
                  <ScoutAvatar id={s.id} size={40} />
                </Link>
                <div className="scall-main">
                  <div className="scall-top">
                    <span>
                      <Link href={`/scouts/${s.id}`} className="scall-name">
                        {s.name}
                      </Link>{" "}
                      <span className="muted">on</span>{" "}
                      <Link href={`/feed/${it.id}`} className="scall-what">
                        {it.handle} <span className="sl">/</span> <span className="r">{repoName(it)}</span>
                      </Link>
                    </span>
                    <span className={`scall-heat h-${HEAT_CLASS[callHeat(c.heat)]}`}>{c.heat}/10</span>
                  </div>
                  <p>{c.why}</p>
                  <div className="scall-meta">
                    <span className="kind">{KIND_LABEL[it.kind]}</span>
                    {c.verdict && <span className={`verdict v-${c.verdict}`}>{VERDICT_LABEL[c.verdict]}</span>}
                    <SourceTag call={c} />
                    <span>called {agoWords(c.calledAt, asOf)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
