"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { HEAT_RANK } from "@/lib/groups";
import type { Feed, FeedItem } from "@/lib/types";
import { Clock } from "./Clock";
import { FeedList } from "./FeedList";
import { FilterBar, NO_FILTERS, type Filters, type View } from "./FilterBar";
import { Gallery } from "./Gallery";
import { Prompt } from "./Prompt";
import { SoundToggle } from "./Sound";

// The feed page: the head, the filter row, and the log or the gallery. The view is in the address (?view=gallery,
// so a gallery link opens as a gallery) and remembered in this browser; storage can be blocked, so every touch is
// guarded and the page works without it.

export const VIEW_KEY = "pushd-feed-view";

function readStored(): View | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "gallery" || v === "log" ? v : null;
  } catch {
    return null;
  }
}
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function setAddress(view: View) {
  const url = new URL(window.location.href);
  if (view === "gallery") url.searchParams.set("view", "gallery");
  else url.searchParams.delete("view");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

const bySort = (sort: Filters["sort"]) => (a: FeedItem, b: FeedItem) =>
  (sort === "hottest" ? HEAT_RANK[b.heat] - HEAT_RANK[a.heat] || (b.score ?? 0) - (a.score ?? 0) : 0) || Date.parse(b.githubAt) - Date.parse(a.githubAt);

export function FeedView({
  feed,
  delayMinutes,
  urlView,
  legend,
  mine = null,
}: {
  feed: Feed;
  delayMinutes: number;
  /** the view the address asked for; null when it asked for none */
  urlView: View | null;
  legend: ReactNode;
  /** a signed-in holder's own watchlist: followed handles get a filter, muted ones leave the feed */
  mine?: { follow: string[]; mute: string[] } | null;
}) {
  const { asOf, source, live = false } = feed;
  // lines that arrived through the stream since the page loaded, newest first
  const [arrived, setArrived] = useState<FeedItem[]>([]);
  const all = arrived.length ? [...arrived, ...feed.items.filter((it) => !arrived.some((a) => a.id === it.id))] : feed.items;
  const items = mine?.mute.length ? all.filter((it) => !mine.mute.includes(it.handle)) : all;
  const [q, setQ] = useState("");
  const router = useRouter();
  const [onlyMine, setOnlyMine] = useState(false);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [picked, setPicked] = useState<View | null>(urlView);
  const stored = useSyncExternalStore(subscribeStorage, readStored, () => null);
  const view: View = picked ?? stored ?? "log";

  // a remembered gallery, opened from a plain /feed: say so in the address too, so it can be shared as is
  useEffect(() => {
    if (picked == null && stored === "gallery") setAddress("gallery");
  }, [picked, stored]);

  // a new line from the stream (public or the holder's) slides in on top, marked as just in
  useEffect(() => {
    if (source !== "engine") return;
    const on = (e: Event) => {
      const it = (e as CustomEvent<FeedItem>).detail;
      if (!it?.id) return;
      setArrived((cur) => (cur.some((c) => c.id === it.id) ? cur : [{ ...it, mediaUrl: null }, ...cur].slice(0, 50)));
    };
    window.addEventListener("pushd:item", on);
    return () => window.removeEventListener("pushd:item", on);
  }, [source]);

  // j and k move through the lines on screen, o or Enter opens one (the log or the gallery)
  useEffect(() => {
    let at = -1;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      if (document.querySelector(".pal-back")) return;
      const els = [...document.querySelectorAll<HTMLElement>(".feed .item:not([hidden]), .masonry .gcard")];
      if (!els.length) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        els.forEach((el) => el.classList.remove("kfocus"));
        at = Math.max(0, Math.min(els.length - 1, at + (e.key === "j" ? 1 : -1)));
        els[at].classList.add("kfocus");
        els[at].scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      } else if ((e.key === "o" || e.key === "Enter") && at >= 0 && els[at]) {
        e.preventDefault();
        router.push(`/feed/${els[at].id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // the live view also redraws when the holder's stream (HolderLive) brings a new line, at most every few seconds
  useEffect(() => {
    if (!live) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onItem = () => {
      if (t) return;
      t = setTimeout(() => ((t = null), router.refresh()), 3000);
    };
    window.addEventListener("pushd:item", onItem);
    return () => {
      window.removeEventListener("pushd:item", onItem);
      if (t) clearTimeout(t);
    };
  }, [live, router]);

  const choose = (v: View) => {
    setPicked(v);
    setAddress(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  };

  const people = [...new Set(items.map((it) => it.handle))];
  const followed = mine?.follow ?? [];
  const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean);
  const matches = (it: FeedItem) =>
    words.every((w) => [it.handle, it.repo, it.version, it.summary, it.name, it.org].filter(Boolean).join(" ").toLowerCase().includes(w)) &&
    (!onlyMine || followed.includes(it.handle)) && (f.group === "all" || it.group === f.group) && (f.person === "all" || it.handle === f.person) && (f.heats.length === 0 || f.heats.includes(it.heat));
  const sorted = [...items].sort(bySort(f.sort));
  const shown = sorted.filter(matches);
  const reset = () => (setF(NO_FILTERS), setOnlyMine(false), setQ(""));
  const allSample = items.length > 0 && items.every((it) => it.sample);

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/feed" cmd={view === "gallery" ? "ls --gallery" : "tail -f feed.log"} />
              <h1>
                The feed<span className="acc">.</span>
              </h1>
              <p className="lede">
                {view === "gallery"
                  ? "Every push as a card. Switch back to the log any time."
                  : "Everything the watcher kept, newest first. Tap a line for the raw details."}
              </p>
            </div>
            <div className="statusbar">
              {live ? (
                <>
                  <span className="tag acc live">holder view</span>
                  <span>
                    <b>live</b>, no delay
                  </span>
                  {followed.length > 0 && (
                    <button className="chip" type="button" aria-pressed={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
                      my list <span className="n">{followed.length}</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="tag live">public view</span>
                  <span>
                    <b>{delayMinutes} min</b> behind
                  </span>
                </>
              )}
              <span>
                UTC{" "}
                <b>
                  <Clock />
                </b>
              </span>
              <SoundToggle label />
              {source === "sample" && <span className="tag sample">Sample data</span>}
              {source === "offline" && <span className="tag">watcher offline</span>}
            </div>
          </div>
        </div>
      </section>

      <section className={`gwrap view-${view}`}>
        <FilterBar
          f={f}
          setF={setF}
          view={view}
          setView={choose}
          people={people}
          search={
            <label className="fsearch">
              <span>grep</span>
              <input type="search" placeholder="repo, handle, words" aria-label="Search the feed" value={q} onChange={(e) => setQ(e.target.value)} />
              <kbd aria-hidden="true">j k o</kbd>
            </label>
          }
        />

        {view === "log" ? (
          <>
            <FeedList items={sorted} asOf={asOf} matches={matches} reset={reset} live={live} fresh={arrived.map((a) => a.id)} />
            {legend}
          </>
        ) : (
          <>
            {shown.length > 0 ? (
              <Gallery items={shown} asOf={asOf} />
            ) : (
              <div className="gempty">
                {items.length === 0 ? (
                  "no cards yet. the watcher has nothing public to show right now."
                ) : (
                  <>
                    no cards match.{" "}
                    <button className="pill" type="button" onClick={reset}>
                      reset filters
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="gnote">
              <span>
                showing <b>{shown.length}</b> of {items.length} {allSample ? "sample cards" : "cards"}
              </span>
              {live ? (
                <Link className="textlink" href="/holders#mine">
                  your watchlist and alerts -&gt;
                </Link>
              ) : (
                <Link className="textlink" href="/holders">
                  holders see this live -&gt;
                </Link>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
