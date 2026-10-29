import { SAMPLE_AS_OF, SAMPLE_WATCHLIST } from "./sample";
import type { GroupKey, RankRow, SchedulePlan, ScorePart, TopView } from "./types";

// The list for the site with no engine: a handful of rows from the sample's made-up handles only (no real person
// gets a made-up score), every one marked sample. The page says Sample on it.

const WEIGHTS: { key: string; label: string; weight: number }[] = [
  { key: "commits", label: "commits and pushes", weight: 3 },
  { key: "contributors", label: "active contributors", weight: 2 },
  { key: "prs", label: "issues and pull requests", weight: 1.5 },
  { key: "releases", label: "releases and tags", weight: 1.5 },
  { key: "newRepos", label: "new repos", weight: 1 },
  { key: "stars", label: "star velocity", weight: 1 },
  { key: "forks", label: "fork velocity", weight: 0.5 },
  { key: "followers", label: "owner followers", weight: 0.5 },
  { key: "pushd", label: "PUSHD's own signals", weight: 1 },
];

const total = WEIGHTS.reduce((n, w) => n + w.weight, 0);

function parts(seed: number): ScorePart[] {
  return WEIGHTS.map((w, i) => {
    const norm = Math.round(((Math.sin(seed * 7.1 + i * 3.3) + 1) / 2) * 100) / 100;
    const d30 = Math.round(norm * 120);
    return { key: w.key, label: w.label, raw: { "24h": Math.round(d30 / 30), "7d": Math.round(d30 / 4), "30d": d30 }, norm, weight: w.weight, points: Math.round(((norm * w.weight) / total) * 1000) / 10 };
  });
}

export const SAMPLE_SCHEDULE: SchedulePlan = {
  authenticated: true,
  limitPerHour: 5000,
  tiers: [
    { tier: 1, ranks: "1 to 20", accounts: 20, everyMin: 2, withTokenMin: 2, withoutTokenMin: 90 },
    { tier: 2, ranks: "21 to 50", accounts: 30, everyMin: 5, withTokenMin: 5, withoutTokenMin: 360 },
    { tier: 3, ranks: "51 to 100", accounts: 50, everyMin: 12, withTokenMin: 12, withoutTokenMin: 720 },
  ],
  shares: [
    { key: "watch", label: "list polling", perHour: 2400 },
    { key: "lookup", label: "lookups (anyone on GitHub)", perHour: 600 },
    { key: "extra", label: "holders' added accounts", perHour: 400 },
    { key: "enrich", label: "line pages", perHour: 300 },
    { key: "rank", label: "ranking extras", perHour: 100 },
  ],
  spentLastHour: [],
  note: "Sample plan. The real one is worked out from the server's own GitHub allowance.",
};

export function sampleTop(): TopView {
  const members = SAMPLE_WATCHLIST.flatMap((g) => g.members).filter((m) => m.sample);
  const rows: RankRow[] = members.map((m, i) => {
    const p = parts(i + 1);
    const score = Math.round(p.reduce((n, x) => n + x.points, 0) * 10) / 10;
    return {
      rank: 0,
      handle: m.handle,
      ...(m.name ? { name: m.name } : {}),
      group: m.group,
      type: "user",
      score,
      movement: (["up", "new", "same", "down", "up", "same"] as const)[i % 6],
      delta: [3, 0, 0, -2, 1, 0][i % 6],
      inTop: true,
      enteredAt: SAMPLE_AS_OF,
      tier: i < 2 ? 1 : i < 4 ? 2 : 3,
      checkEveryMin: i < 2 ? 2 : i < 4 ? 5 : 12,
      parts: p,
      topRepos: [],
      lastActiveAt: SAMPLE_AS_OF,
      token: null,
      sample: true,
    };
  });
  rows.sort((a, b) => b.score - a.score).forEach((r, i) => (r.rank = i + 1));
  const byCamp = Object.fromEntries((["chain", "wallets", "launchpads", "ai", "oss"] as GroupKey[]).map((g) => [g, rows.filter((r) => r.group === g).length])) as Record<GroupKey, number>;
  const last = rows[rows.length - 1];
  return {
    asOf: SAMPLE_AS_OF,
    lastPass: SAMPLE_AS_OF,
    lastDeepPass: SAMPLE_AS_OF,
    passes: 1,
    pool: rows.length,
    rows,
    waiting: [],
    entered: rows.filter((r) => r.movement === "new").map((r) => ({ at: SAMPLE_AS_OF, handle: r.handle, group: r.group, change: "enter" as const, rank: r.rank, reason: `Sample: passed, ranked #${r.rank}.` })),
    dropped: last ? [{ at: SAMPLE_AS_OF, handle: "@quietdev", group: "oss", change: "exit", rank: 131, reason: "Sample: activity dropped 70% over 14 days." }] : [],
    byCamp,
    weights: WEIGHTS,
    rules: { size: 100, enterRank: 90, enterPasses: 3, exitRank: 130, exitPasses: 6, minDwellHours: 24, campMin: 10 },
    schedule: SAMPLE_SCHEDULE,
    sample: true,
  };
}
