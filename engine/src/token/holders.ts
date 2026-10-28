// Holder sign-in: a wallet proves it is yours by signing a message, and its $PUSHD balance on the chain opens
// the live feed (no public delay), its own watchlist and browser alerts.
//
//   1. challenge   the engine writes a Sign-In With Ethereum message (EIP-4361) naming the site, the wallet, Robinhood
//                  Chain, a single-use nonce and an expiry ten minutes out, and keeps it.
//   2. sign        the wallet signs it as plain text (personal_sign, EIP-191). Signing sends nothing and approves
//                  nothing; this code never asks a wallet for a transaction.
//   3. session     the engine recovers the signer from the kept message (viem, offline), refuses a used, expired or
//                  unknown nonce and any other signer, then reads the wallet's $PUSHD balance fresh from the chain.
//                  At or above PUSHD_HOLDER_MIN a session starts (a random token; only its hash is kept). Under it, or
//                  before launch, there is no session.
//   4. after       every live request checks the session and the balance again, read from the chain at most every
//                  PUSHD_HOLDER_CACHE_MINUTES per wallet. When the node is silent the last reading counts for up to
//                  six times that, then not at all: a gap never makes anyone a holder.
//
// Nothing is paid, staked or moved. Plain key wallets (EOAs) only.
import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress, isHex, recoverMessageAddress } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import type { DB } from "../db.ts";
import { isScoutId, type ScoutId } from "../scouts/roster.ts";
import type { TokenReader } from "./chain.ts";
import { ROBINHOOD_CHAIN_ID, isHolder, type TokenConfig } from "./config.ts";

export class HolderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const SIGN_IN_STATEMENT = "Sign in to PUSHD as a $PUSHD holder. Signing this message sends nothing and approves nothing.";
export const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_OPEN_CHALLENGES = 5000;
const MAX_LIST = 300;

export type HolderStatus = {
  address: string;
  /** $PUSHD in its smallest unit, as a decimal string; null when the chain has not answered for this wallet. */
  balanceWei: string | null;
  minWhole: string;
  holder: boolean;
  checkedAt: number | null;
};

export const ALERT_HEATS = ["off", "veryHigh", "high", "medium", "low"] as const;
export type AlertHeat = (typeof ALERT_HEATS)[number];
export type HolderPrefs = { follow: string[]; mute: string[]; alertHeat: AlertHeat; alertMine: boolean; scouts: ScoutId[] };
export const DEFAULT_PREFS: HolderPrefs = { follow: [], mute: [], alertHeat: "high", alertMine: false, scouts: [] };

export type HolderDeps = {
  db: DB;
  config: TokenConfig;
  reader: Pick<TokenReader, "balances">;
  /** $PUSHD's address; null before launch. */
  tokenAddress: () => Promise<string | null>;
  /** Every handle on the shared watchlist: a holder's own list picks from these (a function follows a live list). */
  handles: string[] | (() => string[]);
  now?: () => number;
};

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const OPENS_AT_LAUNCH = "Holder sign-in opens at launch, once $PUSHD exists.";

export class Holders {
  private readonly fixed: Map<string, string> | null;

  constructor(private readonly d: HolderDeps) {
    this.fixed = Array.isArray(d.handles) ? new Map(d.handles.map((h) => [h.toLowerCase(), h])) : null;
  }

