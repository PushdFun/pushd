// What the site's /token page shows, read from Robinhood Chain: where $PUSHD stands (before the contracts exist,
// deployed and waiting for the launch, or live), the burns so far with their transactions, what waits in the burn
// pot for the next one and when, and the supply now and at launch. Served as GET /v1/token.
//
// Light on the node: the pot's numbers and the supply at most once a minute for every visitor together (one read in
// flight at a time); the burn logs only when the pot's count says there is a burn not seen yet, from where the last
// read stopped (PUSHD_BURN_POT_BLOCK the first time), in spans of 100,000 blocks. When the node does not answer, the
// last good reading is shown for up to six hours, marked stale; with none, the panel says the chain did not answer.
// Never zeros for something that has not started.
//
// It never carries how the fees are shared, nor the fee address: only the token, the burn pot and the burn.
import type { DB } from "../db.ts";
import { getMeta, setMeta } from "../db.ts";
import type { TokenConfig } from "./config.ts";
import { scanBurns, scrub, type PotState, type TokenReader } from "./chain.ts";

export type Stage = "soon" | "deployed" | "live";
export type BurnRow = { n: number; tx: string; block: number; at: number; tokens: string; eth: string };

export type TokenPanel = {
  stage: Stage;
  token: string | null;
  pot: string | null;
  explorer: string;
  /** In $PUSHD's smallest unit (18 decimals) or wei, as decimal strings. */
  supply: string | null;
  launchSupply: string | null;
  burned: string | null;
  ethSpent: string | null;
  count: number;
  /** Newest first. */
  latest: BurnRow[];
  /** From the pot's preview(): what the next burn spends and destroys, and when it may happen. */
  next: { eth: string; tokens: string; at: number | null; ready: boolean } | null;
  lastBurnAt: number | null;
  startedAt: number | null;
  /** Whole $PUSHD a wallet needs for the live feed. */
  holderMin: string;
  readAt: number;
  stale: boolean;
  problem: string | null;
};

export const LATEST = 8;
const KEEP_ROWS = 50;
const FRESH_MS = 60_000;
const KEEP_MS = 6 * 3600_000;
const SPANS_PER_READ = 20;

type Scan = { scannedTo: number; launchSupply: string | null };

export type PanelDeps = { config: TokenConfig; reader: TokenReader; db: DB; now?: () => number; log?: (msg: string) => void };

function base(c: TokenConfig, now: number): TokenPanel {
  return {
    stage: c.pot ? "deployed" : "soon",
    token: c.token,
    pot: c.pot,
    explorer: c.explorer,
    supply: null,
    launchSupply: null,
    burned: null,
    ethSpent: null,
    count: 0,
    latest: [],
    next: null,
    lastBurnAt: null,
    startedAt: null,
    holderMin: c.holder.minWhole,
    readAt: now,
    stale: false,
    problem: null,
  };
}

const getScan = (db: DB): Scan | null => {
  const v = getMeta(db, "token_scan");
  return v ? (JSON.parse(v) as Scan) : null;
};
const putScan = (db: DB, s: Scan) => setMeta(db, "token_scan", JSON.stringify(s));
const rowsNewest = (db: DB): BurnRow[] => db.prepare("SELECT n, tx, block, at, tokens, eth FROM token_burns ORDER BY n DESC").all() as BurnRow[];

/** Burns the list has not seen yet, read from the pot's logs and written down. */
async function catchUp(d: PanelDeps, pot: string, s: PotState): Promise<BurnRow[]> {
  const rows = rowsNewest(d.db);
  const known = rows[0]?.n ?? 0;
  if (s.burnCount <= known) return rows;
  const scan = getScan(d.db);
  const head = await d.reader.head();
  const from = scan && scan.scannedTo > 0 ? scan.scannedTo + 1 : (d.config.potBlock ?? Math.max(0, head - 100_000 * SPANS_PER_READ));
  const found = await scanBurns(d.reader, pot, from, head, { maxSpans: SPANS_PER_READ });
  const insert = d.db.prepare("INSERT OR IGNORE INTO token_burns (n, tx, block, at, tokens, eth) VALUES (?, ?, ?, ?, ?, ?)");
  for (const l of found.logs) {
    if (rows.some((r) => r.n === l.n)) continue;
    insert.run(l.n, l.tx, l.block, await d.reader.blockTime(l.block), l.tokens.toString(), l.eth.toString());
  }
  d.db.prepare("DELETE FROM token_burns WHERE n NOT IN (SELECT n FROM token_burns ORDER BY n DESC LIMIT ?)").run(KEEP_ROWS);
  if (found.scannedTo >= from) putScan(d.db, { scannedTo: found.scannedTo, launchSupply: getScan(d.db)?.launchSupply ?? null });
  return rowsNewest(d.db);
}

async function read(d: PanelDeps, now: number): Promise<TokenPanel> {
  const c = d.config;
  const p = base(c, now);
  if (!c.pot) return p;
  const s = await d.reader.pot(c.pot);
  p.token = c.token ?? s.token;
  if (!s.token) return p;
  p.stage = "live";
  p.startedAt = s.startedAt || null;
  const [supply, rows] = await Promise.all([d.reader.supply(s.token), catchUp(d, c.pot, s)]);
  p.supply = supply.toString();
  // The supply at launch: as first seen before any burn; seen later, today's supply plus what the pot has burned.
  const scan = getScan(d.db);
  let launch = scan?.launchSupply ?? null;
  if (!launch) {
    launch = (supply + s.totalTokens).toString();
    putScan(d.db, { scannedTo: scan?.scannedTo ?? 0, launchSupply: launch });
  }
  p.launchSupply = launch;
  p.count = s.burnCount;
  p.lastBurnAt = s.lastBurnAt || null;
  if (s.burnCount > 0) {
    p.burned = s.totalTokens.toString();
    p.ethSpent = s.totalEth.toString();
    p.latest = rows.slice(0, LATEST);
  }
  if (s.waitingEth > 0n || s.waitingTokens > 0n) p.next = { eth: s.waitingEth.toString(), tokens: s.waitingTokens.toString(), at: s.nextAt || null, ready: s.ready };
  return p;
}

/** The panel, at most a minute old, from one cache per process. Never throws. */
export class TokenPanels {
  private cache: { at: number; key: string; panel: TokenPanel } | null = null;
  private inflight: Promise<TokenPanel> | null = null;

  constructor(private readonly d: PanelDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  async panel(opts: { fresh?: boolean } = {}): Promise<TokenPanel> {
    const c = this.d.config;
    const key = `${c.pot}|${c.token}|${c.rpcUrl}`;
    const now = this.now();
    if (!opts.fresh && this.cache && this.cache.key === key && now - this.cache.at < FRESH_MS) return this.cache.panel;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const panel = await read(this.d, this.now());
        this.cache = { at: this.now(), key, panel };
        return panel;
      } catch (err) {
        const last = this.cache && this.cache.key === key && this.now() - this.cache.at < KEEP_MS ? this.cache.panel : null;
        if (last) return { ...last, stale: true };
        this.d.log?.(`token panel: ${scrub(String((err as Error)?.message ?? err))}`);
        return { ...base(c, this.now()), problem: "Robinhood Chain did not answer just now. The numbers come back on the next look.", stale: true };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** $PUSHD's address: from the setting, else from the pot once launched. Null before the launch or while the chain is silent. */
  async tokenAddress(): Promise<string | null> {
    if (this.d.config.token) return this.d.config.token;
    if (!this.d.config.pot) return null;
    return (await this.panel()).token;
  }
}
