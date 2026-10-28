import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { Prompt } from "@/components/Prompt";
import { getBuyLink, getToken } from "@/lib/data";
import { ethWords, percentWords, shortAddress, shortWords, untilWords, utcWords, wholeWords } from "@/lib/token/words";
import type { TokenPanel } from "@/lib/types";

export const metadata: Metadata = {
  title: "PUSHD Token",
  description: "$PUSHD, the token of PUSHD. Part of every trade's fee buys $PUSHD back and burns it, so the supply only goes down.",
  alternates: { canonical: "/token" },
};

// Laid out like the other token pages: what it is and the burn at a glance, what it does, the burn read live, the
// contracts, own risk. Only the burn is talked about: never the fee split, the tax rate or the chain.
const STAGE: Record<TokenPanel["stage"], string> = {
  soon: "launching soon",
  deployed: "contracts live, token launching soon",
  live: "live",
};

const STEPS = ["Every trade of $PUSHD pays a fee", "Part of it buys $PUSHD on the market", "The token's own burn destroys it", "The supply goes down, on chain"];

export default async function TokenPage() {
  const [p, buy] = await Promise.all([getToken(), getBuyLink()]);
  const live = p.stage === "live";
  const token = p.token ?? buy.token;
  const min = Number(p.holderMin).toLocaleString("en-US");
  const started = live && p.count > 0 && Boolean(p.burned);
  const burnedShare = live && p.burned && p.launchSupply ? percentWords(p.burned, p.launchSupply) : null;
  const cards: [string, string][] = [
    ["Trades burn it", "Every $PUSHD trade pays a fee. Part of it buys $PUSHD on the market and destroys it with the token's own burn, so the total supply really goes down. Nothing is parked at a dead address."],
    ["Every burn in the open", "Each burn is a transaction on chain. The burn panel below reads them live, with a link to each one, so anyone can check them."],
    ["Hold it, see it live", `Hold ${min} $PUSHD in the wallet you sign in with and the feed opens live, with no delay, plus your own watchlist and browser alerts.`],
  ];
  const contracts = (
    [
      ["$PUSHD", "the token", token],
      ["burn pot", "buys $PUSHD and burns it", p.pot],
    ] as const
  ).filter(([, , v]) => v);

  return (
    <>
      <section className="wrap token-hero">
        <div>
          <Prompt path="~/pushd/token" cmd="pushd token --info" />
          <span className={live ? "tag acc live" : "tag acc"} style={{ marginTop: 26, display: "inline-flex" }}>
            {STAGE[p.stage]}
          </span>
          <h1 className="ticker" style={{ marginTop: 18 }}>
            <span className="d">$</span>PUSHD
          </h1>
          <p className="lede">The token of PUSHD. Part of every trade&apos;s fee buys $PUSHD back and burns it, so the supply only goes down.</p>
          <div className="hero-cta" style={{ marginTop: 28 }}>
            {live && buy.href ? (
              <a className="btn btn-acc" href={buy.href} target="_blank" rel="noreferrer">
                Buy $PUSHD on Pons -&gt;
              </a>
            ) : (
              <Link className="btn btn-acc" href="/feed">
                Watch the feed meanwhile
              </Link>
            )}
            <a className="btn btn-line" href="#burns">
              See the burn
            </a>
          </div>
        </div>
        <aside className="panel burn-glance" aria-label="The burn at a glance">
          <div className="eyebrow">the burn</div>
          <h3>{live ? "Read live from the chain" : "Starts with the first trades"}</h3>
          {live ? (
            <dl className="kv2">
              <div>
                <dt>Burned so far</dt>
                <dd>{started ? `${shortWords(p.burned!)} $PUSHD` : "not started"}</dd>
              </div>
              <div>
                <dt>Supply now</dt>
                <dd>{p.supply ? wholeWords(p.supply) : "not read yet"}</dd>
              </div>
              <div>
                <dt>Last burn</dt>
                <dd>{p.lastBurnAt ? utcWords(p.lastBurnAt) : "not yet"}</dd>
              </div>
            </dl>
          ) : (
            <ol className="glance-steps">
              {STEPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          )}
          <a className="textlink" href="#burns">
            every burn, with its transaction -&gt;
          </a>
        </aside>
      </section>

      <section className="wrap" style={{ paddingBottom: 24 }}>
        <div className="timeline cards3">
          {cards.map(([h, t], i) => (
            <div key={h} className="tstep">
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <h3 style={{ marginTop: 14 }}>{h}</h3>
              <p>{t}</p>
            </div>
          ))}
        </div>
      </section>

      {p.stale && (
        <section className="wrap">
          <div className="panel token-note" role="status">
            {p.problem ?? `The chain did not answer just now. These numbers are the last reading, from ${utcWords(p.readAt)}.`}
          </div>
        </section>
      )}

      <section className="section" id="burns">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">the burn</div>
              <h2>Read live from the chain.</h2>
            </div>
          </div>
        </div>
        {!live && (
          <div className="wrap">
            <div className="panel token-note">The burn panel goes live with the token: every burn shows here with its transaction.</div>
          </div>
        )}
      {live && (
        <section className="wrap" aria-label="Burned so far">
          <div className="burn-tiles">
            <div className="panel burn-tile big">
              <div className="k">burned so far</div>
              <div className="v">
                {p.burned ? shortWords(p.burned) : "0"}
                <small>$PUSHD</small>
              </div>
              <p>
                {p.count > 0
                  ? `In ${p.count.toLocaleString("en-US")} burn${p.count === 1 ? "" : "s"}, ${ethWords(p.ethSpent ?? "0")} ETH spent buying it on the market.`
                  : "The first burn comes once trading fees have built up. It shows here the minute it lands."}
              </p>
            </div>
            <div className="panel burn-tile">
              <div className="k">supply now</div>
              <div className="v">{p.supply ? shortWords(p.supply) : "not read yet"}</div>
              <p>{p.supply ? `${wholeWords(p.supply)} $PUSHD` : ""}</p>
            </div>
            <div className="panel burn-tile">
              <div className="k">supply at launch</div>
              <div className="v">{p.launchSupply ? shortWords(p.launchSupply) : "not read yet"}</div>
              <p>{p.launchSupply ? `${wholeWords(p.launchSupply)} $PUSHD` : ""}</p>
            </div>
            <div className="panel burn-tile">
              <div className="k">of the supply burned</div>
              <div className="v">{burnedShare ?? "0.00%"}</div>
              <div className="burn-bar" aria-hidden="true">
                <i style={{ width: burnedShare ? `max(3px, ${burnedShare})` : "0" }} />
              </div>
            </div>
          </div>
        </section>
      )}

      {live && (
        <section className="section" style={{ paddingTop: 16, paddingBottom: 48 }}>
          <div className="wrap burn-grid">
            <div className="panel burn-next" aria-label="The next burn">
              <div className="eyebrow">next burn</div>
              <h3>{p.next ? (p.next.ready ? "Ready now" : p.next.at ? `Due ${untilWords(p.next.at, p.readAt)}` : "Waiting") : "Nothing waiting yet"}</h3>
              <p>
                {p.next
                  ? p.next.ready
                    ? "The burn can go through now. Anyone can call it; PUSHD's keeper does on a schedule."
                    : p.next.at
                      ? `Not before ${utcWords(p.next.at)}. Burns are spaced out, and a small amount waits for more.`
                      : "It goes when the burn pot allows it."
                  : "Fees from trades collect in the burn pot until the next burn."}
              </p>
              {p.next && (
                <dl className="kv2">
                  <div>
                    <dt>ETH waiting to buy $PUSHD</dt>
                    <dd>{ethWords(p.next.eth)} ETH</dd>
                  </div>
                  <div>
                    <dt>$PUSHD waiting to burn</dt>
                    <dd>{wholeWords(p.next.tokens)}</dd>
                  </div>
                </dl>
              )}
              <p className="small-note">{p.lastBurnAt ? `Last burn ${utcWords(p.lastBurnAt)}.` : "No burn yet."}</p>
            </div>
            <div className="panel burn-list" aria-label="Recent burns">
              <div className="eyebrow">recent burns</div>
              {p.latest.length === 0 ? (
                <p className="muted">No burns yet. The first one lands once fees have built up in the burn pot.</p>
              ) : (
                <div className="table-wrap">
                  <table className="btable">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>when</th>
                        <th>$PUSHD burned</th>
                        <th>ETH spent</th>
                        <th>tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.latest.map((b) => (
                        <tr key={b.n}>
                          <td className="n">{b.n}</td>
                          <td>{utcWords(b.at)}</td>
                          <td>
                            <b>{wholeWords(b.tokens)}</b>
                          </td>
                          <td>{ethWords(b.eth)}</td>
                          <td>
                            <a className="textlink" href={`${p.explorer}/tx/${b.tx}`} target="_blank" rel="noreferrer">
                              {shortAddress(b.tx, 8, 6)}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="small-note burn-src">Read from the burn pot&apos;s own events on chain. Each line links to its transaction.</p>
            </div>
          </div>
        </section>
      )}

      </section>

      <section className="wrap" id="contracts" style={{ marginBottom: 72 }}>
        <div className="panel addrs" aria-label="The contracts">
          <div className="eyebrow">the contracts</div>
          {contracts.length ? (
            contracts.map(([label, hint, value]) => (
              <div key={label} className="addr-row">
                <span>
                  <b>{label}</b>
                  <small>{hint}</small>
                </span>
                <span className="mono addr-v">{value}</span>
                <span className="addr-tools">
                  <CopyButton text={value!} />
                  <a className="textlink" href={`${p.explorer}/address/${value}`} target="_blank" rel="noreferrer">
                    explorer -&gt;
                  </a>
                </span>
              </div>
            ))
          ) : (
            <p className="muted">The addresses go here the moment the contracts are on the chain. Only trust the address on this page and on the PUSHD X account.</p>
          )}
          <p className="small-note">
            The burn pot can only buy $PUSHD and burn it: it has no owner, no withdraw and no way to send its ETH anywhere else. A burn spends at
            most a small slice of the market&apos;s depth and waits at least half an hour after the last one, and anyone can call it; PUSHD&apos;s keeper
            does, on a schedule. Nobody can change what goes to the burn pot, or the pot itself.
          </p>
        </div>
      </section>

      <section className="wrap">
        <div className="panel riskbox">
          <span className="sig">own risk</span>
          <div>
            <h3>At your own risk.</h3>
            <p>
              $PUSHD comes with no promise of any value. Holding it gives no right to any revenue, no share in PUSHD and no say in it; its price
              can fall to zero and nobody owes you anything for it. Not financial advice. Check every transaction in your own wallet before you
              sign it.
            </p>
          </div>
          <Link className="textlink" href="/own-risk">
            read own risk -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}
