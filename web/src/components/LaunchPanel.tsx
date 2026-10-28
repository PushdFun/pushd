"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { prepareLaunchTx, readLaunchOutcome } from "@/app/token/launch/actions";
import { injectedWallet, metamaskLink, METAMASK_DOWNLOAD, onPhone, ROBINHOOD_CHAIN_HEX, toRobinhoodChain, walletError, type Eip1193 } from "@/lib/wallet";
import type { LaunchedView, LaunchSummary, Prepared, PreparedTx } from "@/lib/token/launch";
import { ethExact, ethUpWords, usdWords, wholeWords } from "@/lib/token/words";
import { CopyButton } from "./CopyButton";

const PONS = (token: string) => `https://ponsfamily.com/launchpad/${token}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const taxWords = (bps: number) => `${bps / 100}%`;
const storeKey = (pot: string) => `pushd-launch-tx:${pot.toLowerCase()}`;
function remember(pot: string, hash: string | null) {
  try {
    if (hash) localStorage.setItem(storeKey(pot), hash);
    else localStorage.removeItem(storeKey(pot));
  } catch {
    /* private mode: the chain check still stops a second launch */
  }
}
function remembered(pot: string): string | null {
  try {
    const v = localStorage.getItem(storeKey(pot));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** What the launch sends, shown before anything is connected. */
export function LaunchSummaryCard({ summary: s }: { summary: LaunchSummary }) {
  return (
    <div className="panel launch-card" aria-label="What the launch sends">
      <div className="eyebrow">the launch</div>
      <div className="launch-token">
        <b>{s.name}</b>
        <span className="tag acc">${s.symbol}</span>
      </div>
      <p className="launch-desc">{s.description}</p>
      <dl className="launch-rows">
        <div>
          <dt>opening buy</dt>
          <dd>{ethExact(s.openingBuyWei)} ETH</dd>
          <small>{s.ethUsd ? `about ${usdWords(s.openingBuyWei, s.ethUsd)}` : "dollar price not available"}</small>
        </div>
        <div>
          <dt>Pons launch fee</dt>
          <dd>{ethExact(s.launchFeeWei)} ETH</dd>
          <small>{s.ethUsd ? `about ${usdWords(s.launchFeeWei, s.ethUsd)}` : ""}</small>
        </div>
        <div className="total">
          <dt>your wallet sends</dt>
          <dd>{ethExact(s.totalWei)} ETH</dd>
          <small>{s.ethUsd ? `about ${usdWords(s.totalWei, s.ethUsd)}, ` : ""}plus the network fee</small>
        </div>
        <div>
          <dt>tax</dt>
          <dd>{taxWords(s.creatorTaxBps)} on every trade</dd>
          <small>fixed at launch</small>
        </div>
        <div>
          <dt>links</dt>
          <dd className="mono small">
            {s.website}
            <br />
            {s.twitter}
          </dd>
        </div>
      </dl>
      <p className="launch-promise">The opening buy lands in the launch wallet in the same transaction, so nothing can buy ahead of it.</p>
      <p className="launch-fine">The opening buy is set on the server and cannot be changed on this page. Dollar figures come from Chainlink&apos;s ETH price and are only a guide.</p>
    </div>
  );
}

type Stage = "idle" | "connect" | "chain" | "check" | "ready" | "refused" | "confirm" | "sent" | "launched" | "failed" | "dropped" | "slow";
type Refusal = Extract<Prepared, { ok: false }>;

const BUSY_WORDS: Partial<Record<Stage, string>> = {
  connect: "Open MetaMask to connect",
  chain: "Moving MetaMask to Robinhood Chain",
  check: "Checking the wallet and running the launch on the network, nothing sent",
  confirm: "Confirm the launch in MetaMask",
  sent: "Sent. Waiting for Robinhood Chain",
};

/**
 * Connect, check, launch. The server builds the transaction and runs it from the launch wallet on the node first
 * (nothing sent); this only hands exactly that to MetaMask, once.
 */
export function LaunchPanel({ summary, explorer }: { summary: LaunchSummary; explorer: string }) {
  const [stage, setStage] = useState<Stage>("idle");
  const [wallet, setWallet] = useState<string | null>(null);
  const [prep, setPrep] = useState<Extract<Prepared, { ok: true }> | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ view: LaunchedView; balanceWei: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Set the moment the button is pressed and never cleared once a transaction hash exists. */
  const sending = useRef(false);
  const watching = useRef(false);

  const watch = useCallback(
    async (h: string) => {
      if (watching.current) return;
      watching.current = true;
      setHash(h);
      setStage("sent");
      const start = Date.now();
      let unknownSince: number | null = null;
      for (;;) {
        const o = await readLaunchOutcome(h).catch(() => ({ state: "pending" as const }));
        if (o.state === "launched") {
          remember(summary.pot, null);
          setLaunched({ view: o.launched, balanceWei: o.balanceWei });
          setStage("launched");
          break;
        }
        if (o.state === "failed") {
          remember(summary.pot, null);
          setFailure(o.problem);
          setStage("failed");
          break;
        }
        if (o.state === "unknown") {
          unknownSince ??= Date.now();
          // Robinhood Chain includes a transaction in about a second; three minutes with the node not knowing it is a dropped one.
          if (Date.now() - unknownSince > 180_000) {
            remember(summary.pot, null);
            setStage("dropped");
            break;
          }
        } else unknownSince = null;
        if (Date.now() - start > 600_000) {
          setStage("slow");
          break;
        }
        await sleep(2000);
      }
      watching.current = false;
    },
    [summary.pot],
  );

  // A launch sent from this browser before a reload: follow it instead of offering the button again.
  useEffect(() => {
    const h = remembered(summary.pot);
    if (!h) return;
    sending.current = true;
    const t = setTimeout(() => void watch(h), 0);
    return () => clearTimeout(t);
  }, [summary.pot, watch]);

  const check = useCallback(async (from: string) => {
    setStage("check");
    setRefusal(null);
    const r = await prepareLaunchTx(from).catch(() => null);
    if (!r) {
      setRefusal({ ok: false, kind: "blocked", problem: "The server did not answer. Reload and try again." });
      setStage("refused");
      return;
    }
    if (!r.ok) {
      setPrep(null);
      setRefusal(r);
      setStage("refused");
      if (r.kind === "launched" && r.launched) {
        setLaunched({ view: r.launched, balanceWei: null });
        setStage("launched");
      }
      return;
    }
    setPrep(r);
    setStage("ready");
  }, []);

  const connect = useCallback(async () => {
    setNote(null);
    const eth = injectedWallet();
    if (!eth) {
      if (onPhone()) {
        window.location.href = metamaskLink("launch");
        return;
      }
      window.open(METAMASK_DOWNLOAD, "_blank", "noopener");
      setNote("No wallet in this browser. Install MetaMask, then reload this page.");
      return;
    }
    setStage("connect");
    let from = "";
    try {
      const list = (await eth.request({ method: "eth_requestAccounts" })) as unknown;
      from = Array.isArray(list) && typeof list[0] === "string" ? list[0] : "";
    } catch (err) {
      setStage("idle");
      setNote(walletError(err, "connect").message);
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
      setStage("idle");
      setNote("MetaMask did not give an address.");
      return;
    }
    setWallet(from);
    setStage("chain");
    try {
      await toRobinhoodChain(eth);
      const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
      if (id !== ROBINHOOD_CHAIN_HEX) throw new Error("still on another chain");
    } catch {
      setStage("idle");
      setNote("MetaMask stayed on another network. Switch it to Robinhood Chain and connect again.");
      return;
    }
    await check(from);
  }, [check]);

  // Opened inside MetaMask's own browser from a phone: connect straight away.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("link") !== "launch" || !injectedWallet() || remembered(summary.pot)) return;
    const t = setTimeout(() => void connect(), 0);
    return () => clearTimeout(t);
  }, [connect, summary.pot]);

  // Another account or another network in MetaMask: everything checked so far no longer holds.
  useEffect(() => {
    const eth = injectedWallet() as (Eip1193 & { on?: (e: string, f: () => void) => void; removeListener?: (e: string, f: () => void) => void }) | null;
    if (!eth?.on) return;
    const reset = () => {
      if (sending.current) return;
      setPrep(null);
      setRefusal(null);
      setWallet(null);
      setStage("idle");
      setNote("MetaMask changed account or network. Connect again.");
    };
    eth.on("accountsChanged", reset);
    eth.on("chainChanged", reset);
    return () => {
      eth.removeListener?.("accountsChanged", reset);
      eth.removeListener?.("chainChanged", reset);
    };
  }, []);

  async function launch() {
    if (sending.current || !prep) return;
    sending.current = true;
    setNote(null);
    const eth = injectedWallet();
    const stop = (msg: string) => {
      sending.current = false;
      setNote(msg);
      setStage("ready");
    };
    if (!eth) return stop("MetaMask is not in this browser any more.");
    setStage("confirm");
    let tx: PreparedTx;
    try {
      const accounts = (await eth.request({ method: "eth_accounts" })) as unknown;
      const now = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      if (!same(now, prep.tx.from)) return stop("MetaMask is on another account now. Connect again.");
      const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
      if (id !== ROBINHOOD_CHAIN_HEX) return stop("MetaMask is not on Robinhood Chain. Connect again.");
      // Right before the wallet sees it: every check again, and the transaction built again by the server.
      const fresh = await prepareLaunchTx(prep.tx.from);
      if (!fresh.ok) {
        sending.current = false;
        setPrep(null);
        setRefusal(fresh);
        setStage("refused");
        return;
      }
      if (!same(fresh.tx.to, prep.tx.to) || fresh.tx.data !== prep.tx.data || fresh.tx.value !== prep.tx.value) {
        setPrep(fresh);
        return stop("Something changed on the chain since this was shown. Look at it again, then press Launch again.");
      }
      tx = fresh.tx;
    } catch {
      return stop("The check before sending did not finish. Nothing was sent; try again.");
    }
    let sent: unknown;
    try {
      sent = await eth.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }] });
    } catch (err) {
      return stop(walletError(err, "send").message.replace("Nothing was paid", "Nothing was sent"));
    }
    if (typeof sent !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(sent)) {
      // Sent or not, a second send must not follow: the page reads the chain again on reload.
      setFailure("MetaMask did not say which transaction it sent. Do not press anything; look at MetaMask's activity and reload this page.");
      setStage("failed");
      return;
    }
    remember(summary.pot, sent);
    await watch(sent);
  }

  const busy = stage in BUSY_WORDS;

  if (stage === "launched" && launched) {
    const v = launched.view;
    const buyDiffers = v.openingBuyEth !== summary.openingBuyWei && v.openingBuyEth !== "0";
    return (
      <div className="panel launch-card launch-done" aria-label="Launched">
        <div className="eyebrow">launched</div>
        <h2>$PUSHD is live.</h2>
        <dl className="launch-rows">
          <div>
            <dt>token</dt>
            <dd className="mono">{v.token}</dd>
            <CopyButton text={v.token} />
          </div>
          <div>
            <dt>in your wallet</dt>
            <dd>{wholeWords(v.openingBuyTokens)} $PUSHD</dd>
            <small>from the opening buy of {ethExact(v.openingBuyEth)} ETH</small>
          </div>
        </dl>
        {buyDiffers && <p className="launch-fine">The opening buy spent {ethExact(v.openingBuyEth)} ETH, not the {ethExact(summary.openingBuyWei)} ETH set; the rest stayed in the burn pot.</p>}
        <div className="launch-links">
          <a className="btn btn-line" href={PONS(v.token)} target="_blank" rel="noreferrer">
            Pons page -&gt;
          </a>
          <a className="btn btn-line" href={`${explorer}/address/${v.token}`} target="_blank" rel="noreferrer">
            Token on the explorer -&gt;
          </a>
          {hash && (
            <a className="btn btn-line" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
              The transaction -&gt;
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="panel launch-card launch-action" aria-label="Launch">
      <div className="eyebrow">launch</div>
      <ol className="launch-steps">
        <li className={wallet ? "done" : ""}>
          <b>Connect MetaMask</b>
          <span>{wallet ? <span className="mono">{wallet}</span> : "On a phone this opens the MetaMask app."}</span>
        </li>
        <li className={prep ? "done" : ""}>
          <b>The launch wallet</b>
          <span>
            Only <span className="mono">{summary.launcher}</span> can launch.
          </span>
        </li>
        <li className={prep ? "done" : ""}>
          <b>A run on the network first</b>
          <span>{prep ? "It went through. Nothing was sent." : "The exact launch runs once on the node from the launch wallet, with nothing sent."}</span>
        </li>
      </ol>

      {stage === "refused" && refusal && (
        <div className="launch-alert" role="alert">
          <b>{refusal.problem}</b>
          {refusal.kind === "wrong_wallet" && refusal.connected && (
            <dl className="launch-pairs">
              <dt>connected</dt>
              <dd className="mono">{refusal.connected}</dd>
              <dt>launch wallet</dt>
              <dd className="mono">{refusal.launcher}</dd>
            </dl>
          )}
          {refusal.kind === "short" && refusal.missingWei && <p>It needs about {ethUpWords(refusal.missingWei)} ETH more, counting room for the network fee.</p>}
          <p className="launch-fine">No button until this is fixed. Switch account or top up in MetaMask, then connect again.</p>
        </div>
      )}

      {prep && (stage === "ready" || stage === "confirm") && (
        <dl className="launch-rows launch-ready">
          <div>
            <dt>token address it will have</dt>
            <dd className="mono">{prep.predictedToken}</dd>
            <small>from the run on the network</small>
          </div>
          <div>
            <dt>network fee, at most about</dt>
            <dd>{ethUpWords(prep.gasCostWei)} ETH</dd>
            <small>MetaMask shows the exact fee</small>
          </div>
        </dl>
      )}

      {(stage === "failed" || stage === "dropped" || stage === "slow") && (
        <div className="launch-alert" role="alert">
          <b>{stage === "failed" ? failure : stage === "dropped" ? "The transaction was dropped: Robinhood Chain never included it. Nothing was launched." : "Robinhood Chain has not included it after ten minutes."}</b>
          <p className="launch-fine">Reload this page to read the chain again before doing anything else.</p>
        </div>
      )}

      {hash && (
        <p className="launch-hash">
          transaction{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono">
            {hash}
          </a>
        </p>
      )}

      <div className="launch-actions">
        {!hash && (stage === "ready" || stage === "confirm") && prep ? (
          <button className="btn btn-acc" type="button" onClick={launch} disabled={stage !== "ready"} aria-busy={stage === "confirm"}>
            Launch $PUSHD
          </button>
        ) : !hash && !busy && stage !== "ready" && stage !== "failed" ? (
          <button className="btn btn-line" type="button" onClick={connect}>
            {wallet ? "Connect again" : "Connect MetaMask"}
          </button>
        ) : null}
      </div>

      {!hash && prep && (stage === "ready" || stage === "confirm") && <p className="launch-fine">One transaction: your wallet sends {ethExact(summary.totalWei)} ETH plus the network fee.</p>}
      {busy && (
        <p role="status" className="launch-busy">
          <span className="cursor" aria-hidden="true" /> {BUSY_WORDS[stage]}
        </p>
      )}
      {note && (
        <p role="alert" className="launch-note">
          {note}
        </p>
      )}
    </div>
  );
}
