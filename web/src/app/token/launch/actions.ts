"use server";

/**
 * The launch page's two server steps. Both read only: the first builds the exact launch transaction for the
 * connected wallet after every check (and runs it on the node without sending it), the second reads what happened
 * after the wallet sent it. Neither does anything unless PUSHD_LAUNCH_PAGE=on.
 */
import { launchOutcome, launchPageOn, prepareLaunch, type Outcome, type Prepared } from "@/lib/token/launch";
import { launchDeps } from "@/lib/token/launch-server";

const OFF = "This page is switched off.";

export async function prepareLaunchTx(from: string): Promise<Prepared> {
  if (!launchPageOn()) return { ok: false, kind: "blocked", problem: OFF };
  if (typeof from !== "string") return { ok: false, kind: "wrong_wallet", problem: "The wallet did not give an address." };
  return prepareLaunch(launchDeps(), from.trim());
}

export async function readLaunchOutcome(hash: string): Promise<Outcome> {
  if (!launchPageOn()) return { state: "failed", problem: OFF };
  if (typeof hash !== "string") return { state: "failed", problem: "That is not a transaction hash." };
  try {
    return await launchOutcome(launchDeps(), hash.trim());
  } catch {
    // A silent node is not a failed launch: the page asks again.
    return { state: "pending" };
  }
}
