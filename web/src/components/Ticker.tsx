"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { ago } from "@/lib/format";
import { HEAT_CLASS, KIND_LABEL } from "@/lib/groups";
import type { FeedItem } from "@/lib/types";

// The ticker under the header on the home page: the latest lines scrolling by, newest first. A line that arrives
// through the stream ("pushd:item") joins at the front, marked fresh. Hovering stops it; reduced motion makes it a
// plain row that scrolls by hand.

type Tick = Pick<FeedItem, "id" | "handle" | "repo" | "version" | "kind" | "heat" | "githubAt" | "sample"> & { fresh?: boolean };

export function Ticker({ items, asOf, label }: { items: Tick[]; asOf: string; label: string }) {
  const [list, setList] = useState<Tick[]>(items);
  const [now, setNow] = useState(asOf);
  useEffect(() => {
    const on = (e: Event) => {
      const it = (e as CustomEvent<FeedItem>).detail;
      if (!it?.id) return;
      setNow(new Date().toISOString());
      setList((cur) => [{ ...it, fresh: true }, ...cur.filter((c) => c.id !== it.id)].slice(0, 16));
    };
    window.addEventListener("pushd:item", on);
    return () => window.removeEventListener("pushd:item", on);
  }, []);
  if (!list.length) return null;
  const row = (dup: boolean) =>
    list.map((it) => (
      <Link key={`${dup ? "b" : "a"}-${it.id}`} href={`/feed/${it.id}`} className={it.fresh ? "ticker-item fresh" : "ticker-item"} tabIndex={dup ? -1 : undefined} aria-hidden={dup || undefined}>
        <span className={`gheat ${HEAT_CLASS[it.heat]}`}>
          <i aria-hidden="true"></i>
        </span>
        <span className="kind">{KIND_LABEL[it.kind]}</span>
        <b>{it.handle}</b>
        <span className="r">{it.version ? `${it.repo} ${it.version}` : it.repo}</span>
        <span>{ago(it.githubAt, now)}</span>
        {it.sample && <span className="tag sample">Sample</span>}
      </Link>
    ));
  return (
    <div className="ticker-bar" aria-label="Latest lines">
      <div className="ticker-tag">
        <span className="dotlive" aria-hidden="true"></span>
        {label}
        <small>latest lines</small>
      </div>
      <div className="ticker-run">
        <div className="ticker-track" style={{ "--tdur": `${Math.max(30, list.length * 7)}s` } as CSSProperties}>
          {row(false)}
          {row(true)}
        </div>
      </div>
    </div>
  );
}
