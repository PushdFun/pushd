"use client";

import { TokenTag } from "./TokenBox";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { ago } from "@/lib/format";
import { KIND_LABEL } from "@/lib/groups";
import type { FeedItem } from "@/lib/types";
import { Heat } from "./Heat";
import { GitHubLink, ItemDetail, grpLine, repoName } from "./ItemDetail";
import { ScoutTag } from "./ScoutRead";
import { typeIn } from "./typing";

// The log: one line per item, and each line opens its raw details in place. A line named in the address
// (#dts02-6502-signer) starts open. The filters live in the filter row above it (FilterBar), shared with the gallery.

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function FeedList({ items, asOf, matches, reset, live = false, fresh = [] }: { items: FeedItem[]; asOf: string; matches: (it: FeedItem) => boolean; reset: () => void; live?: boolean; fresh?: string[] }) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const hash = useSyncExternalStore(subscribeHash, () => decodeURIComponent(location.hash.slice(1)), () => "");

  const shown = items.filter(matches).length;
  const isOpen = (id: string) => toggled[id] ?? hash === id;
  const allSample = items.length > 0 && items.every((it) => it.sample);
  const newest = items.reduce<FeedItem | null>((a, it) => (!a || Date.parse(it.githubAt) > Date.parse(a.githubAt) ? it : a), null);

  return (
    <>
      <div className={shown === 0 ? "feed is-empty" : "feed"}>
        <div className="feed-head" aria-hidden="true">
          <span>ago</span>
          <span>kind</span>
          <span>who / what</span>
          <span>heat</span>
          <span></span>
        </div>
        <div>
          {items.map((it, i) => {
            const open = isOpen(it.id);
            return (
              <article
                key={it.id}
                id={it.id}
                className={`item typing${it === newest ? " new" : ""}${open ? " open" : ""}${fresh.includes(it.id) ? " just-in" : ""}`}
                style={typeIn(i, { start: 0.15, step: 0.16, dur: 0.45 })}
                hidden={!matches(it)}
              >
                <button
                  className="item-row"
                  type="button"
                  aria-expanded={open}
                  aria-controls={`${it.id}-d`}
                  onClick={() => setToggled({ ...toggled, [it.id]: !open })}
                >
                  <span className="ago">{ago(it.githubAt, asOf)}</span>
                  <span className="kind">{KIND_LABEL[it.kind]}</span>
                  <span className="main">
                    <span className="who">
                      <span className="h">{it.handle}</span>
                      <span className="sl">/</span>
                      <span className="r">{repoName(it)}</span>
                      <TokenTag token={it.token} />
                    </span>
                    <span className="sum" style={{ display: "block" }}>
                      {it.summary}
                    </span>
                    <span className="grp" style={{ display: "block" }}>
                      {grpLine(it)}
                    </span>
                    {it.call && <ScoutTag call={it.call} />}
                  </span>
                  <Heat heat={it.heat} />
                  <span className="chev" aria-hidden="true">
                    &gt;
                  </span>
                </button>
                <div className="detail" id={`${it.id}-d`}>
                  <ItemDetail
                    item={it}
                    asOf={asOf}
                    links={
                      <>
                        <GitHubLink item={it} />
                        <Link href={`/feed/${it.id}`}>Permalink /feed/{it.id}</Link>
                      </>
                    }
                  />
                </div>
              </article>
            );
          })}
        </div>
        <div className="empty">
          {items.length === 0 ? (
            "no lines yet. the watcher has nothing public to show right now."
          ) : (
            <>
              no lines match.{" "}
              <button className="chip" type="button" onClick={reset}>
                reset filters
              </button>
            </>
          )}
        </div>
        <div className="feed-foot">
          <span>
            showing <b>{shown}</b> of {items.length} {allSample ? "sample lines" : "lines"}{" "}
            <span className="cursor" aria-hidden="true"></span>
          </span>
          {live ? (
            <Link className="textlink" href="/holders#mine">
              your watchlist and alerts -&gt;
            </Link>
          ) : (
            <Link className="textlink" href="/holders">
              holders see this live -&gt;
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
