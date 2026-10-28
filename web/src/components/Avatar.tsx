"use client";

import { useState } from "react";
import { avatarColor } from "@/lib/cards";
import { bare } from "@/lib/format";

// A builder's picture: their GitHub picture through this site (/avatar/<handle>), or their initial on a steady colour
// when there is none. Sample handles are made up: they always get the initial, and nothing is asked for.

export function Avatar({ handle, sample = false, size = 40, className = "" }: { handle: string; sample?: boolean; size?: number; className?: string }) {
  const h = bare(handle);
  const [failed, setFailed] = useState(sample);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.44) };
  if (failed)
    return (
      <span className={`av av-i ${className}`} style={{ ...style, background: avatarColor(h) }} aria-hidden="true">
        {h.charAt(0).toUpperCase()}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small stored picture with a drawn fallback
    <img
      className={`av ${className}`}
      src={`/avatar/${encodeURIComponent(h)}`}
      alt=""
      width={size}
      height={size}
      style={style}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      ref={(img) => {
        if (img && img.complete && img.naturalWidth === 0) setFailed(true);
      }}
    />
  );
}
