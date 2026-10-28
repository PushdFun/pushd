import { SCOUT_BY_ID } from "@/lib/scouts";
import type { ScoutId } from "@/lib/types";

// Each scout is an AI model, shown by its maker's own icon (web/public/scouts/<id>.svg) on a white rounded tile, the
// camp's colour (--g, see .g-chain and the rest in styles/v2.css) on the tile's edge.

/** A scout's icon. `size` in pixels; framed by default (a white tile with an edge in the camp's colour). */
export function ScoutAvatar({ id, size = 48, frame = true, className = "" }: { id: ScoutId; size?: number; frame?: boolean; className?: string }) {
  const s = SCOUT_BY_ID[id];
  const inner = Math.round(size * (frame ? 0.6 : 1));
  return (
    <span className={`savatar logo g-${s.camp}${frame ? " framed" : ""} ${className}`} style={{ width: size, height: size }} role="img" aria-label={`${s.name} by ${s.maker}, ${s.title}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/scouts/${id}.svg`} alt="" width={inner} height={inner} draggable={false} />
    </span>
  );
}
