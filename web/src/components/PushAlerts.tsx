"use client";

import { useCallback, useEffect, useState } from "react";

// Alerts with PUSHD closed: web push for a signed-in holder. This browser subscribes with the engine's key (through
// /api/holder/push/key), the subscription is saved for the holder's wallet (/api/holder/push), and the service worker
// (public/sw.js) shows each alert even when no PUSHD tab is open. The same heat and "only my list" choices as the
// alerts beside it. Until the server has its push keys the block says so and offers nothing.

export type PushState = "checking" | "off" | "unsupported" | "blocked" | "ready" | "on" | "busy";

const STATE_TEXT: Record<PushState, string> = {
  checking: "checking this browser",
  off: "not switched on yet",
  unsupported: "this browser has no push alerts",
  blocked: "blocked (change it in the browser's site settings)",
  ready: "off in this browser",
  on: "on in this browser",
  busy: "one moment",
};

/** The server's key, base64url, as the bytes a browser subscribes with. */
export function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function current(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** `demo`: draw one state as is (a sample, for the page that explains it); nothing is asked of the browser then. */
export function PushAlerts({ demo }: { demo?: PushState }) {
  const [state, setState] = useState<PushState>(demo ?? "checking");
  const [note, setNote] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!supported()) return setState("unsupported");
    const keyRes = await fetch("/api/holder/push/key", { cache: "no-store" }).catch(() => null);
    if (!keyRes?.ok) return setState("off");
    if (Notification.permission === "denied") return setState("blocked");
    const sub = await current().catch(() => null);
    setState(sub ? "on" : "ready");
  }, []);

  useEffect(() => {
    if (demo) return;
    // checked once the page is up; the browser answers asynchronously
    const t = setTimeout(() => void check(), 0);
    return () => clearTimeout(t);
  }, [check, demo]);

  const turnOn = async () => {
    if (demo) return;
    setState("busy");
    setNote(null);
    try {
      const keyRes = await fetch("/api/holder/push/key", { cache: "no-store" });
      if (!keyRes.ok) return setState("off");
      const { key } = (await keyRes.json()) as { key: string };
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      const res = await fetch("/api/holder/push", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        await sub.unsubscribe().catch(() => false);
        setNote(body.error ?? "Not saved. Try again in a minute.");
        return setState("ready");
      }
      setState("on");
    } catch {
      setNote("This browser did not allow it. On an iPhone, add PUSHD to the home screen first, then turn alerts on from there.");
      setState("ready");
    }
  };

  const turnOff = async () => {
    if (demo) return;
    setState("busy");
    setNote(null);
    const sub = await current().catch(() => null);
    await fetch("/api/holder/push", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub?.endpoint }) }).catch(() => null);
    await sub?.unsubscribe().catch(() => false);
    setState("ready");
  };

  return (
    <div className="push-block" aria-label="Alerts with PUSHD closed">
      <div className="push-head">
        <span className={`push-dot ${state}`} aria-hidden="true"></span>
        <b>Alerts with PUSHD closed</b>
        {demo && <span className="tag sample">Sample</span>}
      </div>
      <p>
        Your phone or computer shows the alert even when no PUSHD tab is open. Your saved heat and list, at most 20 an hour, and only while your
        wallet holds $PUSHD.
      </p>
      <div className="push-row">
        <span className="push-state" role="status">
          push: <b>{STATE_TEXT[state]}</b>
        </span>
        {state === "ready" && (
          <button className="btn btn-line push-btn" type="button" onClick={turnOn}>
            Turn on for this device
          </button>
        )}
        {state === "on" && (
          <button className="btn btn-line push-btn" type="button" onClick={turnOff}>
            Turn off for this device
          </button>
        )}
      </div>
      {note && (
        <p className="push-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
