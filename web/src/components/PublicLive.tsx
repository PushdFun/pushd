"use client";

import { useEffect } from "react";

// For everyone who is not a signed-in holder: the public stream (/api/stream, the engine at the public delay). Each new
// line is passed to the page as a "pushd:item" event, the same event the holder's live stream sends, so the feed, the
// ticker and the home panel insert it as it arrives. A signed-in holder's pages listen to the live stream instead
// (HolderLive), so this stays quiet for them.

const hinted = () => /(?:^|;\s*)pushd_holder_on=1(?:;|$)/.test(document.cookie);

export function PublicLive() {
  useEffect(() => {
    if (hinted() || typeof EventSource === "undefined") return;
    let es: EventSource | null = new EventSource("/api/stream");
    es.addEventListener("item", (e) => {
      try {
        window.dispatchEvent(new CustomEvent("pushd:item", { detail: JSON.parse((e as MessageEvent<string>).data) }));
      } catch {
        /* a broken line is skipped */
      }
    });
    // no engine (204) or a server error closes it for good; short drops are retried by the browser
    es.onerror = () => {
      if (es?.readyState === EventSource.CLOSED) es = null;
    };
    return () => es?.close();
  }, []);
  return null;
}
