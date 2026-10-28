import Link from "next/link";
import type { GhLoad } from "@/lib/data";
import { AutoRetry } from "./AutoRetry";
import { LookupBox } from "./LookupBox";
import { Prompt } from "./Prompt";

// What a page built on demand shows when it cannot be built: GitHub has no such thing, GitHub is busy (try in a
// minute, with a countdown), or PUSHD's engine is not answering.

export function GhState({ load, path, cmd }: { load: Exclude<GhLoad<unknown>, { state: "ok" } | { state: "redirect" }>; path: string; cmd: string }) {
  const head =
    load.state === "missing" ? "Not on GitHub" : load.state === "busy" ? "Busy, try in a minute" : "Not answering";
  return (
    <section className="page-head gh-state">
      <div className="wrap">
        <Prompt path={path} cmd={cmd} />
        <h1>
          {head}
          <span className="acc">.</span>
        </h1>
        <p className="lede">
          {load.state === "missing"
            ? `${load.error} Check the spelling, or search for it.`
            : load.state === "busy"
              ? `${load.error} Lookups have their own share of PUSHD's GitHub allowance, so the watched projects always come first. This page is built as soon as there is room.`
              : load.error}
        </p>
        {load.state === "busy" && <AutoRetry seconds={load.retryInSec} />}
        <div style={{ marginTop: 28 }}>
          <LookupBox compact />
        </div>
        <p style={{ marginTop: 22 }}>
          <Link className="textlink" href="/watchlist">
            &lt;- the list
          </Link>
        </p>
      </div>
    </section>
  );
}
