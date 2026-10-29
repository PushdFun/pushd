"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV, SITE } from "@/lib/site";
import { BarsIcon, CloseIcon, GitHubIcon, XIcon } from "./Icons";
import { Brand } from "./Logo";
import { PaletteButton } from "./Palette";
import { ThemeToggle } from "./ThemeToggle";

const isCurrent = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

// The header's links: the site's pages without the list (its page stays, reached from the pulse and the palette), and
// Build only while PUSHD Agents is switched on.
const linksFor = (build: boolean) => NAV.filter((n) => n.href !== "/watchlist" && (build || n.href !== "/build"));

/**
 * The buy button: until $PUSHD exists it leads to the token page and says it is launching soon; once it exists, to
 * where it trades (the token's Pons page, or PUSHD_BUY_URL), in a new tab.
 */
export function BuyButton({ href, title = true }: { href: string | null; title?: boolean }) {
  if (href)
    return (
      <a className="btn btn-acc" href={href} target="_blank" rel="noopener noreferrer" title={title ? "Trade $PUSHD on Pons" : undefined}>
        Buy $PUSHD
      </a>
    );
  return (
    <Link className="btn btn-acc" href="/token" title={title ? "Launching soon" : undefined}>
      Buy $PUSHD <span className="soon">launching soon</span>
    </Link>
  );
}

export function Header({ buyHref = null, build = false }: { buyHref?: string | null; build?: boolean }) {
  const path = usePathname() ?? "/";
  const LINKS = linksFor(build);
  const [open, setOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuBtn.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const current = (href: string) => (isCurrent(path, href) ? ("page" as const) : undefined);
  const close = () => setOpen(false);

  return (
    <header className={open ? "hdr open" : "hdr"} style={{ viewTransitionName: "site-header" }}>
      <div className="hdr-in">
        <Brand word={false} />
        <nav className="nav" aria-label="Main">
          {LINKS.map((n) => (
            <Link key={n.href} href={n.href} aria-current={current(n.href)}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hdr-r">
          <PaletteButton />
          <a className="ico soc" href={SITE.github ?? "#"} aria-label="PUSHD on GitHub">
            <GitHubIcon />
          </a>
          <a className="ico soc" href={SITE.x ?? "#"} aria-label="PUSHD on X">
            <XIcon />
          </a>
          <ThemeToggle />
          <BuyButton href={buyHref} />
          <button
            ref={menuBtn}
            className="ico menu-btn"
            type="button"
            aria-expanded={open}
            aria-controls="drawer"
            aria-label="Menu"
            onClick={() => setOpen((o) => !o)}
          >
            <BarsIcon />
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="drawer" id="drawer" inert={!open}>
        <div className="drawer-in">
          <nav aria-label="Main, phone">
            {LINKS.map((n, i) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href)} onClick={close}>
                {n.label}
                <span>{String(i + 1).padStart(2, "0")}</span>
              </Link>
            ))}
          </nav>
          <div className="drawer-foot">
            <a className="ico" href={SITE.github ?? "#"} aria-label="PUSHD on GitHub">
              <GitHubIcon />
            </a>
            <a className="ico" href={SITE.x ?? "#"} aria-label="PUSHD on X">
              <XIcon />
            </a>
            <BuyButton href={buyHref} title={false} />
          </div>
        </div>
      </div>
    </header>
  );
}
