"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bare, builderHref } from "@/lib/format";
import { GROUPS, HEAT_CLASS, KIND_LABEL } from "@/lib/groups";
import { ghRepoHref, ghUserHref, itemHref, parseQuery } from "@/lib/lookup";
import type { GroupKey, Heat, Kind, LookupResult } from "@/lib/types";
import { Avatar } from "./Avatar";
import { setSound, soundOn } from "./Sound";

// The command palette (Ctrl K or Cmd K, or "/"): jump to any page, any builder on the watchlist, or any recent line.
// Two or more letters also ask the engine (debounced): the watched first, then anyone on GitHub, labelled as not on
// the watchlist. A full username or owner/name gets a direct entry at once.
// "?" shows the keyboard shortcuts. "g" then a letter goes to a page; "t" flips the theme; "s" turns sound on or off.
// Keys are ignored while typing in a field. The builders and lines load once, the first time it opens.

type Idx = {
  builders: { handle: string; name?: string; org?: string; group: GroupKey; sample: boolean }[];
  items: { id: string; handle: string; repo: string; version?: string; kind: Kind; heat: Heat; summary: string; sample: boolean }[];
};
type Entry = { key: string; section: string; title: string; hint?: string; href?: string; run?: () => void; icon: React.ReactNode; words: string };

const PAGES: [string, string, string, string][] = [
  ["/", "Home", "right now", "h"],
  ["/feed", "Feed", "every line, newest first", "f"],
  ["/feed?view=gallery", "Gallery", "every line as a card", ""],
  ["/scouts", "Scouts", "five AI agents and their records", "s"],
  ["/my-scout", "My scout", "your own scout, for holders", "y"],
  ["/pulse", "Pulse", "camps, hours, leaderboards", "p"],
  ["/replay", "Replay", "a day in 60 seconds", "r"],
  ["/brief", "Daily brief", "what shipped today", "b"],
  ["/catches", "Catches", "the hot lines log", "c"],
  ["/watchlist", "The list", "the most active projects now", "w"],
  ["/gh", "Look up", "anyone on GitHub", "u"],
  ["/compare", "Compare", "builders side by side", "d"],
  ["/how", "How it works", "the manual", "m"],
  ["/agents", "For agents", "MCP, REST, pay per call", "a"],
  ["/holders", "Holders", "live feed, own list, alerts", "l"],
  ["/token", "Token", "$PUSHD and the burn", "k"],
];
const GO: Record<string, string> = Object.fromEntries(PAGES.filter((p) => p[3]).map((p) => [p[3], p[0]]));

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const flipTheme = () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("pushd-theme", next);
  } catch {
    /* blocked: this page only */
  }
};

export function openPalette() {
  window.dispatchEvent(new CustomEvent("pushd:palette", { detail: "search" }));
}

export function PaletteButton() {
  return (
    <button type="button" className="ico kbtn" onClick={openPalette} aria-label="Search and jump (Ctrl K)" title="Search and jump (Ctrl K)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <kbd className="kb-hint">Ctrl K</kbd>
    </button>
  );
}

