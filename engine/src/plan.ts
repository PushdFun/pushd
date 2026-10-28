// How PUSHD shares GitHub's hourly allowance out, and how often each project in the Top N is read.
//
// GitHub gives one budget per token (5,000 core requests an hour; 60 an hour without a token, per address). Several
// parts of PUSHD spend it, so each gets a reserved share and books every request it makes (the gh_spend table, see
// GitHub.book in src/github.ts). A part over its share waits for the next hour; the watched Top N always comes first.
//
//   watch   the Top N, read in three tiers by rank
//   lookup  pages for anyone on GitHub (src/lookup.ts), built on demand
//   extra   accounts holders added to their own list (src/holderwatch.ts), at a lower priority
//   enrich  the extra facts on a line's own page (src/enrich.ts)
//   rank    the ranking's few core requests (followers of the best-ranked projects)
// The search API (the ranking's daily pass and the lookup search) has its own per-minute limit and does not touch these.
// 304 answers to conditional requests are free on GitHub's side; they are booked, but not counted.
import { spendSince, spentBy, type DB } from "./db.ts";
import type { SchedulePlan, ScheduleTier } from "./types.ts";

type Env = Record<string, string | undefined>;
const int = (v: string | undefined, d: number, min = 0, max = 100_000) => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export const PARTS = ["watch", "lookup", "extra", "enrich", "rank"] as const;
export type SharePart = (typeof PARTS)[number];
export const PART_LABEL: Record<SharePart, string> = {
  watch: "Top projects, polled by tier",
  lookup: "lookups (anyone on GitHub)",
  extra: "holders' added accounts",
  enrich: "a line's own page",
  rank: "ranking extras",
};

export type Shares = Record<SharePart, number>;

/** The reserved share of each part, requests an hour. With a token they add up to well under 5,000. */
export function sharesFor(authenticated: boolean, env: Env = process.env): Shares {
  const d: Shares = authenticated ? { watch: 2400, lookup: 600, extra: 400, enrich: 300, rank: 150 } : { watch: 40, lookup: 8, extra: 3, enrich: 4, rank: 2 };
  const out = { ...d };
  for (const p of PARTS) out[p] = int(env[`PUSHD_GH_SHARE_${p.toUpperCase()}`], d[p], 0, authenticated ? 5000 : 60);
  return out;
}

/** The three polling tiers of the Top N, by rank, and how much slower each is than the first. */
export const TIER_SHAPE = [
  { tier: 1 as const, upTo: 20, factor: 1 },
  { tier: 2 as const, upTo: 50, factor: 2.5 },
  { tier: 3 as const, upTo: Infinity, factor: 6 },
];

/** What one poll costs on average: the events, plus the repo list and gists every few polls (src/watcher.ts). */
export function pollCost(authenticated: boolean): number {
  // with a token: repo list every 4th poll, gists every 2nd, and about one read of a repo in seven polls
  return authenticated ? 1 + 1 / 4 + 0.5 * 0.6 + 0.15 : 1 + 1 / 6 + 0.25 * 0.6 + 0.1;
}

export const tierOf = (rank: number): 1 | 2 | 3 => TIER_SHAPE.find((t) => rank <= t.upTo)!.tier;

/**
 * Minutes between two reads of a project in each tier, so that polling `n` projects fits in `perHour` requests:
 * requests an hour = cost x 60 x sum over tiers (accounts / (base x factor)). Never faster than `floorMin`.
 */
export function tierMinutes(n: number, perHour: number, authenticated: boolean, floorMin = 2): Record<1 | 2 | 3, number> {
  const counts = TIER_SHAPE.map((t, i) => Math.max(0, Math.min(n, t.upTo) - (i ? TIER_SHAPE[i - 1].upTo : 0)));
  const weight = TIER_SHAPE.reduce((s, t, i) => s + counts[i] / t.factor, 0);
  const base = perHour > 0 && weight > 0 ? Math.max(floorMin, (60 * pollCost(authenticated) * weight) / perHour) : 24 * 60;
  const r = (x: number) => (x < 10 ? Math.round(x * 2) / 2 : Math.round(x));
  return { 1: r(base * TIER_SHAPE[0].factor), 2: r(base * TIER_SHAPE[1].factor), 3: r(base * TIER_SHAPE[2].factor) };
}

/** Minutes between two reads of one holder-added account, with `n` of them sharing the extra share. */
export function extraMinutes(n: number, perHour: number, authenticated: boolean): number {
  if (n <= 0) return 0;
  if (perHour <= 0) return 24 * 60;
  return Math.max(authenticated ? 10 : 120, Math.round((60 * pollCost(authenticated) * n) / perHour));
}

const ranksText = (i: number, n: number) => {
  const from = i ? TIER_SHAPE[i - 1].upTo + 1 : 1;
  const to = Math.min(n, TIER_SHAPE[i].upTo);
  return to < from ? "none" : `${from} to ${to}`;
};

/** The plan as the site shows it: the tiers now, with a token and without, the shares, and the last hour's spend. */
export function schedulePlan(db: DB | null, n: number, authenticated: boolean, env: Env = process.env, now = Date.now()): SchedulePlan {
  const withT = tierMinutes(n, sharesFor(true, env).watch, true);
  const without = tierMinutes(n, sharesFor(false, env).watch, false);
  const cur = authenticated ? withT : without;
  const tiers: ScheduleTier[] = TIER_SHAPE.map((t, i) => {
    const accounts = Math.max(0, Math.min(n, t.upTo) - (i ? TIER_SHAPE[i - 1].upTo : 0));
    return { tier: t.tier, ranks: ranksText(i, n), accounts, everyMin: cur[t.tier], withTokenMin: withT[t.tier], withoutTokenMin: without[t.tier] };
  }).filter((t) => t.accounts > 0);
  const shares = sharesFor(authenticated, env);
  const spent = db ? spendSince(db, now - 3_600_000).filter((r) => r.resource === "core") : [];
  return {
    authenticated,
    limitPerHour: authenticated ? 5000 : 60,
    tiers,
    shares: PARTS.map((p) => ({ key: p, label: PART_LABEL[p], perHour: shares[p] })),
    spentLastHour: PARTS.map((p) => ({ key: p, n: spent.filter((r) => r.part === p).reduce((s, r) => s + r.n, 0) })),
    note: authenticated
      ? "Read with a GitHub token: each part has its own share of the hourly allowance, and the shares add up to well under it."
      : "No GitHub token yet: 60 requests an hour, so fewer reads, and the lower tiers are read in turn. A token makes every tier fast.",
  };
}

/** Is there room in this part's share for `cost` more requests this hour? */
export function shareRoom(db: DB, part: SharePart, authenticated: boolean, cost = 1, now = Date.now(), env: Env = process.env): boolean {
  return spentBy(db, part, now - 3_600_000) + cost <= sharesFor(authenticated, env)[part];
}
