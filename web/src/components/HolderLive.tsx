"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HEAT_LABEL, HEAT_RANK, KIND_VERB } from "@/lib/groups";
import type { AlertHeat, FeedItem, HolderView, MyHit } from "@/lib/types";

// For a signed-in holder, on every page: the live stream (src/app/api/holder/stream). Each new line is passed to the
// page as a "pushd:item" event (the live feed redraws on it) and, when it crosses the holder's alert heat, shown as a
// browser notification. Nothing happens for anyone else: without the plain hint cookie set at sign-in, this asks for
// nothing at all. One notification per line however many tabs are open (the browser folds the same tag).

const hinted = () => /(?:^|;\s*)pushd_holder_on=1(?:;|$)/.test(document.cookie);

const wants = (heat: FeedItem["heat"], level: AlertHeat) => level !== "off" && HEAT_RANK[heat] >= HEAT_RANK[level];

export function HolderLive() {
  const router = useRouter();
  useEffect(() => {
    if (!hinted()) return;
    let es: EventSource | null = null;
    let prefs: HolderView["prefs"] | null = null;
    let stopped = false;
    let hitTimer: ReturnType<typeof setInterval> | null = null;
    let lastHit = -1;

    // the holder's own scouts: new hits every 20 seconds, shown like a line's alert (the first look only sets the mark)
    const hits = async () => {
      const res = await fetch(`/api/holder/scouts/hits?after=${Math.max(0, lastHit)}&limit=20`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const list = ((await res.json().catch(() => null)) as { hits?: MyHit[] } | null)?.hits ?? [];
      const first = lastHit < 0;
      lastHit = Math.max(lastHit, 0, ...list.map((h) => h.n));
      if (first || !list.length) return;
      window.dispatchEvent(new CustomEvent("pushd:scout-hit", { detail: list }));
      if (location.pathname === "/my-scout") router.refresh();
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      for (const h of list.slice(0, 3)) {
        try {
          const n = new Notification(`${h.scoutName}: ${h.item.handle} / ${h.item.repo}`, { body: `${h.why} ${h.item.summary}`.slice(0, 200), tag: `pushd-my-${h.scoutId}-${h.item.id}`, icon: "/icon" });
          n.onclick = () => {
            window.focus();
            router.push(`/my-scout#hit-${encodeURIComponent(h.item.id)}`);
          };
        } catch {
          /* a browser that only notifies from a service worker: the hit is in the inbox */
        }
      }
    };

    const load = async () => {
      const res = await fetch("/api/holder/me", { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return null;
      const me = (await res.json().catch(() => null)) as HolderView | null;
      return me?.status?.holder ? me : null;
    };

    const start = async () => {
      const me = await load();
      if (!me || stopped) return;
      prefs = me.prefs;
      void hits();
      hitTimer = setInterval(() => void hits(), 20_000);
      es = new EventSource("/api/holder/stream");
      es.addEventListener("item", (e) => {
        let it: FeedItem;
        try {
          it = JSON.parse((e as MessageEvent<string>).data) as FeedItem;
        } catch {
          return;
        }
        window.dispatchEvent(new CustomEvent("pushd:item", { detail: it }));
        const p = prefs;
        if (!p || p.mute.includes(it.handle) || !wants(it.heat, p.alertHeat)) return;
        if (p.alertMine && !p.follow.includes(it.handle)) return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        try {
          const n = new Notification(`${it.handle} ${KIND_VERB[it.kind]} ${it.repo}${it.version ? ` ${it.version}` : ""}`, {
            body: `${HEAT_LABEL[it.heat].replace(/^./, (c) => c.toUpperCase())} heat. ${it.summary}`,
            tag: `pushd-${it.id}`,
            icon: "/icon",
          });
          n.onclick = () => {
            window.focus();
            router.push(`/feed/${encodeURIComponent(it.id)}`);
          };
        } catch {
          /* some browsers only notify from a service worker: the line is still on the live feed */
        }
      });
      // a failed stream (signed out, sold, server gone) closes; the browser's own retry handles short drops
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) es = null;
      };
    };

    // choices saved on /holders take effect at once
    const reload = async () => {
      const me = await load();
      prefs = me?.prefs ?? null;
    };
    window.addEventListener("pushd:prefs", reload);
    void start();
    return () => {
      stopped = true;
      es?.close();
      if (hitTimer) clearInterval(hitTimer);
      window.removeEventListener("pushd:prefs", reload);
    };
  }, [router]);
  return null;
}
