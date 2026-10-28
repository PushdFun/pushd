// Pay per call, HTTP 402 style, with PUSHD's own simple scheme ("pushd-burn", version 1). Every payment goes to the
// $PUSHD burn pot, so every paid agent call feeds the burn: the pot spends the ETH it holds buying $PUSHD and burning it.
//
//   1. A paid tool called without a payment answers 402 with the price in ETH, the pay-to address (the burn pot) and
//      the chain id.
//   2. The caller sends at least that much ETH to the burn pot, from a plain wallet, in an ordinary transfer.
//   3. It retries with the transaction hash and that wallet's signature (EIP-191 personal_sign) over the exact text
//      `PUSHD payment <tx hash in lower case>`, in the headers X-PUSHD-Payment-Tx and X-PUSHD-Payment-Signature (or
//      the MCP tool's `payment` argument).
//   4. The engine checks, in this order: the shapes; that the hash was never used before; the signer, recovered from
//      the signature; then on the chain: the transaction exists and succeeded, on chain 4663, to the burn pot, from the
//      signer, with value >= the price, in a block at most PUSHD_AGENT_PAY_MAX_AGE_MIN old. Only then is the hash
//      claimed (a unique row, so two requests with one hash cannot both pass) and the call served.
//
// A hash is good for one call. A call that fails on PUSHD's side after the claim gives the hash back for one retry.
// Paid mode stays closed until the burn pot is set (PUSHD_BURN_POT_ADDRESS) and PUSHD_AGENT_PAID is not off.
import { createPublicClient, http, isHex, recoverMessageAddress, type Hash } from "viem";
import type { DB } from "../db.ts";
import { ROBINHOOD_CHAIN } from "../token/chain.ts";
import { ROBINHOOD_CHAIN_ID } from "../token/config.ts";

export const PAY_SCHEME = "pushd-burn";
export const PAY_VERSION = 1;
export const payMessage = (tx: string) => `PUSHD payment ${tx.toLowerCase()}`;

