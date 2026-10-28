import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/CopyButton";
import { LaunchPanel, LaunchSummaryCard } from "@/components/LaunchPanel";
import { Prompt } from "@/components/Prompt";
import { ponsPage, siteTokenConfig } from "@/lib/token/config";
import { launchPageOn, launchStatus } from "@/lib/token/launch";
import { launchDeps } from "@/lib/token/launch-server";
import { ethExact, wholeWords } from "@/lib/token/words";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Launch $PUSHD",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

/**
 * /token/launch: where the launch wallet launches $PUSHD from its own MetaMask. Linked from nowhere, and a 404 unless
 * PUSHD_LAUNCH_PAGE=on. Every check is read from the chain on each load (src/lib/token/launch.ts); any that fails is
 * one sentence and no button.
 */
export default async function LaunchPage() {
  if (!launchPageOn()) notFound();
  const explorer = siteTokenConfig().explorer;
  const status = await launchStatus(launchDeps());

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Prompt path="~/pushd/token" cmd="pushd launch --once" />
          <h1>
            Launch $PUSHD<span className="acc">.</span>
          </h1>
          <p className="lede">
            One transaction from the launch wallet&apos;s own MetaMask. This page builds it, checks it against Robinhood Chain and runs it once on the
            network before you sign. Your key never leaves your wallet.
          </p>
        </div>
      </section>

      <section className="wrap launch-wrap">
        {status.kind === "blocked" || status.kind === "no_dev_buy" ? (
          <div className="panel launch-stop" role="alert">
            <span className="sig">{status.kind === "no_dev_buy" ? "not ready" : "stopped"}</span>
            <div>
              <h3>{status.problem}</h3>
              <p>Nothing can be sent from this page until this is fixed. Reload to check again.</p>
            </div>
          </div>
        ) : status.kind === "launched" ? (
          <div className="panel launch-card launch-done" aria-label="$PUSHD is launched">
            <div className="eyebrow">already launched</div>
            <h2>$PUSHD is live.</h2>
            <p className="launch-fine">The burn pot launched it. A second launch is not possible.</p>
            <dl className="launch-rows">
              <div>
                <dt>token</dt>
                <dd className="mono">{status.launched.token}</dd>
                <CopyButton text={status.launched.token} />
              </div>
              <div>
                <dt>opening buy</dt>
                <dd>
                  {wholeWords(status.launched.openingBuyTokens)} $PUSHD for {ethExact(status.launched.openingBuyEth)} ETH
                </dd>
              </div>
            </dl>
            <div className="launch-links">
              <a className="btn btn-line" href={ponsPage(status.launched.token)} target="_blank" rel="noreferrer">
                Pons page -&gt;
              </a>
              <a className="btn btn-line" href={`${explorer}/address/${status.launched.token}`} target="_blank" rel="noreferrer">
                Explorer -&gt;
              </a>
            </div>
          </div>
        ) : (
          <div className="launch-grid">
            <LaunchSummaryCard summary={status.summary} />
            <LaunchPanel summary={status.summary} explorer={explorer} />
          </div>
        )}
      </section>
    </>
  );
}
