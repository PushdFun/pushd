import type { Metadata } from "next";
import { Prompt } from "@/components/Prompt";
import { RISK_LINE } from "@/lib/site";

export const metadata: Metadata = {
  title: "PUSHD Own Risk",
  description: "Own risk, terms and privacy.",
  alternates: { canonical: "/own-risk" },
};

type Point = [string, string];

const RISK: Point[] = [
  ["Public info only.", "PUSHD shows activity that is already public on GitHub. It shows it sooner. That is all."],
  ["Not advice.", "Nothing on this site is financial, investment or legal advice. A heat mark is a guess about how meme-able something is, not a signal to buy anything."],
  ["The token.", "$PUSHD can lose all of its value. It gives no ownership of PUSHD, no share of anything and no other rights. Only use money you can afford to lose."],
  ["The burn.", "Part of every $PUSHD trade's fee buys $PUSHD on the market and burns it. A burn lowers the supply; it does not set or hold up a price."],
  ["Nothing promised.", "No returns, no dates, no listings. Holding unlocks the live feed while the site runs."],
  ["Other people's coins.", "Coins that others launch after a push have nothing to do with PUSHD. PUSHD never trades, launches or buys them. The only thing its contracts buy is $PUSHD, to burn it."],
  ["Contracts.", "$PUSHD runs on smart contracts on chain. Contracts and chains can fail or be attacked. Always check the address on the token page."],
  ["Mistakes happen.", "Summaries come from an AI model and heat is a score. Both can be wrong. Always open the link."],
];

const TERMS: Point[] = [
  ["As is.", "The site and the feed are given as they are, with no warranty. They can be late, wrong or offline."],
  ["Fair use.", "Read it, share lines, link to it. Do not hammer the site with bots or resell the feed without asking."],
  ["Holder access.", "Access to the live feed depends on the $PUSHD balance read from the chain at sign-in and every few minutes after. The amount can change and is shown on the site."],
  ["Changes.", "Features, the watchlist and these terms can change. The site can stop."],
  ["No affiliation.", "GitHub, Pons, MetaMask, the launchpads and the projects on the list are not part of PUSHD. Names appear because their activity is public."],
  ["Your laws.", "You are responsible for following the rules where you live."],
];

const PRIVACY: Point[] = [
  ["No account needed.", "The public site has no sign-up and asks for nothing."],
  ["Wallet sign-in.", "If you sign in with MetaMask, PUSHD sees your public wallet address and a signed message, and reads your $PUSHD balance on the chain. Never your keys. Signing sends nothing and approves nothing."],
  ["What is kept.", "For holders: your wallet address, its last read balance, your watchlist and alert choices, and a sign-in that ends after a week or when you sign out. A cookie holds the sign-in; no script on the page can read it."],
  ["Browser alerts.", "Your browser asks first. You can turn them off in the browser at any time."],
  ["On your device.", "Your theme choice is saved in your browser. No ad trackers."],
  ["Builders.", "PUSHD only shows public GitHub activity. A builder can ask to be taken off the list through the PUSHD X or GitHub account."],
];

function Points({ points }: { points: Point[] }) {
  return (
    <ol>
      {points.map(([b, t]) => (
        <li key={b}>
          <span>
            <b>{b}</b> {t}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function OwnRiskPage() {
  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Prompt path="~/pushd" cmd="cat LEGAL" />
          <h1>
            Own risk, terms
            <br />
            and privacy<span className="acc">.</span>
          </h1>
          <p className="lede">Plain words. Short on purpose.</p>
          <nav className="legal-tabs" aria-label="Sections">
            <a className="chip" href="#own-risk">
              own risk
            </a>
            <a className="chip" href="#terms">
              terms
            </a>
            <a className="chip" href="#privacy">
              privacy
            </a>
          </nav>
        </div>
      </section>

      <div className="wrap legal">
        <section id="own-risk">
          <div className="label">01 &nbsp;OWN RISK</div>
          <h2>Use it at your own risk.</h2>
          <div className="panel callout">{RISK_LINE}</div>
          <Points points={RISK} />
        </section>
        <section id="terms">
          <div className="label">02 &nbsp;TERMS</div>
          <h2>Terms of use.</h2>
          <Points points={TERMS} />
        </section>
        <section id="privacy">
          <div className="label">03 &nbsp;PRIVACY</div>
          <h2>Privacy.</h2>
          <Points points={PRIVACY} />
          <p className="upd">last updated 28 Oct 2026 . prototype text</p>
        </section>
      </div>
    </>
  );
}