export const PAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_payments (
  tx TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  value_wei TEXT NOT NULL,
  tool TEXT NOT NULL,
  price_wei TEXT NOT NULL,
  block INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  returns INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_payments_wallet ON agent_payments(wallet, claimed_at);
`;

/** A transaction as the engine needs it from the chain. */
export type ChainTx = {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  chainId: number | null;
  blockNumber: number | null;
  /** from the receipt; null while pending */
  status: "success" | "reverted" | null;
  /** the block's time, milliseconds */
  timestamp: number | null;
};

export interface PaymentChain {
  /** null when the node does not know the transaction */
  tx(hash: string): Promise<ChainTx | null>;
}

/** The real one: viem on the token RPC. Ten seconds a call. */
export function viemPaymentChain(rpcUrl: string): PaymentChain {
  const c = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  return {
    async tx(hash) {
      const t = await c.getTransaction({ hash: hash as Hash }).catch(() => null);
      if (!t) return null;
      const r = t.blockNumber != null ? await c.getTransactionReceipt({ hash: hash as Hash }).catch(() => null) : null;
      const b = t.blockNumber != null ? await c.getBlock({ blockNumber: t.blockNumber }).catch(() => null) : null;
      return {
        hash: t.hash,
        from: t.from,
        to: t.to ?? null,
        value: t.value,
        chainId: t.chainId ?? null,
        blockNumber: t.blockNumber != null ? Number(t.blockNumber) : null,
        status: r ? r.status : null,
        timestamp: b ? Number(b.timestamp) * 1000 : null,
      };
    },
  };
}

export class PaymentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type PaymentProof = { tx: string; signature: string };
export type Verified = { tx: string; wallet: string; valueWei: bigint; block: number };

export type PaymentsDeps = {
  db: DB;
  chain: PaymentChain;
  /** the burn pot; null: paid mode closed */
  payTo: string | null;
  /** PUSHD_AGENT_PAID is not off */
  switchOn: boolean;
  maxAgeMs: number;
  now?: () => number;
};

const ETH = 10n ** 18n;
/** Wei as an ETH decimal string, exact. */
export function ethString(wei: bigint): string {
  const whole = wei / ETH;
  const frac = (wei % ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export class Payments {
  constructor(private readonly d: PaymentsDeps) {
    d.db.exec(PAY_SCHEMA);
  }

  private now = () => (this.d.now ?? Date.now)();

  get open(): boolean {
    return this.d.switchOn && !!this.d.payTo;
  }

  get payTo(): string | null {
    return this.d.payTo;
  }

  /** The body of a 402: everything a caller needs to pay and retry. */
  required(resource: string, tool: string, priceWei: bigint) {
    return {
      error: "Payment required.",
      scheme: PAY_SCHEME,
      version: PAY_VERSION,
      tool,
      resource,
      chainId: ROBINHOOD_CHAIN_ID,
      asset: "ETH",
      priceWei: priceWei.toString(),
      priceEth: ethString(priceWei),
      payTo: this.d.payTo,
      maxAgeSeconds: Math.round(this.d.maxAgeMs / 1000),
      sign: "personal_sign over the text: PUSHD payment <tx hash in lower case>",
      retryWith: { headers: ["X-PUSHD-Payment-Tx", "X-PUSHD-Payment-Signature"], mcpArgument: "payment: { tx, signature }" },
      note: "Send at least priceEth to payTo from a plain wallet, then retry with the transaction hash and that wallet's signature. Every payment goes to the $PUSHD burn pot, which buys $PUSHD and burns it. One hash pays for one call.",
    };
  }

  /** Reads a proof from headers or an MCP argument; null when there is none at all. */
  static proofFrom(tx: unknown, signature: unknown): PaymentProof | null {
    if (tx == null && signature == null) return null;
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx.trim())) throw new PaymentError(400, "The payment's transaction hash is not valid (0x and 64 hex characters).", "bad_tx");
    if (typeof signature !== "string" || !isHex(signature.trim()) || signature.trim().length < 132 || signature.trim().length > 200) throw new PaymentError(400, "The payment's signature is not valid.", "bad_signature");
    return { tx: tx.trim().toLowerCase(), signature: signature.trim() };
  }

  /**
   * Checks a proof against the chain and claims the hash. Throws a PaymentError (402 for anything the caller can fix
   * by paying again, 409 for a used hash, 503 when the chain does not answer) or returns the verified payment.
   */
  async verifyAndClaim(p: PaymentProof, tool: string, priceWei: bigint): Promise<Verified> {
    if (!this.open || !this.d.payTo) throw new PaymentError(409, "Paid tools open at launch.", "closed");
    const used = this.d.db.prepare("SELECT status, claimed_at FROM agent_payments WHERE tx = ?").get(p.tx) as { status: string; claimed_at: number } | undefined;
    if (used && used.status !== "returned") throw new PaymentError(409, "This payment was already used. One transaction pays for one call.", "used");
    let signer: string;
    try {
      signer = (await recoverMessageAddress({ message: payMessage(p.tx), signature: p.signature as `0x${string}` })).toLowerCase();
    } catch {
      throw new PaymentError(402, "The signature does not recover a wallet. Sign the text: PUSHD payment <tx hash in lower case>.", "bad_signature");
    }
    let t: ChainTx | null;
    try {
      t = await this.d.chain.tx(p.tx);
    } catch {
      throw new PaymentError(503, "The chain did not answer, so the payment could not be checked. Retry in a minute with the same hash.", "chain_silent");
    }
    if (!t) throw new PaymentError(402, "No such transaction on the chain yet. If you just sent it, retry in a few seconds with the same hash.", "not_found");
    if (t.status === null || t.blockNumber === null) throw new PaymentError(402, "The transaction is not in a block yet. Retry in a few seconds with the same hash.", "pending");
    if (t.status !== "success") throw new PaymentError(402, "The transaction failed on the chain.", "reverted");
    if (t.chainId !== null && t.chainId !== ROBINHOOD_CHAIN_ID) throw new PaymentError(402, `The transaction is on chain ${t.chainId}, not ${ROBINHOOD_CHAIN_ID}.`, "wrong_chain");
    if (!t.to || t.to.toLowerCase() !== this.d.payTo.toLowerCase()) throw new PaymentError(402, "The transaction was not sent to the burn pot.", "wrong_to");
    if (t.from.toLowerCase() !== signer) throw new PaymentError(402, "The signature is not from the wallet that paid.", "wrong_signer");
    if (t.value < priceWei) throw new PaymentError(402, `The payment is ${ethString(t.value)} ETH; this tool costs ${ethString(priceWei)} ETH.`, "too_little");
    if (t.timestamp === null) throw new PaymentError(503, "The chain did not say when the payment's block was made. Retry in a minute.", "chain_silent");
    const age = this.now() - t.timestamp;
    if (age > this.d.maxAgeMs) throw new PaymentError(402, `The payment is older than ${Math.round(this.d.maxAgeMs / 60_000)} minutes. Send a new one.`, "too_old");
    if (age < -120_000) throw new PaymentError(402, "The payment's block is dated in the future.", "bad_time");
    const now = this.now();
    // the claim: one row per hash; a returned hash (a failed serve) may be claimed once more
    const claim = used
      ? this.d.db.prepare("UPDATE agent_payments SET status = 'claimed', tool = ?, price_wei = ?, claimed_at = ? WHERE tx = ? AND status = 'returned'").run(tool, priceWei.toString(), now, p.tx)
      : this.d.db.prepare("INSERT OR IGNORE INTO agent_payments (tx, wallet, value_wei, tool, price_wei, block, paid_at, claimed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed')").run(p.tx, signer, t.value.toString(), tool, priceWei.toString(), t.blockNumber, t.timestamp, now);
    if (claim.changes !== 1) throw new PaymentError(409, "This payment was already used. One transaction pays for one call.", "used");
    return { tx: p.tx, wallet: signer, valueWei: t.value, block: t.blockNumber };
  }

  /** The call was served: the hash is spent for good. */
  served(tx: string) {
    this.d.db.prepare("UPDATE agent_payments SET status = 'served' WHERE tx = ?").run(tx);
  }

  /** The call failed on PUSHD's side: the hash may be used once more. A second failure keeps it spent. */
  giveBack(tx: string) {
    this.d.db.prepare("UPDATE agent_payments SET status = CASE WHEN returns = 0 THEN 'returned' ELSE 'failed' END, returns = returns + 1 WHERE tx = ? AND status = 'claimed'").run(tx);
  }

  /** Paid calls a wallet made in the last hour. */
  paidInHour(wallet: string): number {
    return (this.d.db.prepare("SELECT count(*) AS n FROM agent_payments WHERE wallet = ? AND claimed_at > ?").get(wallet.toLowerCase(), this.now() - 3_600_000) as { n: number }).n;
  }

  /** What agents have sent to the burn pot, as PUSHD verified it on the chain. */
  totals(): { payments: number; wei: string; eth: string; wallets: number; last: number | null } {
    const r = this.d.db.prepare("SELECT count(*) AS n, count(DISTINCT wallet) AS w, max(paid_at) AS last FROM agent_payments WHERE status IN ('served', 'claimed', 'returned', 'failed')").get() as { n: number; w: number; last: number | null };
    const sum = (this.d.db.prepare("SELECT value_wei FROM agent_payments").all() as { value_wei: string }[]).reduce((s, x) => s + BigInt(x.value_wei), 0n);
    return { payments: r.n, wei: sum.toString(), eth: ethString(sum), wallets: r.w, last: r.last };
  }
}
