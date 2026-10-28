"use client";

import { useSyncExternalStore } from "react";
import { utcTime } from "@/lib/format";

// A UTC clock that ticks once a second. The server draws a placeholder; the browser takes over on load.

function subscribe(onTick: () => void) {
  const t = setInterval(onTick, 1000);
  return () => clearInterval(t);
}
const now = () => utcTime(new Date().toISOString());

export function Clock() {
  return <>{useSyncExternalStore(subscribe, now, () => "--:--:--")}</>;
}
