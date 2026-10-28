"use client";

import { useState } from "react";

/** The day's post as plain text, and a button that copies it (for X, pasted by hand; nothing is sent anywhere). */
export function CopyPost({ text }: { text: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid("Copied. Paste it on X.");
    } catch {
      setSaid("The browser blocked the copy. Select the text instead.");
    }
    setTimeout(() => setSaid(null), 3000);
  };
  return (
    <div className="cpost">
      <div className="cpost-h">
        <span>post.txt</span>
        <span>{text.length} / 280</span>
      </div>
      <pre className="cpost-t">{text}</pre>
      <div className="cpost-f">
        <button type="button" className="btn btn-acc" onClick={copy}>
          Copy as post
        </button>
        <span role="status" className="cpost-s">
          {said ?? "Text only. Paste it wherever you like."}
        </span>
      </div>
    </div>
  );
}
