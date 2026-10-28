import { TokenTag } from "./TokenBox";
import Link from "next/link";
import { ago } from "@/lib/format";
import { GROUPS, HEAT_CLASS, HEAT_LABEL, KIND_LABEL } from "@/lib/groups";
import type { FeedItem, Heat } from "@/lib/types";
import { CardArt } from "./CardArt";
import { repoName } from "./ItemDetail";
import { ScoutTag } from "./ScoutRead";

// The gallery: every line as a card in a masonry of columns (3, 2 or 1 by width). Each card opens the line's page.

/** The glowing heat dot and its word. */
export function HeatDot({ heat }: { heat: Heat }) {
  return (
    <span className={`gheat ${HEAT_CLASS[heat]}`} aria-label={`Heat: ${HEAT_LABEL[heat]}`}>
      <i aria-hidden="true"></i>
      {HEAT_LABEL[heat]}
    </span>
  );
}

export function GalleryCard({ item, asOf }: { item: FeedItem; asOf: string }) {
  return (
    <article className="gcard" id={item.id}>
      <Link className="gcard-in" href={`/feed/${item.id}`}>
        <CardArt item={item} />
        <div className="gbody">
          <div className="gtop">
            <span className="gkind">{KIND_LABEL[item.kind]}</span>
            <span className="gago">{ago(item.githubAt, asOf)}</span>
          </div>
          <div className="gwho">
            <b>{item.handle}</b> <span className="sl">/</span> <span className="grepo">{repoName(item)}</span>
            <TokenTag token={item.token} />
          </div>
          <p>{item.summary}</p>
          <div className="gfoot">
            <span className="ggroup">
              {GROUPS[item.group].mid}
              {item.sample && <span className="gsample"> . Sample</span>}
            </span>
            <HeatDot heat={item.heat} />
          </div>
          {item.call && <ScoutTag call={item.call} />}
        </div>
      </Link>
    </article>
  );
}

export function Gallery({ items, asOf }: { items: FeedItem[]; asOf: string }) {
  return (
    <div className="masonry">
      {items.map((it) => (
        <GalleryCard key={it.id} item={it} asOf={asOf} />
      ))}
    </div>
  );
}
