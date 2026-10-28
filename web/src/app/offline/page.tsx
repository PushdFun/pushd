import type { Metadata } from "next";
import Link from "next/link";
import { Prompt } from "@/components/Prompt";

// What the installed app shows when there is no connection (the service worker, public/sw.js, keeps this page). It
// never shows a cached feed: the feed is only ever what the watcher has right now.
export const metadata: Metadata = { title: "PUSHD: offline", robots: { index: false } };

export default function Offline() {
  return (
    <section className="page-head lost offline">
      <div className="wrap">
        <Prompt path="~/pushd" cmd="git fetch" />
        <h1>
          No connection<span className="acc">.</span>
        </h1>
        <p className="lede">This device is offline, so PUSHD cannot show the feed. Nothing here is out of date: the feed comes back the moment you are online.</p>
        <pre className="offline-log" aria-hidden="true">
          {"$ git fetch\nfatal: unable to access the network\n$ _"}
        </pre>
        <div className="hero-cta">
          <Link className="btn btn-acc" href="/feed">
            Try the feed again <span aria-hidden="true">-&gt;</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
