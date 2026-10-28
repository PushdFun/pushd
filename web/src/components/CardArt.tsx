"use client";

import { useState } from "react";
import { artFor, avatarColor, drawnStats, ownerOf } from "@/lib/cards";
import type { FeedItem } from "@/lib/types";

// The picture on top of a gallery card (src/lib/cards.ts picks which). The repo's real preview when the engine has
// it; if that picture fails to load, at any point, the drawn GitHub-style card takes its place.

/** A GitHub-style repo card, drawn from the line itself: owner/, the repo, the plain line, and an initial. */
export function DrawnCard({ item }: { item: FeedItem }) {
  const owner = ownerOf(item);
  const tall = item.summary.length > 46;
  return (
    <div className={tall ? "fakeog tall" : "fakeog"}>
      <div className="fo-l">
        <div className="fo-owner">{`${owner}/`}</div>
        <div className="fo-repo">{item.repo}</div>
        <div className="fo-desc">{item.summary}</div>
        <div className="fo-stats">
          {drawnStats(item).map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </div>
      <div className="fo-av" style={{ background: avatarColor(owner) }} aria-hidden="true">
        {owner.charAt(0).toUpperCase()}
      </div>
    </div>
  );
}

function Preview({ item, src }: { item: FeedItem; src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <DrawnCard item={item} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a stored picture served as is, with a drawn fallback
    <img
      src={src}
      alt={`GitHub preview of ${ownerOf(item)}/${item.repo}`}
      width={1200}
      height={600}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      // a picture that failed before the page woke up never fires onError: look once it is attached
      ref={(img) => {
        if (img && img.complete && img.naturalWidth === 0) setFailed(true);
      }}
    />
  );
}

export function CardArt({ item }: { item: FeedItem }) {
  const art = artFor(item);
  switch (art.type) {
    case "image":
      return (
        <div className="gart img">
          <Preview item={item} src={art.src} />
        </div>
      );
    case "release":
      return (
        <div className="gart rel-art">
          <div className="rel">
            <span className={art.version.length > 7 ? "v long" : "v"}>{art.version}</span>
            <small>release</small>
          </div>
        </div>
      );
    case "gist":
      return (
        <div className="gart gist-art">
          <pre className={`gterm big${art.line.length > 9 ? " mid" : ""}${art.line.length > 18 ? " small" : ""}`}>{art.line}</pre>
        </div>
      );
    case "terminal":
      return (
        <div className="gart term-art">
          <pre className="gterm">{art.lines.join("\n")}</pre>
        </div>
      );
    default:
      return (
        <div className="gart drawn">
          <DrawnCard item={item} />
        </div>
      );
  }
}
