"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { FOLLOW_KEY, isScoutId, SCOUT_BY_ID } from "@/lib/scouts";
import type { HolderView, ScoutId } from "@/lib/types";

// Following a scout. Kept in this browser (localStorage); for a signed-in holder also in their prefs on the engine,
// so it follows them to another device. Storage can be blocked: then following lasts until the page closes.

let memory: ScoutId[] = [];
const EVENT = "pushd:scouts";

function read(): ScoutId[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(isScoutId) : [];
  } catch {
    return memory;
  }
}
let cache: { raw: string; list: ScoutId[] } = { raw: "", list: [] };
function snapshot(): ScoutId[] {
  const list = read();
  const raw = list.join(",");
  if (raw !== cache.raw) cache = { raw, list };
  return cache.list;
}
function write(list: ScoutId[]) {
  memory = list;
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(list));
  } catch {
    /* blocked storage: kept in memory */
  }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(fn: () => void) {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}
const EMPTY: ScoutId[] = [];

/** The scouts this browser follows. */
export function useFollowed(): ScoutId[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

const hinted = () => /(?:^|;\s*)pushd_holder_on=1(?:;|$)/.test(document.cookie);

/** Once per page: a signed-in holder's saved scouts join this browser's list. */
let synced = false;
function useHolderSync() {
  useEffect(() => {
    if (synced || !hinted()) return;
    synced = true;
    void fetch("/api/holder/me", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<HolderView>) : null))
      .then((me) => {
        const saved = me?.prefs?.scouts ?? [];
        const merged = [...new Set([...read(), ...saved.filter(isScoutId)])];
        if (merged.length !== read().length) write(merged);
      })
      .catch(() => undefined);
  }, []);
}

async function saveToHolder(list: ScoutId[]): Promise<boolean> {
  if (!hinted()) return false;
  const r = await fetch("/api/holder/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ scouts: list }) }).catch(() => null);
  return !!r?.ok;
}

export function FollowScout({ id, size = "md" }: { id: ScoutId; size?: "sm" | "md" }) {
  const list = useFollowed();
  useHolderSync();
  const [note, setNote] = useState<string | null>(null);
  const on = list.includes(id);
  const name = SCOUT_BY_ID[id].name;
  const flip = async () => {
    const next = on ? list.filter((x) => x !== id) : [...list, id];
    write(next);
    const saved = await saveToHolder(next);
    setNote(saved ? "saved to your holder prefs" : null);
  };
  return (
    <button type="button" className={`follow-btn ${size}${on ? " on" : ""}`} aria-pressed={on} onClick={flip} title={note ?? (on ? `Stop following ${name}` : `Follow ${name}`)}>
      <span aria-hidden="true">{on ? "✓" : "+"}</span>
      {on ? "following" : "follow"}
      <span className="sr">{name}</span>
    </button>
  );
}
