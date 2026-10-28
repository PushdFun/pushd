import type { CSSProperties } from "react";

// The typing-in effect: lines of a log type themselves in, one after another. It is all CSS (.typing in
// globals.css): each line gets its own start and length here, so it runs from the first paint with no script, and
// prefers-reduced-motion turns the animation off, which leaves every line simply shown.

/** The style for line `i` of a log that starts at `start` seconds and adds `step` seconds per line. */
export function typeIn(i: number, { start, step, dur }: { start: number; step: number; dur: number }): CSSProperties {
  return { "--d": `${+(start + i * step).toFixed(2)}s`, "--dur": `${dur}s` } as CSSProperties;
}
