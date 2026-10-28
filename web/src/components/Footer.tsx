import Link from "next/link";
import { SITE } from "@/lib/site";
import { GitHubIcon, XIcon } from "./Icons";
import { Brand } from "./Logo";

export function Footer() {
  return (
    <footer className="ftr">
      <div className="ftr-in">
        <div>
          <Brand />
        </div>
        <div>
          <div className="ftr-links">
            <Link href="/own-risk#own-risk">Own risk</Link>
            <Link href="/own-risk#terms">Terms</Link>
            <Link href="/own-risk#privacy">Privacy</Link>
            <Link href="/how">How it works</Link>
            <Link href="/token">Token</Link>
            <Link href="/pulse">Pulse</Link>
            <Link href="/compare">Compare</Link>
            <a href="/feed.xml">RSS</a>
            <a href="/feed.json">JSON feed</a>
            <Link href="/how#developers">Embed</Link>
            <Link href="/agents">For agents</Link>
            <Link href="/scouts">Scouts</Link>
          </div>
          <div className="ftr-soc">
            <a className="ico" href={SITE.github ?? "#"} aria-label="PUSHD on GitHub">
              <GitHubIcon />
            </a>
            <a className="ico" href={SITE.x ?? "#"} aria-label="PUSHD on X">
              <XIcon />
            </a>
          </div>
        </div>
        <div className="ftr-bot">
          <span>$ exit 0 &nbsp;&nbsp; &copy; 2026 PUSHD</span>
          <span>Prototype. Lines marked Sample are sample data.</span>
        </div>
      </div>
    </footer>
  );
}
