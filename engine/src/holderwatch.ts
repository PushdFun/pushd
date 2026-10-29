// Holders watch any account: from an account's page (/gh/<login>), a signed-in holder adds it to their own list. The
// watcher reads added accounts at a lower priority (only when no watched project is due, inside the "extra" share of
// the hour: src/plan.ts), into their own store (data/extras.sqlite), never the public feed. Their new lines go to the
// holder's inbox and alerts, and the holder's own scout rules may name them.
//
// Limits: how many accounts a holder may add follows the holding (PUSHD_HOLDER_WATCH_TIERS); the server reads at most
// PUSHD_EXTRA_ACCOUNTS_MAX different added accounts in all; adds are rate limited per wallet.
import type { DB } from "./db.ts";
import { extraMinutes, sharesFor } from "./plan.ts";
import { WEI } from "./token/config.ts";
import type { HolderWatchView, WatchEntry } from "./types.ts";

type Env = Record<string, string | undefined>;

export const WATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS holder_watch (
  address TEXT NOT NULL,
  login TEXT NOT NULL,
  login_lc TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (address, login_lc)
);
CREATE INDEX IF NOT EXISTS holder_watch_login ON holder_watch(login_lc);
CREATE TABLE IF NOT EXISTS holder_watch_acts (address TEXT NOT NULL, at INTEGER NOT NULL);
`;

export class WatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type WatchTier = { minWhole: bigint; accounts: number };

export function parseWatchTiers(v: string | undefined): WatchTier[] {
  const d: WatchTier[] = [
    { minWhole: 1_000_000n, accounts: 3 },
    { minWhole: 5_000_000n, accounts: 10 },
    { minWhole: 20_000_000n, accounts: 25 },
  ];
  if (!v?.trim()) return d;
  const out: WatchTier[] = [];
  for (const part of v.split(",")) {
    const m = /^\s*(\d{1,24})\s*:\s*(\d{1,3})\s*$/.exec(part);
    if (!m || Number(m[2]) < 1) return d;
    out.push({ minWhole: BigInt(m[1]), accounts: Number(m[2]) });
  }
  return out.sort((a, b) => (a.minWhole < b.minWhole ? -1 : 1));
}

export type WatchConfig = { tiers: WatchTier[]; globalMax: number; addsPerHour: number };

export function watchConfigFromEnv(env: Env = process.env): WatchConfig {
  const n = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { tiers: parseWatchTiers(env.PUSHD_HOLDER_WATCH_TIERS), globalMax: n(env.PUSHD_EXTRA_ACCOUNTS_MAX, 100), addsPerHour: n(env.PUSHD_HOLDER_WATCH_ADDS_PER_HOUR, 20) };
}

export type WatchDeps = {
  db: DB;
  config: WatchConfig;
  authenticated: boolean;
  /** is it in the Top N now (then it is watched already) */
  inTop: (login: string) => boolean;
  /** the account's basics (a kept lookup, else one request); null when there is no such account */
  account: (login: string, visitor: string) => Promise<{ login: string; type: "user" | "org"; name: string | null } | null>;
  /** lines PUSHD stored for an added account (the extras store) */
  linesOf?: (login: string) => number;
  /** when the watcher last read an added account */
  lastReadOf?: (login: string) => string | null;
  now?: () => number;
};

export class HolderWatch {
  constructor(private readonly d: WatchDeps) {
    d.db.exec(WATCH_SCHEMA);
  }

  private now = () => (this.d.now ?? Date.now)();

  allowed(balanceWei: bigint | null): number {
    if (balanceWei == null) return 0;
    let n = 0;
    for (const t of this.d.config.tiers) if (balanceWei >= t.minWhole * WEI) n = t.accounts;
    return n;
  }

  /** Every different added account (the watcher's extra list), the oldest added first. */
  distinct(): { login: string; type: "user" | "org"; name: string | null }[] {
    return this.d.db.prepare("SELECT login, type, name FROM holder_watch GROUP BY login_lc ORDER BY min(added_at)").all() as { login: string; type: "user" | "org"; name: string | null }[];
  }

  /** The added accounts as the watcher reads them: the camp is a placeholder, they never reach the public feed. */
  entries(): WatchEntry[] {
    return this.distinct()
      .filter((a) => !this.d.inTop(a.login))
      .slice(0, this.d.config.globalMax)
      .map((a) => ({ handle: a.login, name: a.name ?? a.login, org: a.name ?? a.login, group: "oss", type: a.type, source: "added by a holder" }));
  }

  /** The holders who added an account (lower-case wallets). */
  watchers(login: string): string[] {
    return (this.d.db.prepare("SELECT address FROM holder_watch WHERE login_lc = ?").all(login.toLowerCase()) as { address: string }[]).map((r) => r.address);
  }

  /** A holder's added accounts as watch entries (their scout rules may name them). */
  accountsOf(address: string): WatchEntry[] {
    return (this.d.db.prepare("SELECT login, type, name FROM holder_watch WHERE address = ?").all(address.toLowerCase()) as { login: string; type: "user" | "org"; name: string | null }[]).map((a) => ({
      handle: a.login,
      name: a.name ?? a.login,
      org: a.name ?? a.login,
      group: "oss",
      type: a.type,
      source: "added by a holder",
    }));
  }

  view(address: string, balanceWei: bigint | null): HolderWatchView {
    const a = address.toLowerCase();
    const rows = this.d.db.prepare("SELECT login, type, name, added_at FROM holder_watch WHERE address = ? ORDER BY added_at").all(a) as { login: string; type: "user" | "org"; name: string | null; added_at: number }[];
    const distinct = this.distinct().length;
    return {
      accounts: rows.map((r) => ({ login: r.login, type: r.type, name: r.name, addedAt: r.added_at, lastReadAt: this.d.lastReadOf?.(r.login) ?? null, lines: this.d.linesOf?.(r.login) ?? 0 })),
      allowed: this.allowed(balanceWei),
      tiers: this.d.config.tiers.map((t) => ({ minWhole: t.minWhole.toString(), accounts: t.accounts })),
      globalLeft: Math.max(0, this.d.config.globalMax - distinct),
      everyMin: extraMinutes(Math.max(1, distinct), sharesFor(this.d.authenticated).extra, this.d.authenticated),
    };
  }

  async add(address: string, balanceWei: bigint | null, loginInput: unknown, visitor: string): Promise<HolderWatchView> {
    if (typeof loginInput !== "string" || !/^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(loginInput.trim())) throw new WatchError(400, "That is not a GitHub username.");
    const a = address.toLowerCase();
    const max = this.allowed(balanceWei);
    if (max === 0) throw new WatchError(403, "Watching any account needs a wallet that holds $PUSHD.");
    const login = loginInput.trim().replace(/^@/, "");
    if (this.d.db.prepare("SELECT 1 FROM holder_watch WHERE address = ? AND login_lc = ?").get(a, login.toLowerCase())) return this.view(a, balanceWei);
    if (this.d.inTop(login)) throw new WatchError(409, `${login} is on the list already, so PUSHD watches it for everyone. Follow it on the holders page instead.`);
    const have = (this.d.db.prepare("SELECT count(*) AS n FROM holder_watch WHERE address = ?").get(a) as { n: number }).n;
    if (have >= max) throw new WatchError(403, `Your holding allows ${max} added account${max === 1 ? "" : "s"}. Remove one, or hold more for the next tier.`);
    const isNew = !this.d.db.prepare("SELECT 1 FROM holder_watch WHERE login_lc = ?").get(login.toLowerCase());
    if (isNew && this.distinct().length >= this.d.config.globalMax) throw new WatchError(409, "PUSHD reads as many added accounts as it can right now. Try again later.");
    this.d.db.prepare("DELETE FROM holder_watch_acts WHERE at < ?").run(this.now() - 3_600_000);
    const acts = (this.d.db.prepare("SELECT count(*) AS n FROM holder_watch_acts WHERE address = ?").get(a) as { n: number }).n;
    if (acts >= this.d.config.addsPerHour) throw new WatchError(429, `At most ${this.d.config.addsPerHour} adds an hour. Try again later.`);
    const acc = await this.d.account(login, visitor);
    if (!acc) throw new WatchError(404, "No such GitHub account.");
    this.d.db.prepare("INSERT INTO holder_watch_acts (address, at) VALUES (?, ?)").run(a, this.now());
    this.d.db.prepare("INSERT OR IGNORE INTO holder_watch (address, login, login_lc, type, name, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(a, acc.login, acc.login.toLowerCase(), acc.type, acc.name, this.now());
    return this.view(a, balanceWei);
  }

  remove(address: string, balanceWei: bigint | null, login: string): HolderWatchView {
    this.d.db.prepare("DELETE FROM holder_watch WHERE address = ? AND login_lc = ?").run(address.toLowerCase(), login.replace(/^@/, "").toLowerCase());
    return this.view(address, balanceWei);
  }
}
