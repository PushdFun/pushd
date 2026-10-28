/**
 * SERVER ONLY. The page the launcher launches $PUSHD from (/token/launch): every
 * check, read fresh from the chain on every load and again right before the
 * transaction is handed to the wallet, and what happened after it was sent.
 *
 * Nothing here signs or sends. It reads, it builds the exact launch call
 * (launch-plan.ts) and it asks the node to run that call from the launcher
 * wallet without sending it (eth_call), which needs no signature. Any check
 * that fails is a plain sentence and no button: the page refuses rather than
 * guesses.
 *
 * Tests hand in their own LaunchReader; launch-chain.ts is the viem one.
 */
import type { Hex } from "viem";
import { PONS_FACTORY, ROBINHOOD_CHAIN_ID, isAddress, sameAddress } from "./config";
import { buildLaunchTx, checkLaunchFile, decodeRevert, hex, openingBuyFromEnv, type LaunchFile } from "./launch-plan";

export const BPS = 10_000;
/** eth_estimateGas plus a quarter. */
export const GAS_MARGIN_PCT = 125;
/** The gas price is doubled for the balance check, so a rising base fee cannot leave the wallet short. */
export const GAS_PRICE_MARGIN = 2;
/** Before the node can estimate (the wallet does not hold the value yet), the gas is reckoned at this many units. */
export const GAS_GUESS = BigInt(8_000_000);
const ZERO_ADDR = /^0x0{40}$/i;

export type PotReads = { launcher: string; splitter: string; factory: string; poolManager: string; hook: string; token: string; openingBuyEth: bigint; openingBuyTokens: bigint; creatorTaxBps: number };
export type SplitterReads = { owner: string; burnPot: string; escrow: string; ownerBps: number; burnBps: number };
export type FactoryReads = { launchFee: bigint; economics: Hex; poolManager: string; memeHook: string; feeEscrow: string; graduationThreshold: bigint };
export type SimResult = { ok: true; returned: Hex } | { ok: false; revertData: Hex | null; message: string };
export type TxReceipt = { status: "success" | "reverted"; from: string; to: string | null; block: number };
export type LaunchedInfo = { exists: boolean; deployer: string; creatorFeeRecipient: string; creatorTaxBps: number; pairToken: string; buybackEnabled: boolean };

/** Everything the launch page reads. One call per method; nothing cached. */
export interface LaunchReader {
  chainId(): Promise<number>;
  hasCode(address: string): Promise<boolean>;
  pot(pot: string): Promise<PotReads>;
  splitter(splitter: string): Promise<SplitterReads>;
  /** launchFee(), previewLaunchEconomics(0, address(0)), the wiring and launch config 0's graduation threshold. */
  factory(factory: string): Promise<FactoryReads>;
  balance(address: string): Promise<bigint>;
  /** The wallet's nonce at the latest block and counting what the node has waiting. */
  nonces(address: string): Promise<{ latest: number; pending: number }>;
  gasPrice(): Promise<bigint>;
  /** eth_call of the exact transaction from `from`: no signature, nothing sent. */
  simulate(tx: { from: string; to: string; data: Hex; value: bigint }): Promise<SimResult>;
  estimateGas(tx: { from: string; to: string; data: Hex; value: bigint }): Promise<bigint>;
  /** ETH / USD with 8 decimals, or null when the feed is stale or silent. Read only, for the dollar figure. */
  ethUsd(): Promise<bigint | null>;
  /** The HTTP status and content type the logo link answers with (redirects are not followed, like curl). */
  logo(url: string): Promise<{ status: number; contentType: string }>;
  receipt(hash: string): Promise<TxReceipt | null>;
  /** Whether the node knows the transaction at all (mined or waiting). */
  knowsTx(hash: string): Promise<boolean>;
  tokenBalance(token: string, wallet: string): Promise<bigint>;
  launched(factory: string, token: string): Promise<LaunchedInfo>;
}

export type LaunchSettings = { pot: string | null; splitter: string | null; openingBuy: bigint | null; explorer: string };

export function launchPageOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.PUSHD_LAUNCH_PAGE?.trim() === "on";
}

export function launchSettingsFromEnv(env: Record<string, string | undefined> = process.env, explorer: string): LaunchSettings {
  const a = (v: string | undefined) => (isAddress(v?.trim()) ? v!.trim() : null);
  return { pot: a(env.PUSHD_BURN_POT_ADDRESS), splitter: a(env.PUSHD_SPLITTER_ADDRESS), openingBuy: openingBuyFromEnv(env), explorer };
}

