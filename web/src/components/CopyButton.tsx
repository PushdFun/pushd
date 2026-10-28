"use client";

import { useState } from "react";

/** Copies a value (an address) and says so for two seconds. Clipboard can be blocked: then it says that. */
export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid("copied");
    } catch {
      setSaid("copy blocked");
    }
    setTimeout(() => setSaid(null), 2000);
  };
  return (
    <button className="cop on" type="button" onClick={copy} aria-label={`Copy ${text}`}>
      {said ?? label}
    </button>
  );
}
