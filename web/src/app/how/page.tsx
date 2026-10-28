import type { Metadata } from "next";
import Link from "next/link";
import { Heat } from "@/components/Heat";
import { Prompt } from "@/components/Prompt";
import { getStats } from "@/lib/data";
import { everyText } from "@/lib/lookup";

export const metadata: Metadata = {
  title: "How PUSHD Works",
  description: "The watcher, the heat score, the summaries, the delay and the limits.",
  alternates: { canonical: "/how" },
};

function LoopFigure({ n }: { n: number }) {
  return (
    <figure className="panel figure" style={{ margin: 0 }}>
      <svg viewBox="0 0 460 360" role="img" aria-label="Diagram: GitHub public activity goes to the watcher, then the filter and heat score, then one line in the feed.">
        <defs>
          <marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 10 5 0 10z" fill="var(--accent)" />
          </marker>
        </defs>
        <g fontSize="14">
          <rect x="1" y="6" width="250" height="52" rx="6" fill="var(--bg-3)" stroke="var(--line-2)" />
          <text x="18" y="38" fill="var(--text)">
            github.com public activity
          </text>
          <rect x="1" y="102" width="250" height="52" rx="6" fill="var(--bg-3)" stroke="var(--accent)" />
          <text x="18" y="134" fill="var(--text)">
            watcher <tspan fill="var(--muted)">top {n}</tspan>
          </text>
          <rect x="1" y="198" width="250" height="52" rx="6" fill="var(--bg-3)" stroke="var(--line-2)" />
          <text x="18" y="230" fill="var(--text)">
            filter + heat score
          </text>
          <rect x="1" y="294" width="250" height="52" rx="6" fill="var(--accent)" />
          <text x="18" y="326" fill="var(--accent-ink)" fontWeight="700">
            one line -&gt; the feed
          </text>
          <path d="M126 58v36" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#ar)" />
          <path d="M126 154v36" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#ar)" />
          <path d="M126 250v36" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#ar)" />
          <path
            d="M251 128h36a14 14 0 0 0 14-14V46a14 14 0 0 0-14-14h-28"
            fill="none"
            stroke="var(--dim)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            markerEnd="url(#ar)"
          />
          <text x="318" y="74" fill="var(--muted)" fontSize="13">
            If-None-Match
          </text>
          <text x="318" y="94" fill="var(--accent)" fontSize="13">
            304 = free
          </text>
          <text x="318" y="114" fill="var(--muted)" fontSize="13">
            ask again
          </text>
          <text x="270" y="222" fill="var(--heat-vhigh)" fontSize="13">
            ~95% dropped
          </text>
          <text x="270" y="242" fill="var(--muted)" fontSize="13">
            bumps, CI, typos
          </text>
          <text x="270" y="318" fill="var(--muted)" fontSize="13">
            + link + heat
          </text>
        </g>
      </svg>
      <figcaption>fig 1. the loop, the {n} most active projects</figcaption>
    </figure>
  );
}

function DelayFigure() {
  return (
    <figure className="panel figure" style={{ margin: 0 }}>
      <svg
        viewBox="0 0 460 250"
        role="img"
        aria-label="Timeline: a push lands, the watcher sees it a few seconds to a minute later, holders see it then, the public feed shows it 5 minutes after that."
      >
        <g fontSize="14">
          <line x1="20" y1="130" x2="440" y2="130" stroke="var(--line-2)" strokeWidth="2" />
          <line x1="96" y1="130" x2="430" y2="130" stroke="var(--accent)" strokeWidth="2" strokeDasharray="6 5" />
          <circle cx="24" cy="130" r="7" fill="var(--text)" />
          <circle cx="96" cy="130" r="7" fill="var(--accent)" />
          <circle cx="430" cy="130" r="7" fill="var(--heat-medium)" />
          <text x="14" y="44" fill="var(--dim)" fontSize="12">
            T+0
          </text>
          <text x="14" y="66" fill="var(--text)">
            push lands
          </text>
          <line x1="24" y1="76" x2="24" y2="118" stroke="var(--line-2)" />
          <text x="84" y="186" fill="var(--dim)" fontSize="12">
            T+ seconds to 1 min
          </text>
          <text x="84" y="208" fill="var(--accent)" fontWeight="700">
            holders see it
          </text>
          <line x1="96" y1="142" x2="96" y2="168" stroke="var(--line-2)" />
          <text x="436" y="44" fill="var(--dim)" fontSize="12" textAnchor="end">
            +5:00 later
          </text>
          <text x="436" y="66" fill="var(--heat-medium)" fontWeight="700" textAnchor="end">
            public sees it
          </text>
          <line x1="430" y1="76" x2="430" y2="118" stroke="var(--line-2)" />
          <text x="263" y="118" fill="var(--muted)" fontSize="12" textAnchor="middle">
            5 min public delay
          </text>
        </g>
      </svg>
      <figcaption>fig 2. one push, two views</figcaption>
    </figure>
  );
}

export default async function HowPage() {
  const stats = await getStats();
  return (
    <>
      <div className="wrap">
        <div className="manbar">
          <span>PUSHD(1)</span>
          <span>PUSHD manual</span>
          <span>PUSHD(1)</span>
        </div>
      </div>
      <section className="page-head" style={{ borderBottom: 0, paddingBottom: 16 }}>
        <div className="wrap">
          <Prompt path="~/pushd" cmd="man pushd" />
          <h1>
            How it works<span className="acc">.</span>
          </h1>
          <p className="lede">Seven parts, plain words. What PUSHD does, how fast it is, and where it stops.</p>
          <nav className="toc" aria-label="On this page">
            <a href="#watcher">
              <b>01</b>the watcher
            </a>
            <a href="#heat">
              <b>02</b>the heat score
            </a>
            <a href="#summaries">
              <b>03</b>the summaries
            </a>
            <a href="#delay">
              <b>04</b>the 5 minute delay
            </a>
            <a href="#limits">
              <b>05</b>honest limits
            </a>
            <a href="#developers">
              <b>06</b>feeds and widget
            </a>
            <a href="#keys">
              <b>07</b>keyboard
            </a>
          </nav>
        </div>
      </section>

      <section className="man" id="watcher" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="wrap man-grid">
          <div>
            <div className="label">01 &nbsp;THE WATCHER</div>
            <h2>It reads public GitHub activity.</h2>
            <p>
              PUSHD ranks crypto token projects by their public GitHub activity every hour and watches the {stats.builders} most
              active right now{stats.pool ? `, out of ${stats.pool.toLocaleString("en-US")} in the pool` : ""}. It only reads what anyone can already see.
              Anyone else on GitHub can still be looked up on demand.
            </p>
            <p>
              Each check is a <b>conditional request</b>. When nothing changed, GitHub answers &quot;304, not modified&quot; and the
              check costs nothing against the rate limit. That lets PUSHD ask often.
            </p>
            <ul className="ticks">
              <li>new repos</li>
              <li>first pushes and pushes</li>
              <li>releases</li>
              <li>public gists</li>
              <li>renamed or newly public repos</li>
            </ul>
          </div>
          <LoopFigure n={stats.builders} />
        </div>
      </section>

      <section className="man" id="heat">
        <div className="wrap man-grid">
          <div>
            <div className="label">02 &nbsp;THE HEAT SCORE</div>
            <h2>Heat is a guess, shown as a bar.</h2>
            <p>Most activity is boring: dependency bumps, CI changes, typo fixes. About 95% is dropped before it reaches the feed.</p>
            <p>
              What is left gets points for things that tend to get shared:{" "}
              <b>a new repo, a fun name, words like coin or token, images, a joke README, a first push after a long silence.</b> The
              total becomes a bar from low to very high.
            </p>
            <div style={{ marginTop: 24, display: "grid", gap: 8 }}>
              <Heat heat="low" />
              <Heat heat="medium" />
              <Heat heat="high" />
              <Heat heat="veryHigh" />
            </div>
          </div>
          <div className="panel figure score">
            <div className="sh">kept . @kaiwren / frog-oracle . Sample</div>
            <div className="srow">
              <span>new repo</span>
              <span className="p">+3</span>
            </div>
            <div className="srow">
              <span>fun name</span>
              <span className="p">+2</span>
            </div>
            <div className="srow">
              <span>joke README</span>
              <span className="p">+2</span>
            </div>
            <div className="srow">
              <span>emoji in the description</span>
              <span className="p">+2</span>
            </div>
            <div className="srow" style={{ borderBottom: 0 }}>
              <span style={{ color: "var(--text)" }}>heat 9/10</span>
              <Heat heat="veryHigh" />
            </div>
            <div className="sh">dropped . Sample</div>
            <div className="srow drop">
              <span>chore: bump deps to 4.2.1</span>
              <span className="p">drop</span>
            </div>
            <div className="srow drop">
              <span>ci: fix workflow cache</span>
              <span className="p">drop</span>
            </div>
            <div className="srow drop" style={{ borderBottom: 0 }}>
              <span>fix typo in README</span>
              <span className="p">drop</span>
            </div>
          </div>
        </div>
      </section>

      <section className="man" id="summaries">
        <div className="wrap man-grid">
          <div>
            <div className="label">03 &nbsp;THE SUMMARIES</div>
            <h2>One plain line, from the repo only.</h2>
            <p>A small AI model reads the README, the file names and the first commit, then writes one line a non-developer can read.</p>
            <p>
              It is told to use <b>only what is in the repo</b>. When there is little to go on, the line says less, not more. Every
              line comes with the link, so you can check it yourself in one tap.
            </p>
          </div>
          <div className="io">
            <div className="box">
              <div className="bh">
                <span>in: README.md</span>
                <span>Sample</span>
              </div>
              <pre>{"# frog-oracle\nAsk it a price. It answers in frogs.\nThis is a joke. Please do not use it for anything."}</pre>
            </div>
            <div className="arrow">| pushd summarize --one-line</div>
            <div className="box out">
              <div className="bh">
                <span>out: feed line</span>
                <span className="acc">kept</span>
              </div>
              <pre>A price feed that answers in frog emojis, as a joke.</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="man" id="delay">
        <div className="wrap man-grid">
          <div>
            <div className="label">04 &nbsp;THE 5 MINUTE DELAY</div>
            <h2>The public feed runs 5 minutes behind.</h2>
            <p>
              Everyone gets the same lines and the same summaries. The public site shows them <b>5 minutes after</b> the watcher
              does.
            </p>
            <p>
              $PUSHD holders sign in with MetaMask and see the feed live, with their own watchlist and browser alerts. Holding is
              read from the chain. Nothing is paid or staked.
            </p>
            <Link className="btn btn-line" href="/holders" style={{ marginTop: 26 }}>
              What holders get <span aria-hidden="true">-&gt;</span>
            </Link>
          </div>
          <DelayFigure />
        </div>
      </section>

      <section className="man" id="limits">
        <div className="wrap">
          <div className="label">05 &nbsp;HONEST LIMITS</div>
          <h2>Where it stops.</h2>
          <p style={{ maxWidth: "60ch", marginTop: 14 }}>PUSHD is fast, not magic. These are the limits, said plainly.</p>
          <div className="limits">
            <div className="panel">
              <div className="code">E_LAG</div>
              <h3>A few seconds to a minute behind</h3>
              <p>
                GitHub&apos;s public activity has its own delay, and PUSHD reads each project in turn: the most active{" "}
                {stats.schedule?.tiers[0] ? everyText(stats.schedule.tiers[0].withTokenMin) : "every few minutes"} with a GitHub token, the rest less
                often. Without a token, GitHub allows so few requests that reads are hours apart.
              </p>
            </div>
            <div className="panel">
              <div className="code">E_RATE</div>
              <h3>GitHub sets limits</h3>
              <p>
                GitHub limits how often anyone can ask. Conditional requests keep most checks free, but a very busy hour can slow
                things down.
              </p>
            </div>
            <div className="panel">
              <div className="code">E_SCOPE</div>
              <h3>Public, and the list first</h3>
              <p>PUSHD watches public activity of the list as it happens. Anyone else is read only when someone looks them up. Private repos are out of view.</p>
            </div>
            <div className="panel">
              <div className="code">E_GUESS</div>
              <h3>Heat and summaries can be wrong</h3>
              <p>Heat is a score from simple signals. Summaries come from the repo&apos;s own words or a small AI model and can miss the point. Always open the link.</p>
            </div>
          </div>
        </div>
      </section>
      <section className="man" id="developers">
        <div className="wrap man-grid">
          <div>
            <div className="label">06 &nbsp;FEEDS AND WIDGET</div>
            <h2>Take the public feed anywhere.</h2>
            <p>
              The same lines as the public site, with the same <b>5 minute delay</b>: as <b>RSS</b> for any reader, as <b>JSON Feed</b> for
              your own tools (PUSHD&apos;s fields are under <b>_pushd</b>), and as a small <b>widget</b> for any web page.
            </p>
            <p>The widget takes a few options in its address: how many lines (n, 3 to 20), one camp (group), a heat floor (heat) and a light theme.</p>
            <div className="dev-links">
              <a className="btn btn-line" href="/feed.xml">
                /feed.xml
              </a>
              <a className="btn btn-line" href="/feed.json">
                /feed.json
              </a>
              <a className="btn btn-line" href="/embed?n=6" target="_blank" rel="noopener noreferrer">
                /embed
              </a>
            </div>
          </div>
          <div className="io">
            <div className="box">
              <div className="bh">
                <span>embed.html</span>
                <span>paste anywhere</span>
              </div>
              <pre>{`<iframe
  src="https://pushd.fun/embed?n=6&heat=medium"
  width="380" height="480"
  style="border:0;border-radius:12px"
  title="PUSHD feed"></iframe>`}</pre>
            </div>
            <div className="box">
              <div className="bh">
                <span>terminal</span>
                <span>JSON Feed 1.1</span>
              </div>
              <pre>{`$ curl -s https://pushd.fun/feed.json | jq '.items[0].title'
"toly created dts02-6502-signer"`}</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="man" id="keys">
        <div className="wrap man-grid">
          <div>
            <div className="label">07 &nbsp;KEYBOARD</div>
            <h2>Built for the keyboard.</h2>
            <p>
              <b>Ctrl K</b> (or <b>/</b>) opens a palette that jumps to any builder, repo or page. On the feed, <b>j</b> and <b>k</b>{" "}
              move through the lines and <b>o</b> opens one. <b>g</b> then a letter goes to a page, <b>t</b> flips the theme, <b>s</b>{" "}
              turns the sound mode on or off, and <b>?</b> lists them all.
            </p>
            <p>Sound mode is off until you turn it on: a soft tick for each new line, a brighter one for hot lines. It is remembered in this browser only.</p>
          </div>
          <div className="io">
            <div className="box out">
              <div className="bh">
                <span>keys</span>
                <span>anywhere on the site</span>
              </div>
              <pre style={{ fontFamily: "var(--mono)", fontSize: 14 }}>{`Ctrl K  search and jump
j / k   next / previous line
o       open the line
g f     feed        g p  pulse
g r     replay      g b  brief
g c     catches     g w  top 100
t       theme       s    sound
?       all of them`}</pre>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
