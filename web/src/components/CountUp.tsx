"use client";

import { useEffect, useRef, useState } from "react";

// A number that counts up from zero the first time it is on screen, and ticks up again when a live line arrives
// (`live`: it listens for the "pushd:item" event). With reduced motion it simply shows the number.

export function CountUp({ value, live = false, ms = 1100 }: { value: number; live?: boolean; ms?: number }) {
  const [shown, setShown] = useState(value);
  const [extra, setExtra] = useState(0);
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches || value <= 0) return;
    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      setShown(0);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        run();
      }
    });
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, ms]);
  useEffect(() => {
    if (!live) return;
    const on = () => setExtra((n) => n + 1);
    window.addEventListener("pushd:item", on);
    return () => window.removeEventListener("pushd:item", on);
  }, [live]);
  return (
    <span ref={el} className={extra ? "countup bumped" : "countup"} key={extra}>
      {(shown + extra).toLocaleString("en-US")}
    </span>
  );
}
