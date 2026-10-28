"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { Clock } from "./Clock";
import { Heat } from "./Heat";
import { repoName } from "./ItemDetail";
import { SoundToggle } from "./Sound";
import { TokenTag } from "./TokenBox";
import { agoWords } from "@/lib/format";
import { KIND_LABEL, KIND_VERB } from "@/lib/groups";
import { SCOUT_BY_ID } from "@/lib/scouts";
import type { FeedItem } from "@/lib/types";

// The home page's panel: what the watched projects pushed just now, a few large rows, newest first. On top, the
// hottest line of the day with its scout's one-line read. A new line from the stream (the "pushd:item" event, public
// or a holder's live one) slides in at the top and the oldest row goes.

const ROWS = 5;

export function RightNow({ items, featured, asOf, label, sample = false }: { items: FeedItem[]; featured: FeedItem | null; asOf: string; label: string; sample?: boolean }) {
  const [rows, setRows] = useState<(FeedItem & { fresh?: boolean })[]>(items.slice(0, ROWS));
  const [now, setNow] = useState(asOf);

  useEffect(() => {
    const on = (e: Event) => {
      const it = (e as CustomEvent<FeedItem>).detail;
      if (!it?.id) return;
      setNow(new Date().toISOString());
      // one row per repo and kind, like the server's list: the new line replaces an older one about the same repo
      const same = (r: FeedItem) => r.id === it.id || (r.handle === it.handle && r.repo === it.repo && r.kind === it.kind);
      setRows((cur) => [{ ...it, fresh: true }, ...cur.filter((r) => !same(r))].slice(0, ROWS));
    };
    window.addEventListener("pushd:item", on);
    return () => window.removeEventListener("pushd:item", on);
  }, []);

  const since = (at: string) => agoWords(at, now).replace(" ago", "");
  const feat = featured;
  const read = feat?.call?.line ?? feat?.summary ?? null;
  const scout = feat?.call ? SCOUT_BY_ID[feat.call.scout] : null;

  return (
    <div className="term now-term" aria-label="What the watched projects pushed just now">
      <div className="term-bar">
        <div className="tabs">
          <span className="tab on">right now</span>
        </div>
        <div className="right">
          {sample ? <span className="tag sample">Sample</span> : <span className="tag live">{label}</span>}
          <SoundToggle />
          <span>
            UTC <Clock />
          </span>
        </div>
      </div>
      <div className="term-body">
        {feat && (
          <Link className="now-feat" href={`/feed/${feat.id}`}>
            <Avatar handle={feat.handle} sample={feat.sample} size={44} />
            <span className="fb">
              <span className="fk">
                <span className="acc">hottest today</span>
                <span className="ago">{since(feat.shownAt ?? feat.githubAt)}</span>
              </span>
              <span className="fh">
                <b>{feat.name ?? feat.handle}</b>
                <TokenTag token={feat.token} compact /> <span className="v">{KIND_VERB[feat.kind]}</span> <span className="repo">{repoName(feat)}</span>
              </span>
              {read && <span className="fr">{read}</span>}
              <span className="fm">
                <Heat heat={feat.heat} />
                {scout && <span>read by {scout.name}</span>}
              </span>
            </span>
          </Link>
        )}
        <ol className="now-list" aria-live="polite">
          {rows.map((it) => (
            <li key={it.id} className={it.fresh ? "in" : undefined}>
              <Link className="now-row" href={`/feed/${it.id}`} title={it.summary}>
                <Avatar handle={it.handle} sample={it.sample} size={36} />
                <span className="what">
                  <b>{it.name ?? it.handle}</b>
                  <TokenTag token={it.token} compact />
                  <span className="act">
                    {KIND_VERB[it.kind]} <span className="repo">{repoName(it)}</span>
                  </span>
                </span>
                <span className="meta">
                  <span className="kind">{KIND_LABEL[it.kind]}</span>
                  <Heat heat={it.heat} label={false} />
                  <span className="ago">{since(it.shownAt ?? it.githubAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
        <div className="now-foot">
          <span>{sample ? "sample lines until the watcher runs" : "new lines land here as they are pushed"}</span>
          <Link href="/feed">the full feed -&gt;</Link>
        </div>
      </div>
    </div>
  );
}
