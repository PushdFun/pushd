import type { Metadata } from "next";
import Link from "next/link";
import { MyScoutEditor } from "@/components/MyScoutEditor";
import { Prompt } from "@/components/Prompt";
import { getHolder, getHolderWatch, getMyScouts, getToken, getWatchlist } from "@/lib/data";
import { itemHref } from "@/lib/lookup";
import { agoWords } from "@/lib/format";
import { KIND_LABEL } from "@/lib/groups";
import { NOT_ADVICE } from "@/lib/scouts";

export const metadata: Metadata = {
  title: "PUSHD My scout",
  description: "Holders describe in plain words what to watch. PUSHD turns it into a rule and sends the hits.",
  alternates: { canonical: "/my-scout" },
};

/** The owner's example, as the template parser reads it against the real watchlist. Shown, never saved. */
const EXAMPLE = {
  text: "tell me when a Solana project creates a repo about agents or payments",
  who: ["aeyakovenko", "garious", "mvines", "jstarry"],
  what: "new repos",
  about: ['"tokens"', '"payments"'],
  readable: 'Tell me about new repos from aeyakovenko, garious, mvines or jstarry that mention "tokens" or "payments".',
};

export default async function MyScoutPage() {
  const [token, holder] = await Promise.all([getToken(), getHolder()]);
  const isHolder = !!holder?.status.holder;
  const [mine, wl, watching] = isHolder ? await Promise.all([getMyScouts(), getWatchlist({ all: true }), getHolderWatch()]) : [null, null, null];
  const launched = token.stage === "live";
  const asOf = new Date().toISOString();
  const tag = isHolder ? "signed in . holder" : holder ? "signed in" : launched ? "holders only" : "opens at launch";

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/my-scout" cmd="pushd scout new" />
              <h1>
                Your own scout<span className="acc">.</span>
              </h1>
              <p className="lede">
                Say in plain words what to watch. PUSHD turns it into a rule you can read and edit, then checks every new line against it the moment the
                watcher has it. Hits land here and in your alerts.
              </p>
            </div>
            <span className={isHolder ? "tag acc live" : "tag acc"}>{tag}</span>
          </div>
        </div>
      </section>

      {isHolder && mine ? (
        <section className="section" style={{ paddingTop: 48 }}>
          <div className="wrap ms-grid">
            <MyScoutEditor view={mine.view} builders={(wl?.groups ?? []).flatMap((g) => g.members)} watched={(watching?.accounts ?? []).map((a) => a.login)} />
            <aside className="panel ms-inbox" id="inbox">
              <div className="ptitle">
                <h3>Inbox</h3>
                <span>{mine.hits.length ? `${mine.hits.length} latest` : "empty"}</span>
              </div>
              {mine.hits.length ? (
                <ol>
                  {mine.hits.map((h) => (
                    <li key={h.n} id={`hit-${h.item.id}`}>
                      <div className="mi-top">
                        <span className="mi-scout">{h.scoutName}</span>
                        <span className="muted">{agoWords(new Date(h.at).toISOString(), asOf)}</span>
                      </div>
                      <Link href={itemHref(h.item)} className="mi-what">
                        {h.item.handle} <span className="sl">/</span> <span className="r">{h.item.version ? `${h.item.repo} ${h.item.version}` : h.item.repo}</span>
                      </Link>
                      <p>{h.item.call?.line ?? h.item.summary}</p>
                      <small>{h.why}</small>
                      {h.modelWhy && (
                        <small className="mi-model">
                          <span className="stag model">model note</span> {h.modelWhy}
                        </small>
                      )}
                      <span className="kind">{KIND_LABEL[h.item.kind]}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="estate">
                  <b>No hits yet.</b>
                  <span>Matches land here the moment the watcher stores a line your scout fits. With alerts on (on Holders) they reach you with this tab closed too.</span>
                </div>
              )}
              <p className="small-note">{NOT_ADVICE}</p>
            </aside>
          </div>
          <div className="wrap">
            <div className="tiers">
              <span className="k">scouts by holding</span>
              {mine.view.tiers.map((t) => (
                <span key={t.minWhole} className="tchip">
                  {Number(t.minWhole).toLocaleString("en-US")} $PUSHD: {t.scouts}
                </span>
              ))}
              <span className="muted">Matching costs no model call. The model writes the draft, and a short note on a hit, within PUSHD&apos;s daily cap.</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="section" style={{ paddingTop: 48 }}>
          <div className="wrap ms-grid">
            <div className="panel ms-locked">
              <span className="tag sample">Example</span>
              <div className="ms-text example">{EXAMPLE.text}</div>
              <div className="ms-rule">
                <div className="ms-readable">
                  <span className="k">the rule it becomes</span>
                  <p>{EXAMPLE.readable}</p>
                </div>
                <div className="ms-field">
                  <span className="k">who</span>
                  <div className="chips">
                    {EXAMPLE.who.map((h) => (
                      <span key={h} className="chip on">
                        {h}
                        <span className="n">Solana</span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ms-field">
                  <span className="k">what</span>
                  <div className="chips">
                    <span className="chip on">new repo</span>
                  </div>
                </div>
                <div className="ms-field">
                  <span className="k">about</span>
                  <div className="chips">
                    {EXAMPLE.about.map((a) => (
                      <span key={a} className="chip on">
                        {a.replace(/"/g, "")}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ms-field">
                  <span className="k">heat</span>
                  <b className="ms-hint">any heat</b>
                </div>
              </div>
            </div>
            <aside className="panel ms-how">
              <h3>{launched ? (holder ? "This wallet does not hold enough $PUSHD." : "Sign in as a holder.") : "Opens at launch."}</h3>
              <p className="muted">
                {launched
                  ? holder
                    ? "Your own scouts open from the holder threshold. How many you can keep follows your holding."
                    : "Your own scouts are for $PUSHD holders. Sign in with MetaMask on the Holders page; it sends nothing and approves nothing."
                  : "Your own scouts open for $PUSHD holders once $PUSHD exists. How many you can keep follows your holding."}
              </p>
              <ol className="pay-steps tight">
                <li>
                  <b>Say it.</b> In plain words, like the example.
                </li>
                <li>
                  <b>Check it.</b> PUSHD drafts a rule: builders or camps, kinds, words, a heat floor. Edit anything.
                </li>
                <li>
                  <b>Save it.</b> Every new line is matched with no model call. A hit says which parts matched.
                </li>
                <li>
                  <b>Get it.</b> In this inbox, in the open tab, and as a push alert with the site closed when alerts are on.
                </li>
              </ol>
              <Link className="btn btn-acc" href="/holders">
                {launched ? "holder sign-in" : "what holders get"} -&gt;
              </Link>
            </aside>
          </div>
        </section>
      )}
    </>
  );
}