/** What the page shows before the click. Amounts are decimal strings in wei so they cross to the browser intact. */
export type LaunchSummary = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  website: string;
  twitter: string;
  openingBuyWei: string;
  launchFeeWei: string;
  totalWei: string;
  /** ETH / USD with 8 decimals, or null. */
  ethUsd: string | null;
  creatorTaxBps: number;
  pot: string;
  launcher: string;
};

export type LaunchedView = { token: string; openingBuyTokens: string; openingBuyEth: string; launcher: string };

export type LaunchStatus =
  | { kind: "blocked"; problem: string }
  | { kind: "no_dev_buy"; problem: string }
  | { kind: "launched"; launched: LaunchedView }
  | { kind: "ready"; summary: LaunchSummary };

export type LaunchDeps = { reader: LaunchReader; settings: LaunchSettings; launchFile: unknown };

type Checked = { summary: LaunchSummary; file: LaunchFile; economics: Hex; fee: bigint; openingBuy: bigint; graduationThreshold: bigint };

/** A failed check. Its message is the sentence the page shows. */
class Refusal extends Error {}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};

/** Every check, in order; stops at the first one that fails. Returns the launched token instead when there is one. */
async function check(d: LaunchDeps): Promise<{ launched: LaunchedView } | { checked: Checked }> {
  const { reader: r, settings: s } = d;
  if (!s.pot) refuse("The burn pot's address is not set on this server (PUSHD_BURN_POT_ADDRESS).");
  if (!s.splitter) refuse("The fee address is not set on this server (PUSHD_SPLITTER_ADDRESS).");
  const pot = s.pot!;
  const splitter = s.splitter!;

  const chain = await r.chainId();
  if (chain !== ROBINHOOD_CHAIN_ID) refuse(`The node this server reads is on chain ${chain}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID}).`);
  if (!(await r.hasCode(pot))) refuse(`There is no contract at the burn pot's address ${pot} on Robinhood Chain.`);
  const p = await r.pot(pot);

  // Already launched: the token and its links, never a button.
  if (!ZERO_ADDR.test(p.token)) {
    return { launched: { token: p.token, openingBuyTokens: p.openingBuyTokens.toString(), openingBuyEth: p.openingBuyEth.toString(), launcher: p.launcher } };
  }

  if (!isAddress(p.launcher) || ZERO_ADDR.test(p.launcher)) refuse("The burn pot has no launch wallet.");
  if (!sameAddress(p.splitter, splitter)) refuse(`The burn pot pays its fees to ${p.splitter}, not to the fee address set on this server (${splitter}).`);
  if (!sameAddress(p.factory, PONS_FACTORY)) refuse(`The burn pot launches through ${p.factory}, not Pons' launch factory ${PONS_FACTORY}.`);
  if (p.creatorTaxBps !== 300) refuse(`The burn pot's creator tax is ${p.creatorTaxBps} basis points, not 300.`);

  if (!(await r.hasCode(splitter))) refuse(`There is no contract at the fee address ${splitter} on Robinhood Chain.`);
  if (!(await r.hasCode(PONS_FACTORY))) refuse("There is no contract at Pons' launch factory address on this chain.");
  const [sp, f] = await Promise.all([r.splitter(splitter), r.factory(PONS_FACTORY)]);
  if (!sameAddress(sp.burnPot, pot)) refuse("The fee address does not send the burn share to this burn pot.");
  if (sp.ownerBps <= 0 || sp.burnBps <= 0 || sp.ownerBps + sp.burnBps !== BPS) refuse("The fee address's two shares do not add up to the whole.");
  if (!isAddress(sp.owner) || ZERO_ADDR.test(sp.owner) || sameAddress(sp.owner, pot) || sameAddress(sp.owner, splitter)) refuse("The fee address's owner wallet is not a plain wallet of its own.");
  if (!sameAddress(sp.escrow, f.feeEscrow)) refuse("The fee address claims from another escrow than Pons' own.");
  if (!sameAddress(p.poolManager, f.poolManager) || !sameAddress(p.hook, f.memeHook)) refuse("The burn pot is not wired to Pons' own pool.");

  const lf = checkLaunchFile(d.launchFile);
  if (!lf.ok) refuse(lf.problem);
  const file = (lf as { ok: true; file: LaunchFile }).file;
  if (f.launchFee !== file.launchFeeWei) refuse(`Pons' launch fee is now ${f.launchFee} wei, not the ${file.launchFeeWei} wei written in contracts/launch.json. Look at the new fee before launching.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(f.economics) || /^0x0{64}$/.test(f.economics)) refuse("Pons' launch terms could not be read.");

  const logo = await r.logo(file.logo);
  if (logo.status !== 200 || !logo.contentType.toLowerCase().startsWith("image/")) refuse(`The picture's link does not answer with a picture (${file.logo} gave ${logo.status} ${logo.contentType || "no type"}).`);

  // The opening buy: a fixed server setting, never typed on the page.
  if (s.openingBuy === null) throw new NoDevBuy();
  const openingBuy = s.openingBuy;
  // A buy as large as the curve can fill would leave part of it in the burn pot; refuse before that can happen.
  if (openingBuy >= f.graduationThreshold) refuse("The opening buy is as large as the whole launch curve. Set a smaller PUSHD_LAUNCH_OPENING_BUY_WEI.");

  const ethUsd = await r.ethUsd().catch(() => null);
  return {
    checked: {
      file,
      economics: f.economics,
      fee: f.launchFee,
      openingBuy,
      graduationThreshold: f.graduationThreshold,
      summary: {
        name: file.name,
        symbol: file.symbol,
        logo: file.logo,
        description: file.description,
        website: file.website,
        twitter: file.twitter,
        openingBuyWei: openingBuy.toString(),
        launchFeeWei: f.launchFee.toString(),
        totalWei: (f.launchFee + openingBuy).toString(),
        ethUsd: ethUsd === null ? null : ethUsd.toString(),
        creatorTaxBps: p.creatorTaxBps,
        pot,
        launcher: p.launcher,
      },
    },
  };
}

class NoDevBuy extends Error {}

/** A chain read that fails becomes a sentence, never a guess. */
function unreachable(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return /fetch failed|timed? ?out|ECONNREFUSED|HTTP request failed|network/i.test(m) ? "Robinhood Chain did not answer. Reload in a minute." : "A read from Robinhood Chain failed. Reload in a minute.";
}

/** What the page shows on load. */
export async function launchStatus(d: LaunchDeps): Promise<LaunchStatus> {
  try {
    const c = await check(d);
    if ("launched" in c) return { kind: "launched", launched: c.launched };
    return { kind: "ready", summary: c.checked.summary };
  } catch (err) {
    if (err instanceof NoDevBuy) return { kind: "no_dev_buy", problem: "The opening buy is not set yet." };
    if (err instanceof Refusal) return { kind: "blocked", problem: err.message };
    return { kind: "blocked", problem: unreachable(err) };
  }
}

/** The transaction exactly as the wallet is to send it. Amounts in hex, as eth_sendTransaction takes them. */
export type PreparedTx = { from: string; to: string; data: Hex; value: Hex; gas: Hex; chainId: number };

export type Prepared =
  | { ok: true; tx: PreparedTx; predictedToken: string; summary: LaunchSummary; gasCostWei: string; balanceWei: string }
  | { ok: false; kind: "blocked" | "no_dev_buy" | "launched" | "wrong_wallet" | "short" | "waiting" | "reverted"; problem: string; launcher?: string; connected?: string; missingWei?: string; launched?: LaunchedView };

/**
 * Everything again, then the wallet: it must be the launcher, hold the value and the gas with room to spare, and
 * have nothing waiting; then the exact call is run from it on the node (no signature) and must return the token it
 * would create; then the gas is estimated and a quarter added.
 */
export async function prepareLaunch(d: LaunchDeps, from: string): Promise<Prepared> {
  let c: Awaited<ReturnType<typeof check>>;
  try {
    c = await check(d);
  } catch (err) {
    if (err instanceof NoDevBuy) return { ok: false, kind: "no_dev_buy", problem: "The opening buy is not set yet." };
    return { ok: false, kind: "blocked", problem: err instanceof Refusal ? err.message : unreachable(err) };
  }
  if ("launched" in c) return { ok: false, kind: "launched", problem: "$PUSHD is already launched.", launched: c.launched };
  const { summary, file, economics, fee, openingBuy } = c.checked;
  const r = d.reader;
  if (!isAddress(from)) return { ok: false, kind: "wrong_wallet", problem: "The wallet did not give an address.", launcher: summary.launcher };
  if (!sameAddress(from, summary.launcher)) return { ok: false, kind: "wrong_wallet", problem: "This wallet is not the launch wallet.", launcher: summary.launcher, connected: from };

  try {
    const tx = buildLaunchTx(summary.pot, file, economics, fee, openingBuy);
    if (tx.value !== BigInt(summary.totalWei)) return { ok: false, kind: "blocked", problem: "The amount to send does not add up. Nothing was sent." };

    const [nonces, balance, gasPrice] = await Promise.all([r.nonces(from), r.balance(from), r.gasPrice()]);
    if (nonces.pending > nonces.latest) return { ok: false, kind: "waiting", problem: "This wallet has a transaction still waiting on Robinhood Chain. Wait for it, then reload." };
    const price = gasPrice * BigInt(GAS_PRICE_MARGIN);
    if (balance < tx.value + GAS_GUESS * price) {
      const missing = tx.value + GAS_GUESS * price - balance;
      return { ok: false, kind: "short", problem: "This wallet does not hold enough ETH for the launch and its network fee.", missingWei: missing.toString() };
    }

    const sim = await r.simulate({ from, ...tx });
    if (!sim.ok) {
      const why = sim.revertData ? decodeRevert(sim.revertData).words : sim.message;
      return { ok: false, kind: "reverted", problem: `The launch would fail, so there is no button. ${why}` };
    }
    const predicted = sim.returned.length >= 66 ? `0x${sim.returned.slice(-40)}` : "";
    if (!isAddress(predicted) || ZERO_ADDR.test(predicted)) return { ok: false, kind: "reverted", problem: "The launch, run on the node, did not return a token address. Nothing was sent." };

    const gas = ((await r.estimateGas({ from, ...tx })) * BigInt(GAS_MARGIN_PCT)) / BigInt(100);
    const gasCost = gas * price;
    if (balance < tx.value + gasCost) {
      return { ok: false, kind: "short", problem: "This wallet does not hold enough ETH for the launch and its network fee.", missingWei: (tx.value + gasCost - balance).toString() };
    }
    return {
      ok: true,
      tx: { from, to: tx.to, data: tx.data, value: hex(tx.value), gas: hex(gas), chainId: ROBINHOOD_CHAIN_ID },
      predictedToken: predicted,
      summary,
      gasCostWei: gasCost.toString(),
      balanceWei: balance.toString(),
    };
  } catch (err) {
    return { ok: false, kind: "blocked", problem: err instanceof Refusal ? err.message : unreachable(err) };
  }
}

export type Outcome =
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "failed"; problem: string }
  | { state: "launched"; launched: LaunchedView; balanceWei: string | null; viaThisTx: boolean };

