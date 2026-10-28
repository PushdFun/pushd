"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { FeedItem } from "@/lib/types";

// Sound mode: a soft terminal tick when a new line arrives, and a stronger two-note one for a hot line (high heat and
// up). Off by default; the choice is remembered in this browser ("pushd-sound") and every toggle on the page follows
// it (the "pushd:sound" event). The sounds are made on the spot with the Web Audio API: no files are loaded.

export const SOUND_KEY = "pushd-sound";
const EVENT = "pushd:sound";

function read(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}
let memory: boolean | null = null;
const isOn = () => memory ?? read();

function subscribe(onChange: () => void) {
  // another tab changed it: read it again from storage
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SOUND_KEY) return;
    memory = null;
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setSound(on: boolean) {
  memory = on;
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One short blip: a square-ish tick, quickly faded. */
function blip(a: AudioContext, at: number, freq: number, gain: number, dur: number) {
  const o = a.createOscillator();
  const g = a.createGain();
  const f = a.createBiquadFilter();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, at);
  f.type = "lowpass";
  f.frequency.value = 2400;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(f).connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** The tick for a line: soft, or two rising notes for a hot one. */
export function playFor(heat: FeedItem["heat"] | "test") {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01;
  if (heat === "high" || heat === "veryHigh") {
    blip(a, t, 880, 0.09, 0.09);
    blip(a, t + 0.1, heat === "veryHigh" ? 1320 : 1175, 0.1, 0.14);
  } else blip(a, t, 1500, 0.035, 0.035);
}

/** Plays the tick for every new line while sound mode is on. Draws nothing; mount it once. */
export function SoundPlayer() {
  useEffect(() => {
    const on = (e: Event) => {
      if (!isOn() || document.visibilityState === "hidden") return;
      const it = (e as CustomEvent<FeedItem>).detail;
      playFor(it?.heat ?? "low");
    };
    window.addEventListener("pushd:item", on);
    return () => window.removeEventListener("pushd:item", on);
  }, []);
  return null;
}

/** The switch: a small speaker button. `label` shows the word next to it (for a status bar). */
export function SoundToggle({ label = false }: { label?: boolean }) {
  const on = useSyncExternalStore(subscribe, isOn, () => false);
  const flip = () => {
    setSound(!on);
    // a click is the gesture browsers need before any sound; a short tick says it is on
    if (!on) playFor("test");
  };
  return (
    <button
      className={`${label ? "pill sound-pill" : "ico"} sound-btn${on ? " on" : ""}`}
      type="button"
      aria-pressed={on}
      aria-label={on ? "Sound on: turn off the tick for new lines" : "Sound off: play a tick for new lines"}
      title={on ? "Sound on" : "Sound off"}
      onClick={flip}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
        {on ? <path className="waves" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <path d="M16 9.5l5 5M21 9.5l-5 5" />}
      </svg>
      {label && <span>{on ? "sound on" : "sound off"}</span>}
    </button>
  );
}

/** Is sound mode on in this browser? */
export const soundOn = () => isOn();
