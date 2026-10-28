"use client";

import { useSyncExternalStore } from "react";
import { MoonIcon, SunIcon } from "./Icons";

// The theme lives on <html data-theme>. A script in the page head sets it before paint from what was saved
// (src/app/layout.tsx); this button flips it and saves the choice. Storage can be blocked, so every touch is guarded.

export const THEME_KEY = "pushd-theme";

function subscribe(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => watch.disconnect();
}
const isLight = () => document.documentElement.getAttribute("data-theme") === "light";

export function ThemeToggle() {
  const light = useSyncExternalStore(subscribe, isLight, () => false);
  const flip = () => {
    const next = isLight() ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  };
  return (
    <button
      className="ico theme-btn"
      type="button"
      aria-pressed={light}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      title={light ? "Dark theme" : "Light theme"}
      onClick={flip}
    >
      <MoonIcon />
      <SunIcon />
    </button>
  );
}