/**
 * After the wallet sent it: the receipt and the burn pot. The pot is the truth: when it has a token, $PUSHD is
 * launched whichever transaction did it (a wallet's "speed up" replaces the hash).
 */
export async function launchOutcome(d: LaunchDeps, hash: string): Promise<Outcome> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { state: "failed", problem: "That is not a transaction hash." };
  const pot = d.settings.pot;
  if (!pot) return { state: "failed", problem: "The burn pot's address is not set on this server." };
  const r = d.reader;
  const [receipt, p] = await Promise.all([r.receipt(hash), r.pot(pot)]);
  if (!ZERO_ADDR.test(p.token)) {
    const balance = await r.tokenBalance(p.token, p.launcher).catch(() => null);
    return {
      state: "launched",
      launched: { token: p.token, openingBuyTokens: p.openingBuyTokens.toString(), openingBuyEth: p.openingBuyEth.toString(), launcher: p.launcher },
      balanceWei: balance === null ? null : balance.toString(),
      viaThisTx: receipt !== null && receipt.status === "success",
    };
  }
  if (receipt) {
    if (!sameAddress(receipt.to, pot)) return { state: "failed", problem: "That transaction was not sent to the burn pot." };
    if (receipt.status === "reverted") return { state: "failed", problem: "The launch transaction failed on Robinhood Chain. Nothing was launched; the ETH stayed in the wallet apart from the network fee." };
    return { state: "failed", problem: "The transaction went through but the burn pot has no token. Do not send again; reload and look at the burn pot." };
  }
  return (await r.knowsTx(hash)) ? { state: "pending" } : { state: "unknown" };
}
