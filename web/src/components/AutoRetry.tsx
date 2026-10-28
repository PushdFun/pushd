"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// A gentle retry for a page GitHub was too busy to build: it counts down and looks again by itself, at most three times,
// then leaves a plain button. Never a spinner that goes on forever.

const MAX_TRIES = 3;

export function AutoRetry({ seconds }: { seconds: number }) {
  const router = useRouter();
  const wait = Math.max(10, Math.min(120, Math.round(seconds)));
  const [view, setView] = useState({ left: wait, tries: 0 });
  const live = useRef({ left: wait, tries: 0 });
  const [run, setRun] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      const s = live.current;
      if (s.tries >= MAX_TRIES) return clearInterval(t);
      if (s.left > 1) s.left -= 1;
      else {
        s.left = wait;
        s.tries += 1;
        router.refresh();
      }
      setView({ ...s });
    }, 1000);
    return () => clearInterval(t);
  }, [wait, router, run]);

  const now = () => {
    live.current = { left: wait, tries: 0 };
    setView({ left: wait, tries: 0 });
    setRun((r) => r + 1);
    router.refresh();
  };

  return (
    <span className="retry" role="status">
      {view.tries < MAX_TRIES ? <>Looking again in {view.left} s.</> : <>Still busy.</>}
      <button type="button" className="btn btn-line" onClick={now}>
        Try now
      </button>
    </span>
  );
}
