"use client";

import { useEffect } from "react";

// Registers the service worker (public/sw.js): the installed app's offline page and alerts with PUSHD closed. In the
// built site only, or on any page opened with ?sw=1 (to try it on the dev server). A browser that blocks it simply
// goes without: nothing on the site depends on it.
export function AppShell() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const wanted = process.env.NODE_ENV === "production" || new URLSearchParams(location.search).has("sw");
    if (!wanted) return;
    const go = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    if (document.readyState === "complete") void go();
    else {
      window.addEventListener("load", go, { once: true });
      return () => window.removeEventListener("load", go);
    }
  }, []);
  return null;
}