export function Palette() {
  const router = useRouter();
  const [mode, setMode] = useState<"closed" | "search" | "keys">("closed");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [idx, setIdx] = useState<Idx | null>(null);
  const [remote, setRemote] = useState<{ q: string; r: (LookupResult & { offline?: boolean }) | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  const open = useCallback((m: "search" | "keys") => {
    back.current = document.activeElement as HTMLElement | null;
    setMode(m);
    setQ("");
    setSel(0);
  }, []);
  const close = useCallback(() => {
    setMode("closed");
    back.current?.focus?.();
  }, []);

  useEffect(() => {
    if (mode === "search" && !idx)
      fetch("/api/index", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Idx | null) => setIdx(j ?? { builders: [], items: [] }))
        .catch(() => setIdx({ builders: [], items: [] }));
    if (mode === "search") setTimeout(() => input.current?.focus(), 0);
  }, [mode, idx]);

  // anyone on GitHub, through the engine: debounced, the latest answer wins
  useEffect(() => {
    const text = q.trim();
    if (mode !== "search" || text.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/lookup?q=${encodeURIComponent(text)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: (LookupResult & { offline?: boolean }) | null) => live && setRemote({ q: text, r: j }))
        .catch(() => live && setRemote({ q: text, r: null }));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, mode]);

  // the keys, everywhere
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (mode === "closed") open("search");
        else close();
        return;
      }
      if (mode !== "closed" || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        open("search");
      } else if (e.key === "?") {
        e.preventDefault();
        open("keys");
      } else if (e.key === "g") {
        g = Date.now();
      } else if (Date.now() - g < 1200 && GO[e.key]) {
        g = 0;
        router.push(GO[e.key]);
      } else if (e.key === "t") {
        flipTheme();
      } else if (e.key === "s") {
        setSound(!soundOn());
      }
    };
    const onOpen = (e: Event) => open(((e as CustomEvent<string>).detail as "search" | "keys") ?? "search");
    window.addEventListener("keydown", onKey);
    window.addEventListener("pushd:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pushd:palette", onOpen);
    };
  }, [mode, open, close, router]);

  const entries = useMemo((): Entry[] => {
    const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.includes(w));
    const pages: Entry[] = PAGES.map(([href, title, hint, k]) => ({
      key: `p${href}`,
      section: "pages",
      title,
      hint: k ? `g ${k}` : hint,
      href,
      icon: ">",
      words: `${title} ${hint} ${href}`.toLowerCase(),
    }));
    const actions: Entry[] = [
      { key: "a-theme", section: "actions", title: "Flip the theme", hint: "t", run: flipTheme, icon: "~", words: "theme dark light" },
      { key: "a-sound", section: "actions", title: "Sound on or off", hint: "s", run: () => setSound(!soundOn()), icon: "~", words: "sound tick audio" },
      { key: "a-keys", section: "actions", title: "Keyboard shortcuts", hint: "?", run: () => window.dispatchEvent(new CustomEvent("pushd:palette", { detail: "keys" })), icon: "?", words: "keys keyboard shortcuts help" },
    ];
    const builders: Entry[] = (idx?.builders ?? []).map((b) => ({
      key: `b${b.handle}`,
      section: "projects",
      title: b.handle,
      hint: [b.name !== b.handle ? b.name : null, GROUPS[b.group].short].filter(Boolean).join(" · "),
      href: builderHref(b.handle),
      icon: <Avatar handle={b.handle} sample={b.sample} size={26} />,
      words: `${bare(b.handle)} ${b.name ?? ""} ${b.org ?? ""} ${GROUPS[b.group].label}`.toLowerCase(),
    }));
    const items: Entry[] = (idx?.items ?? []).map((it) => ({
      key: `i${it.id}`,
      section: "lines",
      title: `${it.handle} / ${it.repo}${it.version ? ` ${it.version}` : ""}`,
      hint: KIND_LABEL[it.kind],
      href: `/feed/${it.id}`,
      icon: <span className={`gheat ${HEAT_CLASS[it.heat]}`}><i /></span>,
      words: `${it.handle} ${it.repo} ${it.version ?? ""} ${it.summary}`.toLowerCase(),
    }));
    if (!words.length) return [...pages.slice(0, 8), ...builders.slice(0, 5), ...actions];
    const localB = builders.filter((e) => hit(e.words)).slice(0, 8);
    const localI = items.filter((e) => hit(e.words)).slice(0, 10);
    const seen = new Set([...localB, ...localI].map((e) => e.key));
    const fresh = remote && remote.q === q.trim() ? remote.r : null;
    const moreB: Entry[] = (fresh?.watch.builders ?? [])
      .map((b) => ({ key: `b${b.handle}`, section: "projects", title: b.handle, hint: GROUPS[b.group].short, href: builderHref(b.handle), icon: <Avatar handle={b.handle} sample={b.sample} size={26} />, words: "" }))
      .filter((e) => !seen.has(e.key));
    const moreI: Entry[] = (fresh?.watch.items ?? [])
      .map((it) => ({ key: `i${it.id}`, section: "lines", title: `${it.handle} / ${it.repo}${it.version ? ` ${it.version}` : ""}`, hint: KIND_LABEL[it.kind], href: itemHref(it), icon: <span className={`gheat ${HEAT_CLASS[it.heat]}`}><i /></span>, words: "" }))
      .filter((e) => !seen.has(e.key));
    const p = parseQuery(q);
    const gh = "on github, not on the watchlist";
    const known = new Set([...localB, ...moreB].map((e) => bare(e.title).toLowerCase()));
    const direct: Entry[] =
      p.kind === "user" && !known.has(p.login.toLowerCase())
        ? [{ key: `d-u-${p.login}`, section: gh, title: p.login, hint: "open the account", href: p.href, icon: <Avatar handle={p.login} size={26} />, words: "" }]
        : p.kind === "repo"
          ? [{ key: `d-r-${p.owner}/${p.repo}`, section: gh, title: `${p.owner}/${p.repo}`, hint: "open the repo", href: p.href, icon: "/", words: "" }]
          : [];
    const directKeys = new Set(direct.map((d) => d.title.toLowerCase()));
    const ghUsers: Entry[] = (fresh?.github.users ?? [])
      .filter((u) => !known.has(u.login.toLowerCase()) && !directKeys.has(u.login.toLowerCase()))
      .slice(0, 5)
      .map((u) => ({ key: `g-u-${u.login}`, section: gh, title: u.login, hint: u.type === "org" ? "org" : "person", href: ghUserHref(u.login), icon: <Avatar handle={u.login} size={26} />, words: "" }));
    const ghRepos: Entry[] = (fresh?.github.repos ?? [])
      .filter((r) => !directKeys.has(r.fullName.toLowerCase()))
      .slice(0, 6)
      .map((r) => ({ key: `g-r-${r.fullName}`, section: gh, title: r.fullName, hint: `${r.stars.toLocaleString("en-US")} stars`, href: ghRepoHref(r.fullName.split("/")[0], r.fullName.split("/")[1]), icon: "/", words: "" }));
    return [...pages.filter((e) => hit(e.words)), ...localB, ...moreB, ...localI, ...moreI.slice(0, 6), ...direct, ...ghUsers, ...ghRepos, ...actions.filter((e) => hit(e.words))];
  }, [q, idx, remote]);
  const answer = remote && remote.q === q.trim() ? remote : null;
  const ghNote =
    q.trim().length < 2
      ? null
      : !answer
        ? "asking GitHub..."
        : !answer.r || answer.r.offline
          ? "GitHub search is not connected here."
          : answer.r.github.busy
            ? "GitHub is busy, try in a minute."
            : null;

  const go = (e: Entry | undefined) => {
    if (!e) return;
    if (e.run) {
      e.run();
      if (e.key !== "a-keys") close();
      return;
    }
    setMode("closed");
    if (e.href) router.push(e.href);
  };

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (mode === "closed") return null;
  return (
    <div className="pal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={mode === "keys" ? "Keyboard shortcuts" : "Search and jump"}>
        {mode === "keys" ? (
          <>
            <div className="pal-in">
              <span>?</span>
              <b style={{ flex: 1, fontWeight: 500 }}>keyboard shortcuts</b>
              <button type="button" className="pill" onClick={close} autoFocus>
                close
              </button>
            </div>
            <div className="keys-grid">
              <div>
                search and jump <span><kbd>Ctrl K</kbd> <kbd>/</kbd></span>
              </div>
              <div>
                this help <kbd>?</kbd>
              </div>
              <div>
                next / previous line <span><kbd>j</kbd> <kbd>k</kbd></span>
              </div>
              <div>
                open the line <span><kbd>o</kbd> <kbd>Enter</kbd></span>
              </div>
              {PAGES.filter((p) => p[3]).map((p) => (
                <div key={p[0]}>
                  {p[1].toLowerCase()} <span><kbd>g</kbd> <kbd>{p[3]}</kbd></span>
                </div>
              ))}
              <div>
                flip the theme <kbd>t</kbd>
              </div>
              <div>
                sound on or off <kbd>s</kbd>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="pal-in">
              <span>&gt;</span>
              <input
                ref={input}
                value={q}
                placeholder="a project, owner/repo, a page, or anyone on GitHub"
                aria-label="Search"
                aria-controls="pal-list"
                onChange={(e) => {
                  setQ(e.target.value);
                  setSel(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSel((s) => Math.min(entries.length - 1, s + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel((s) => Math.max(0, s - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    go(entries[sel]);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                  }
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div className="pal-list" id="pal-list" role="listbox" ref={list}>
              {entries.length === 0 && !ghNote && <div className="pal-empty">{idx ? "Nothing matches. Try a handle or a repo name." : "Loading the watchlist..."}</div>}
              {entries.map((e, i) => {
                const head = i === 0 || entries[i - 1].section !== e.section ? e.section : null;
                return (
                  <div key={e.key}>
                    {head && <div className="pal-sec">{head}</div>}
                    <button type="button" className="pal-item" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(e)}>
                      <span className="pi">{e.icon}</span>
                      <span className="pt">{e.title}</span>
                      <span className="pk">{e.hint}</span>
                    </button>
                  </div>
                );
              })}
              {ghNote && <div className="pal-note">{ghNote}</div>}
            </div>
            <div className="pal-foot">
              <span>
                <kbd>up</kbd>
                <kbd>down</kbd> move
              </span>
              <span>
                <kbd>enter</kbd> open
              </span>
              <span>
                <kbd>?</kbd> all shortcuts
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