  private get canon(): Map<string, string> {
    return this.fixed ?? new Map((this.d.handles as () => string[])().map((h) => [h.toLowerCase(), h]));
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** Step 1: the exact message for this wallet to sign. */
  async challenge(addressInput: unknown): Promise<{ message: string; nonce: string; expiresAt: number }> {
    if (typeof addressInput !== "string" || !isAddress(addressInput.trim(), { strict: false })) throw new HolderError(400, "That is not a wallet address.");
    if (!(await this.d.tokenAddress())) throw new HolderError(409, OPENS_AT_LAUNCH);
    const address = getAddress(addressInput.trim());
    const now = this.now();
    const db = this.d.db;
    db.prepare("DELETE FROM holder_challenges WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").run(now, now - 3600_000);
    const open = (db.prepare("SELECT count(*) AS n FROM holder_challenges WHERE used_at IS NULL").get() as { n: number }).n;
    if (open >= MAX_OPEN_CHALLENGES) throw new HolderError(429, "Too many sign-ins at once. Try again in a few minutes.");
    const site = new URL(this.d.config.holder.siteUrl);
    const nonce = generateSiweNonce();
    const expiresAt = now + CHALLENGE_TTL_MS;
    const message = createSiweMessage({
      domain: site.host,
      address,
      statement: SIGN_IN_STATEMENT,
      uri: site.origin,
      version: "1",
      chainId: ROBINHOOD_CHAIN_ID,
      nonce,
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAt),
    });
    db.prepare("INSERT INTO holder_challenges (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, address.toLowerCase(), message, expiresAt);
    return { message, nonce, expiresAt };
  }

  /** Steps 2 and 3: the signature over the kept message, then the balance. A session only for a holder. */
  async signIn(addressInput: unknown, nonceInput: unknown, signature: unknown): Promise<{ session: string; expiresAt: number; status: HolderStatus }> {
    if (typeof addressInput !== "string" || !isAddress(addressInput.trim(), { strict: false })) throw new HolderError(400, "That is not a wallet address.");
    if (typeof nonceInput !== "string" || !/^[A-Za-z0-9]{8,96}$/.test(nonceInput)) throw new HolderError(400, "This sign-in request is not valid. Start again.");
    const address = addressInput.trim().toLowerCase();
    const now = this.now();
    const db = this.d.db;
    const c = db.prepare("SELECT nonce, address, message, expires_at AS expiresAt, used_at AS usedAt FROM holder_challenges WHERE nonce = ?").get(nonceInput) as
      | { nonce: string; address: string; message: string; expiresAt: number; usedAt: number | null }
      | undefined;
    if (!c || c.address !== address) throw new HolderError(401, "This sign-in request is not known. Start again.");
    // single use: spent the moment it is presented, whatever comes next
    const taken = db.prepare("UPDATE holder_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(now, c.nonce).changes === 1;
    if (!taken) throw new HolderError(401, "This sign-in request was already used. Start again.");
    if (c.expiresAt <= now) throw new HolderError(401, "This sign-in request has expired. Start again.");
    if (typeof signature !== "string" || !isHex(signature) || signature.length > 1000) throw new HolderError(401, "The signature is not valid.");
    let signer: string;
    try {
      signer = await recoverMessageAddress({ message: c.message, signature });
    } catch {
      throw new HolderError(401, "The signature is not valid.");
    }
    if (signer.toLowerCase() !== address) throw new HolderError(401, "The signature is not from that wallet.");

    if (!(await this.d.tokenAddress())) throw new HolderError(409, OPENS_AT_LAUNCH);
    const status = await this.status(address, { fresh: true });
    if (status.balanceWei === null) throw new HolderError(503, "The chain did not answer, so the balance could not be read. Try again in a minute.");
    if (!status.holder) throw new HolderError(403, `This wallet holds less than ${Number(status.minWhole).toLocaleString("en-US")} $PUSHD, so the live feed stays closed.`, { status });

    const session = randomBytes(32).toString("base64url");
    const expiresAt = now + this.d.config.holder.sessionDays * 86_400_000;
    db.prepare("DELETE FROM holder_sessions WHERE expires_at < ?").run(now);
    db.prepare("INSERT INTO holder_sessions (id_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(session), address, now, expiresAt);
    return { session, expiresAt, status };
  }

  /** The wallet behind a session token, or null when there is no such session or it has expired. */
  session(token: unknown): { address: string; expiresAt: number } | null {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const row = this.d.db.prepare("SELECT address, expires_at AS expiresAt FROM holder_sessions WHERE id_hash = ?").get(sha(token)) as { address: string; expiresAt: number } | undefined;
    return row && row.expiresAt > this.now() ? row : null;
  }

  signOut(token: unknown): void {
    if (typeof token === "string") this.d.db.prepare("DELETE FROM holder_sessions WHERE id_hash = ?").run(sha(token));
  }

  /** A wallet's holding, from the cache while it is fresh, else from the chain. `fresh` always reads the chain. */
  async status(addressInput: string, opts: { fresh?: boolean } = {}): Promise<HolderStatus> {
    const address = addressInput.toLowerCase();
    const c = this.d.config;
    const now = this.now();
    const ttl = c.holder.cacheMinutes * 60_000;
    const row = this.d.db.prepare("SELECT wei, checked_at AS checkedAt FROM holder_balances WHERE address = ?").get(address) as { wei: string; checkedAt: number } | undefined;
    const out = (wei: bigint | null, checkedAt: number | null): HolderStatus => ({ address, balanceWei: wei === null ? null : wei.toString(), minWhole: c.holder.minWhole, holder: isHolder(c, wei), checkedAt });
    if (!opts.fresh && row && now - row.checkedAt < ttl) return out(BigInt(row.wei), row.checkedAt);
    const token = await this.d.tokenAddress().catch(() => null);
    let wei: bigint | null = null;
    if (token) {
      try {
        [wei] = await this.d.reader.balances(token, [address]);
      } catch {
        wei = null;
      }
    }
    if (wei !== null && wei !== undefined) {
      this.d.db.prepare("INSERT INTO holder_balances (address, wei, checked_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET wei = excluded.wei, checked_at = excluded.checked_at").run(address, wei.toString(), now);
      return out(wei, now);
    }
    // the node was silent: the last reading for a while, then nothing
    if (!opts.fresh && row && now - row.checkedAt < ttl * 6) return out(BigInt(row.wei), row.checkedAt);
    return out(null, null);
  }

  /** Whether a session may see the live feed right now: a valid session and a holding at the threshold. */
  async liveAllowed(token: unknown): Promise<boolean> {
    const s = this.session(token);
    if (!s) return false;
    return (await this.status(s.address)).holder;
  }

  prefs(address: string): HolderPrefs {
    const row = this.d.db.prepare("SELECT follow, mute, alert_heat AS alertHeat, alert_mine AS alertMine, scouts FROM holder_prefs WHERE address = ?").get(address.toLowerCase()) as
      | { follow: string; mute: string; alertHeat: AlertHeat; alertMine: number; scouts: string | null }
      | undefined;
    if (!row) return { ...DEFAULT_PREFS, scouts: [] };
    return { follow: JSON.parse(row.follow), mute: JSON.parse(row.mute), alertHeat: row.alertHeat, alertMine: row.alertMine === 1, scouts: JSON.parse(row.scouts ?? "[]") };
  }

  /** A holder's own watchlist (handles from the shared one) and alert choices. Unknown handles are refused, whole. */
  setPrefs(address: string, input: unknown): HolderPrefs {
    if (!input || typeof input !== "object") throw new HolderError(400, "Nothing to save.");
    const i = input as Record<string, unknown>;
    const cur = this.prefs(address);
    const list = (v: unknown, what: string): string[] => {
      if (!Array.isArray(v) || v.length > MAX_LIST) throw new HolderError(400, `The ${what} list is not valid.`);
      const out: string[] = [];
      for (const h of v) {
        const known = typeof h === "string" ? this.canon.get(h.trim().replace(/^@/, "").toLowerCase()) : undefined;
        if (!known) throw new HolderError(400, `${String(h).slice(0, 40)} is not on the watchlist.`);
        if (!out.includes(known)) out.push(known);
      }
      return out;
    };
    const follow = i.follow === undefined ? cur.follow : list(i.follow, "follow");
    const mute = i.mute === undefined ? cur.mute : list(i.mute, "mute");
    if (follow.some((h) => mute.includes(h))) throw new HolderError(400, "A builder cannot be both followed and muted.");
    const alertHeat = i.alertHeat === undefined ? cur.alertHeat : i.alertHeat;
    if (!ALERT_HEATS.includes(alertHeat as AlertHeat)) throw new HolderError(400, "That alert level is not known.");
    const alertMine = i.alertMine === undefined ? cur.alertMine : i.alertMine;
    if (typeof alertMine !== "boolean") throw new HolderError(400, "alertMine must be true or false.");
    let scouts = cur.scouts;
    if (i.scouts !== undefined) {
      if (!Array.isArray(i.scouts) || i.scouts.length > 5 || !i.scouts.every(isScoutId)) throw new HolderError(400, "The scouts list is not valid.");
      scouts = [...new Set(i.scouts as ScoutId[])];
    }
    const next: HolderPrefs = { follow, mute, alertHeat: alertHeat as AlertHeat, alertMine, scouts };
    this.d.db
      .prepare(
        "INSERT INTO holder_prefs (address, follow, mute, alert_heat, alert_mine, scouts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET follow = excluded.follow, mute = excluded.mute, alert_heat = excluded.alert_heat, alert_mine = excluded.alert_mine, scouts = excluded.scouts, updated_at = excluded.updated_at",
      )
      .run(address.toLowerCase(), JSON.stringify(next.follow), JSON.stringify(next.mute), next.alertHeat, next.alertMine ? 1 : 0, JSON.stringify(next.scouts), this.now());
    return next;
  }
}
