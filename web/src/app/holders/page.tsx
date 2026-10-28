import type { Metadata } from "next";
import Link from "next/link";
import { HolderSignIn, HolderTools } from "@/components/HolderPanel";
import { Mark } from "@/components/Logo";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { WatchedAccounts } from "@/components/WatchedAccounts";
import { getHolder, getHolderWatch, getStats, getToken, getWatchlist } from "@/lib/data";
import type { Builder } from "@/lib/types";

export const metadata: Metadata = {
  title: "PUSHD Holders",
  description: "What $PUSHD holders get: the live feed, their own watchlist, browser alerts.",
  alternates: { canonical: "/holders" },
};

const cmp = (delay: number): [string, string, string][] => [
  ["feed lines and summaries", "yes", "yes"],
  ["delay", `${delay} min behind`, "live"],
  ["filters by group, person, heat", "yes", "yes"],
  ["catches log", "yes", "yes"],
  ["own watchlist", "no", "yes"],
  ["watch any GitHub account", "no", "yes"],
  ["browser alerts", "no", "yes"],
  ["your own scouts", "no", "yes"],
  ["paid or staked", "nothing", "nothing"],
];
const cell = (v: string) => (v === "yes" || v === "live" ? "y" : v === "no" ? "n" : undefined);

export default async function HoldersPage() {
  const [token, holder, stats] = await Promise.all([getToken(), getHolder(), getStats()]);
  const launched = token.stage === "live";
  const min = Number(token.holderMin).toLocaleString("en-US");
  const delay = stats.publicDelayMinutes;
  const builders: Builder[] = holder?.status.holder ? (await getWatchlist({ all: true })).groups.flatMap((g) => g.members) : [];
  const watching = holder?.status.holder ? await getHolderWatch() : null;
  const tag = holder ? (holder.status.holder ? "signed in . live" : "signed in") : launched ? "open" : "opens at launch";
  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/holders" cmd="pushd login --metamask" />
              <h1>
                Holders see it live<span className="acc">.</span>
              </h1>
              <p className="lede">
                Hold $PUSHD and the feed drops its {delay} minute delay. Add your own watchlist and browser alerts. Holding is read
                from the chain; nothing is paid, staked or promised.
              </p>
            </div>
            <span className={holder?.status.holder ? "tag acc live" : "tag acc"}>{tag}</span>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 56 }}>
        <div className="wrap">
          <div className="perks">
            <div className="panel perk">
              <div className="pi">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 12h4l3-7 4 14 3-7h6" />
                </svg>
              </div>
              <h3>The live feed</h3>
              <p>The same lines as the public site, without the {delay} minute wait, the moment the watcher has it.</p>
              <div className="foot">
                public: +{delay}:00 &nbsp; holders: live
              </div>
            </div>
            <div className="panel perk">
              <div className="pi">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M9 6h11M9 12h11M9 18h7M4 6h.01M4 12h.01M4 18h.01" />
                </svg>
              </div>
              <h3>Your own watchlist</h3>
              <p>Add the projects you care about, mute the ones you don&apos;t. Your list sits on top of the shared one.</p>
              <div className="foot">add . mute . group</div>
            </div>
            <div className="panel perk">
              <div className="pi">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4" />
                </svg>
              </div>
              <h3>Browser alerts</h3>
              <p>Pick a heat level and get a browser notification when a line crosses it, while PUSHD is open in a tab. Turn it off any time.</p>
              <div className="foot">alerts at: high and up</div>
            </div>
          </div>
          <div className="panel own-scout-band">
            <div className="osb-faces" aria-hidden="true">
              <ScoutAvatar id="claude" size={40} />
              <ScoutAvatar id="gemini" size={40} />
              <ScoutAvatar id="grok" size={40} />
            </div>
            <div>
              <h3>Your own scout</h3>
              <p>
                Say in plain words what to watch, like &quot;a Solana project creates a repo about agents or payments&quot;. PUSHD turns it into a rule you
                edit, matches every new line against it and sends you the hits. How many scouts you keep follows your holding.
              </p>
            </div>
            <Link className="btn btn-line" href="/my-scout">
              my scout -&gt;
            </Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">compare</div>
              <h2>Public and holders, side by side.</h2>
            </div>
          </div>
          <div className="panel" style={{ overflow: "hidden" }}>
            <table className="cmp">
              <thead>
                <tr>
                  <th></th>
                  <th>public</th>
                  <th className="h">holders</th>
                </tr>
              </thead>
              <tbody>
                {cmp(delay).map(([what, pub, hold]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td className={cell(pub)}>{pub}</td>
                    <td className={cell(hold)}>{hold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap signin-grid">
          <HolderSignIn key={holder?.status.address ?? "out"} launched={launched} minWhole={token.holderMin} holder={holder} />
          <div className="panel alert-demo" aria-label="Example browser alert, sample">
            <div className="eyebrow">browser alert . sample</div>
            <div className="notif">
              <div className="ni">
                <span>
                  <Mark />
                </span>
              </div>
              <div>
                <div className="nt">
                  <span>PUSHD . pushd.fun</span>
                  <span>now</span>
                </div>
                <div className="nh">toly created dts02-6502-signer</div>
                <div className="nb">Very high heat. A hardware signer for the old 6502 chip.</div>
              </div>
            </div>
            <div className="notif faded">
              <div className="ni">
                <span>
                  <Mark />
                </span>
              </div>
              <div>
                <div className="nt">
                  <span>PUSHD . pushd.fun</span>
                  <span>5m</span>
                </div>
                <div className="nh">@kaiwren created frog-oracle</div>
                <div className="nb">Very high heat. A price feed that answers in frog emojis, as a joke.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {holder?.status.holder && (
        <section className="section" id="mine">
          <div className="wrap">
            <HolderTools holder={holder} builders={builders} />
            {watching && <WatchedAccounts view={watching} />}
          </div>
        </section>
      )}

      <section className="wrap">
        <div className="panel riskbox">
          <span className="sig">how much</span>
          <div>
            <h3>Hold {min} $PUSHD in the wallet you sign in with.</h3>
            <p>
              Read from the chain at sign-in and again every few minutes. Holding unlocks the live feed while the site runs. Nothing else is
              promised, and the amount can change; this page always shows it.
            </p>
          </div>
          <Link className="textlink" href="/token">
            token -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
