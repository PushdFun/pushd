"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GROUPS } from "@/lib/groups";
import { wholeWords, shortAddress } from "@/lib/token/words";
import type { AlertHeat, Builder, HolderView } from "@/lib/types";
import { injectedWallet, metamaskLink, METAMASK_DOWNLOAD, onPhone, utf8Hex, walletError } from "@/lib/wallet";
import { PushAlerts } from "./PushAlerts";

// Holder sign-in on /holders: MetaMask signs one message (no transaction), the engine checks it and reads the
// wallet's $PUSHD on the chain. On a phone the button opens this page inside MetaMask's own browser, where the
// sign-in starts again by itself (?link=holder). The session lives in an httpOnly cookie; this page never sees it.

type Refused = { problem: string; balanceWei?: string | null; minWhole?: string };

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const MetaMaskIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M16 12.5h2M3 9h14V6" />
  </svg>
);

/** The sign-in card: closed before launch, a button after, the wallet once signed in. */
export function HolderSignIn({ launched, minWhole, holder }: { launched: boolean; minWhole: string; holder: HolderView | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const started = useRef(false);
  const min = Number(minWhole).toLocaleString("en-US");

  const signIn = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setNote(null);
    setRefused(null);
    const done = () => {
      started.current = false;
      setBusy(null);
    };
    const eth = injectedWallet();
    if (!eth) {
      done();
      if (onPhone()) {
        window.location.href = metamaskLink("holder");
        return;
      }
      window.open(METAMASK_DOWNLOAD, "_blank", "noopener");
      setNote("No wallet in this browser. Install MetaMask, then reload this page.");
      return;
    }
    let from = "";
    try {
      setBusy("Open MetaMask to connect");
      const list = (await eth.request({ method: "eth_requestAccounts" })) as unknown;
      from = Array.isArray(list) && typeof list[0] === "string" ? list[0] : "";
    } catch (err) {
      done();
      setNote(walletError(err, "connect").message);
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
      done();
      setNote("MetaMask did not give an address.");
      return;
    }
    setBusy("Asking PUSHD for the message to sign");
    const c = await postJson("/api/holder/challenge", { address: from }).catch(() => null);
    if (!c || c.status !== 200 || typeof c.body.message !== "string" || typeof c.body.nonce !== "string") {
      done();
      setNote(typeof c?.body.error === "string" ? c.body.error : "PUSHD's server did not answer. Try again in a minute.");
      return;
    }
    let signature: unknown;
    try {
      setBusy("Sign the message in MetaMask. It sends nothing and approves nothing.");
      signature = await eth.request({ method: "personal_sign", params: [utf8Hex(c.body.message), from] });
    } catch (err) {
      done();
      setNote(walletError(err, "sign").message);
      return;
    }
    setBusy("Checking the signature and your $PUSHD on the chain");
    const s = await postJson("/api/holder/session", { address: from, nonce: c.body.nonce, signature }).catch(() => null);
    done();
    if (s?.status === 200) {
      router.refresh();
      return;
    }
    const st = s?.body.status as { balanceWei?: string | null; minWhole?: string } | undefined;
    setRefused({ problem: typeof s?.body.error === "string" ? s.body.error : "The sign-in did not go through. Try again.", balanceWei: st?.balanceWei, minWhole: st?.minWhole });
  }, [router]);

  // Opened inside MetaMask's own browser from a phone: start straight away.
  useEffect(() => {
    if (!launched || holder || new URLSearchParams(window.location.search).get("link") !== "holder" || !injectedWallet()) return;
    const t = setTimeout(() => void signIn(), 0);
    return () => clearTimeout(t);
  }, [launched, holder, signIn]);

  const signOut = async () => {
    setBusy("Signing out");
    await fetch("/api/holder/signout", { method: "POST" }).catch(() => null);
    setBusy(null);
    router.refresh();
  };

  if (holder) {
    const st = holder.status;
    return (
      <div className="panel signin" aria-label="Signed in">
        <div className="eyebrow">signed in</div>
        <h3>{st.holder ? "The live feed is open." : "The live feed is closed for now."}</h3>
        <dl className="kv2">
          <div>
            <dt>wallet</dt>
            <dd className="mono">{shortAddress(st.address, 8, 6)}</dd>
          </div>
          <div>
            <dt>$PUSHD held</dt>
            <dd>{st.balanceWei === null ? "not read just now" : wholeWords(st.balanceWei)}</dd>
          </div>
          <div>
            <dt>needed</dt>
            <dd>{Number(st.minWhole).toLocaleString("en-US")}</dd>
          </div>
        </dl>
        <p>
          {st.holder
            ? "Your balance is read from the chain again every few minutes while you use the site. Nothing is held, paid or staked."
            : `This wallet holds less than ${Number(st.minWhole).toLocaleString("en-US")} $PUSHD right now, so the feed runs at the public delay.`}
        </p>
        <div className="signin-actions">
          {st.holder && (
            <Link className="btn btn-acc" href="/feed">
              Open the live feed -&gt;
            </Link>
          )}
          <button className="btn btn-line" type="button" onClick={signOut} disabled={!!busy}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel signin" aria-label="Sign in">
      <div className="eyebrow">sign in</div>
      <h3>Sign in with MetaMask</h3>
      <p>
        One signature proves the wallet is yours. PUSHD then reads your $PUSHD balance on the chain. It never asks you to send, swap or
        approve anything.
      </p>
      <div className="steps-mini">
        <div>
          <b>1</b>
          <span>connect MetaMask (on a phone, the MetaMask app)</span>
        </div>
        <div>
          <b>2</b>
          <span>sign a message, not a transaction</span>
        </div>
        <div>
          <b>3</b>
          <span>from {min} $PUSHD the live feed opens</span>
        </div>
      </div>
      {refused && (
        <div className="signin-alert" role="alert">
          <b>{refused.problem}</b>
          {refused.balanceWei != null && (
            <span>
              Held: {wholeWords(refused.balanceWei)} $PUSHD. Needed: {Number(refused.minWhole ?? minWhole).toLocaleString("en-US")}.
            </span>
          )}
        </div>
      )}
      {launched ? (
        <button className="btn btn-acc signin-btn" type="button" onClick={signIn} disabled={!!busy}>
          <MetaMaskIcon /> Sign in with MetaMask
        </button>
      ) : (
        <button className="btn btn-off" type="button" disabled>
          <MetaMaskIcon /> Sign in with MetaMask . at launch
        </button>
      )}
      {!launched && <p className="signin-fine">Holder sign-in opens at launch, once $PUSHD exists.</p>}
      {busy && (
        <p className="signin-fine" role="status">
          <span className="cursor" aria-hidden="true" /> {busy}
        </p>
      )}
      {note && (
        <p className="signin-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

const ALERT_LEVELS: { value: AlertHeat; label: string }[] = [
  { value: "off", label: "off" },
  { value: "veryHigh", label: "very high only" },
  { value: "high", label: "high and up" },
  { value: "medium", label: "medium and up" },
  { value: "low", label: "every line" },
];

type Mark = "none" | "follow" | "mute";

function permission(): string {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}
const subscribeNothing = () => () => undefined;

/** A holder's own watchlist (follow and mute, from the shared list) and browser alerts. */
export function HolderTools({ holder, builders }: { holder: HolderView; builders: Builder[] }) {
  const [follow, setFollow] = useState<string[]>(holder.prefs.follow);
  const [mute, setMute] = useState<string[]>(holder.prefs.mute);
  const [alertHeat, setAlertHeat] = useState<AlertHeat>(holder.prefs.alertHeat);
  const [alertMine, setAlertMine] = useState(holder.prefs.alertMine);
  const [q, setQ] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const perm = useSyncExternalStore(subscribeNothing, permission, () => "unknown");
  void asked;

  const markOf = (h: string): Mark => (follow.includes(h) ? "follow" : mute.includes(h) ? "mute" : "none");
  const setMark = (h: string, m: Mark) => {
    setFollow((f) => (m === "follow" ? [...f.filter((x) => x !== h), h] : f.filter((x) => x !== h)));
    setMute((f) => (m === "mute" ? [...f.filter((x) => x !== h), h] : f.filter((x) => x !== h)));
    setSaved(null);
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/^@/, "");
    return builders.filter((b) => !s || b.handle.toLowerCase().includes(s) || (b.name ?? "").toLowerCase().includes(s) || (b.org ?? "").toLowerCase().includes(s));
  }, [builders, q]);

  const save = async () => {
    setSaved("saving");
    const res = await fetch("/api/holder/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ follow, mute, alertHeat, alertMine }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
    setSaved(res?.ok ? "saved" : (body.error ?? "not saved, try again"));
    if (res?.ok) window.dispatchEvent(new Event("pushd:prefs"));
  };

  const allow = async () => {
    if (!("Notification" in window)) return;
    await Notification.requestPermission().catch(() => "denied");
    setAsked((n) => n + 1);
    window.dispatchEvent(new Event("pushd:prefs"));
  };

  return (
    <div className="holder-tools">
      <div className="panel ht-list" aria-label="Your own watchlist">
        <div className="ht-head">
          <div>
            <div className="eyebrow">your watchlist</div>
            <h3>Follow some, mute some.</h3>
            <p className="muted">
              Followed builders get their own filter on the feed. Muted ones leave your feed. {follow.length} followed, {mute.length} muted.
            </p>
          </div>
          <input className="ht-search" type="search" placeholder="a handle or a name" aria-label="Search the watchlist" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="ht-rows">
          {shown.map((b) => {
            const m = markOf(b.handle);
            return (
              <li key={b.handle} className={`ht-row ${m}`}>
                <span className="ht-who">
                  <b>{b.handle}</b>
                  <small>
                    {b.name && b.name !== b.handle ? `${b.name} . ` : ""}
                    {GROUPS[b.group].short}
                  </small>
                </span>
                <span className="ht-btns">
                  <button type="button" className="chip" aria-pressed={m === "follow"} onClick={() => setMark(b.handle, m === "follow" ? "none" : "follow")}>
                    follow
                  </button>
                  <button type="button" className="chip" aria-pressed={m === "mute"} onClick={() => setMark(b.handle, m === "mute" ? "none" : "mute")}>
                    mute
                  </button>
                </span>
              </li>
            );
          })}
          {shown.length === 0 && <li className="ht-empty">nobody on the list matches.</li>}
        </ul>
      </div>

      <div className="panel ht-alerts" aria-label="Browser alerts">
        <div className="eyebrow">browser alerts</div>
        <h3>Get a ping when a line crosses your heat.</h3>
        <p className="muted">Alerts come while PUSHD is open in a tab of this browser. Your browser asks first, and you can turn them off here or in the browser.</p>
        <label className="ht-field">
          <span>alert me at</span>
          <select className="select" value={alertHeat} onChange={(e) => (setAlertHeat(e.target.value as AlertHeat), setSaved(null))}>
            {ALERT_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ht-check">
          <input type="checkbox" checked={alertMine} onChange={(e) => (setAlertMine(e.target.checked), setSaved(null))} />
          <span>only for builders I follow</span>
        </label>
        <div className="ht-perm">
          <span>
            browser:{" "}
            <b>{perm === "granted" ? "allowed" : perm === "denied" ? "blocked (change it in the browser's site settings)" : perm === "unsupported" ? "no alerts in this browser" : "not asked yet"}</b>
          </span>
          {perm === "default" && (
            <button className="btn btn-line" type="button" onClick={allow}>
              Allow browser alerts
            </button>
          )}
        </div>
        <PushAlerts />
        <div className="ht-save">
          <button className="btn btn-acc" type="button" onClick={save} disabled={saved === "saving"}>
            Save my choices
          </button>
          {saved && <span role="status">{saved}</span>}
        </div>
      </div>
    </div>
  );
}
