"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { GROUPS, GROUP_ORDER, HEAT_CLASS, HEAT_LABEL } from "@/lib/groups";
import type { GroupKey, Heat } from "@/lib/types";

// The feed's filter row, the same for the log and the gallery: the groups as pills, then heat (pick any mix), the
// person, the order, and the Log / Gallery switch. On a phone it wraps; nothing is cut off.

export type Sort = "newest" | "hottest";
export type View = "log" | "gallery";
export type Filters = { group: GroupKey | "all"; heats: Heat[]; person: string; sort: Sort };
export const NO_FILTERS: Filters = { group: "all", heats: [], person: "all", sort: "newest" };

/** Hottest first in the menu, as the dots read. */
const HEATS: Heat[] = ["veryHigh", "high", "medium", "low"];
const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "hottest", label: "Hottest" },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function heatLabel(heats: Heat[]): string {
  if (heats.length === 0 || heats.length === HEATS.length) return "All heat";
  if (heats.length === 1) return cap(HEAT_LABEL[heats[0]]);
  return `${heats.length} heat levels`;
}

function Dots({ heats }: { heats: Heat[] }) {
  const show = heats.length === 0 || heats.length === HEATS.length ? (["veryHigh", "high", "medium"] as Heat[]) : HEATS.filter((h) => heats.includes(h));
  return (
    <span className="dot-row" aria-hidden="true">
      {show.map((h) => (
        <i key={h} className={HEAT_CLASS[h]}></i>
      ))}
    </span>
  );
}

/** A pill that opens a small menu below it. Closes on a click outside, Escape, or (for single choices) a pick. */
function Dropdown({ label, title, children, active }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    // keep the menu on the screen: near the right edge (a phone, a wrapped row) it moves left as far as it must
    const m = menu.current;
    if (m && box.current) {
      m.style.left = "";
      const r = m.getBoundingClientRect();
      const over = r.right - (document.documentElement.clientWidth - 12);
      if (over > 0) m.style.left = `${-Math.min(over, box.current.getBoundingClientRect().left - 12)}px`;
    }
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={open ? "dd open" : "dd"} ref={box}>
      <button
        ref={btn}
        className={active ? "pill drop set" : "pill drop"}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      <div className="dd-menu" id={id} ref={menu} role="group" aria-label={title} hidden={!open}>
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}

const Check = () => (
  <svg className="ck" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

export function FilterBar({
  f,
  setF,
  view,
  setView,
  people,
  search,
}: {
  f: Filters;
  setF: (f: Filters) => void;
  view: View;
  setView: (v: View) => void;
  people: string[];
  /** a search box, first in the right-hand group */
  search?: ReactNode;
}) {
  const toggleHeat = (h: Heat) => {
    const next = f.heats.includes(h) ? f.heats.filter((x) => x !== h) : [...f.heats, h];
    setF({ ...f, heats: next.length === HEATS.length ? [] : next });
  };
  return (
    <div className="gbar" role="group" aria-label="Filters">
      <div className="pills" role="group" aria-label="Group">
        <button className={f.group === "all" ? "pill on" : "pill"} type="button" aria-pressed={f.group === "all"} onClick={() => setF({ ...f, group: "all" })}>
          All
        </button>
        {GROUP_ORDER.map((g) => (
          <button key={g} className={f.group === g ? "pill on" : "pill"} type="button" aria-pressed={f.group === g} onClick={() => setF({ ...f, group: g })}>
            {GROUPS[g].chip}
          </button>
        ))}
      </div>
      <div className="pills right">
        {search}
        <Dropdown
          title="Person"
          active={f.person !== "all"}
          label={
            <>
              <svg className="pi" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="8" cy="5.5" r="2.7" />
                <path d="M2.8 14c.6-2.7 2.7-4.2 5.2-4.2s4.6 1.5 5.2 4.2" strokeLinecap="round" />
              </svg>
              {f.person === "all" ? "Everyone" : f.person}
            </>
          }
        >
          {(close) => (
            <div className="dd-list">
              {["all", ...people].map((p) => (
                <button
                  key={p}
                  className="dd-item"
                  type="button"
                  aria-pressed={f.person === p}
                  onClick={() => {
                    setF({ ...f, person: p });
                    close();
                  }}
                >
                  <span className="dd-txt">{p === "all" ? "Everyone" : p}</span>
                  <Check />
                </button>
              ))}
            </div>
          )}
        </Dropdown>
        <Dropdown
          title="Heat"
          active={f.heats.length > 0}
          label={
            <>
              <Dots heats={f.heats} />
              {heatLabel(f.heats)}
            </>
          }
        >
          {() => (
            <>
              <button className="dd-item" type="button" aria-pressed={f.heats.length === 0} onClick={() => setF({ ...f, heats: [] })}>
                <span className="dd-dot all" aria-hidden="true"></span>
                <span className="dd-txt">All heat</span>
                <Check />
              </button>
              <div className="dd-sep" aria-hidden="true"></div>
              {HEATS.map((h) => (
                <button key={h} className="dd-item" type="button" aria-pressed={f.heats.includes(h)} onClick={() => toggleHeat(h)}>
                  <span className={`dd-dot ${HEAT_CLASS[h]}`} aria-hidden="true"></span>
                  <span className="dd-txt">{cap(HEAT_LABEL[h])}</span>
                  <Check />
                </button>
              ))}
            </>
          )}
        </Dropdown>
        <Dropdown title="Order" label={SORTS.find((s) => s.value === f.sort)!.label}>
          {(close) =>
            SORTS.map((s) => (
              <button
                key={s.value}
                className="dd-item"
                type="button"
                aria-pressed={f.sort === s.value}
                onClick={() => {
                  setF({ ...f, sort: s.value });
                  close();
                }}
              >
                <span className="dd-txt">{s.label}</span>
                <Check />
              </button>
            ))
          }
        </Dropdown>
        <div className="viewsw" role="group" aria-label="View">
          {(["log", "gallery"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : undefined} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {cap(v)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
