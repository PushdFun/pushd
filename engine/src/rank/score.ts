// The activity score: many levels of a project's public activity, each counted over 24 hours, 7 days and 30 days,
// blended with a time decay (newer activity weighs more), normalised against the pool (log scale, the pool's 95th
// percentile is 1), weighted (src/rank/config.ts) and added up to 0..100. Every part keeps its raw counts, so a
// project's page can show why it ranks where it does.
import type { DB } from "../db.ts";
import type { ScorePart } from "../types.ts";
import { repoNoise } from "./classify.ts";
import { PART_DEFS, type PartKey, type RankConfig } from "./config.ts";
import { ghRead, type PoolRow } from "./store.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Windows = { "24h": number; "7d": number; "30d": number };
export type Raw = Record<PartKey, Record<string, number>>;
export type Scored = { login: string; score: number; parts: ScorePart[]; topRepos: string[]; lastActiveAt: string | null };

/** The decayed rate a day: each window's daily rate, weighed by how recent its middle is. */
export function blend(w: Windows, decayDays: number): number {
  const mids: [keyof Windows, number, number][] = [
    ["24h", 0.5, 1],
    ["7d", 3.5, 7],
    ["30d", 15, 30],
  ];
  const ws = mids.map(([, mid]) => Math.exp(-mid / decayDays));
  const sum = ws.reduce((a, b) => a + b, 0);
  return mids.reduce((s, [k, , len], i) => s + (ws[i] / sum) * (w[k] / len), 0);
}

const p95 = (xs: number[]) => {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return 1;
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};


/** Every eligible project's raw counts, from the store. */
export function rawCounts(db: DB, rows: PoolRow[], now = Date.now(), decayDays = 7): Map<string, { raw: Raw; rates: Record<PartKey, number>; topRepos: string[]; lastActiveAt: string | null }> {
  const d7 = new Date(now - 7 * DAY).toISOString();
  const d30 = new Date(now - 30 * DAY).toISOString();
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // GH Archive hours are "YYYY-MM-DD-H"; compare by parsing
  const hourMs = (h: string) => {
    const m = /^(\d{4}-\d{2}-\d{2})-(\d{1,2})$/.exec(h);
    return m ? Date.parse(`${m[1]}T${m[2].padStart(2, "0")}:00:00Z`) : 0;
  };
  const acts = db.prepare("SELECT login, hour, k, n FROM act_hour").all() as { login: string; hour: string; k: string; n: number }[];
  const act = new Map<string, { k: string; n: number; t: number }[]>();
  for (const a of acts) {
    const t = hourMs(a.hour);
    if (now - t > 31 * DAY) continue;
    act.set(a.login, [...(act.get(a.login) ?? []), { k: a.k, n: a.n, t }]);
  }
  const actorsQ = db.prepare("SELECT count(DISTINCT actor) AS n FROM act_actor WHERE login = ? AND day >= ?");
  const reposQ = db.prepare("SELECT repo, sum(n) AS n FROM act_repo WHERE login = ? AND day >= ? GROUP BY repo ORDER BY n DESC LIMIT 3");
  const evQ = db.prepare("SELECT type, github_at FROM events WHERE lower(handle) = ? AND github_at >= ?");
  const catchesQ = db.prepare("SELECT count(*) AS n FROM catches WHERE lower(handle) = ? AND github_at >= ?");
  const heatQ = db.prepare("SELECT avg(score) AS s, count(*) AS n FROM items WHERE lower(handle) = ? AND github_at >= ?");
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const watchQ = has("holder_watch") ? db.prepare("SELECT count(*) AS n FROM holder_watch WHERE lower(login) = ?") : null;
  const suggestQ = has("suggestions") ? db.prepare("SELECT coalesce(sum(count), 0) AS n FROM suggestions WHERE login_lc = ?") : null;
  const volQ = db.prepare("SELECT day, volume FROM token_vol WHERE login = ? AND day >= ? ORDER BY day");

  const out = new Map<string, { raw: Raw; rates: Record<PartKey, number>; topRepos: string[]; lastActiveAt: string | null }>();
  for (const r of rows) {
    const g = ghRead(r);
    const mine = act.get(r.login) ?? [];
    const win = (ks: string[]): Windows => {
      const w = { "24h": 0, "7d": 0, "30d": 0 };
      for (const a of mine) {
        if (!ks.includes(a.k)) continue;
        const age = now - a.t;
        if (age <= DAY) w["24h"] += a.n;
        if (age <= 7 * DAY) w["7d"] += a.n;
        if (age <= 30 * DAY) w["30d"] += a.n;
      }
      return w;
    };
    const ev = evQ.all(r.login, d30) as { type: string; github_at: string }[];
    const evWin = (types: string[]): Windows => {
      const w = { "24h": 0, "7d": 0, "30d": 0 };
      for (const e of ev) {
        if (!types.includes(e.type)) continue;
        const age = now - Date.parse(e.github_at);
        if (age <= DAY) w["24h"]++;
        if (age <= 7 * DAY) w["7d"]++;
        w["30d"]++;
      }
      return w;
    };
    const maxW = (a: Windows, b: Windows): Windows => ({ "24h": Math.max(a["24h"], b["24h"]), "7d": Math.max(a["7d"], b["7d"]), "30d": Math.max(a["30d"], b["30d"]) });
    const sumW = (a: Windows, b: Windows): Windows => ({ "24h": a["24h"] + b["24h"], "7d": a["7d"] + b["7d"], "30d": a["30d"] + b["30d"] });

    const commits = maxW(maxW(g ? { "24h": g.commits.d1, "7d": g.commits.d7, "30d": g.commits.d30 } : { "24h": 0, "7d": 0, "30d": 0 }, win(["commits"])), evWin(["push"]));
    const a7 = (actorsQ.get(r.login, dayKey(now - 7 * DAY)) as { n: number }).n;
    const a30 = (actorsQ.get(r.login, dayKey(now - 30 * DAY)) as { n: number }).n;
    const contributors = { "24h": 0, "7d": Math.max(a7, g?.commits.authors7 ?? 0), "30d": Math.max(a30, g?.commits.authors30 ?? 0) };
    contributors["24h"] = Math.min(contributors["7d"], (actorsQ.get(r.login, dayKey(now)) as { n: number }).n);
    const releases = sumW(win(["release", "tag"]), evWin(["release", "ReleaseEvent"]));
    const own = (g?.repos ?? []).filter((x) => !repoNoise(x));
    const newRepos = maxW(
      {
        "24h": own.filter((x) => now - Date.parse(x.createdAt) <= DAY).length,
        "7d": own.filter((x) => now - Date.parse(x.createdAt) <= 7 * DAY).length,
        "30d": own.filter((x) => now - Date.parse(x.createdAt) <= 30 * DAY).length,
      },
      sumW(win(["new_repo"]), evWin(["new-repo"])),
    );
    const stars = win(["star"]);
    const forks = win(["fork"]);
    const issues = win(["pr_open", "pr_merged", "issue_open"]);
    const merged = win(["pr_merged"]);
    const catches = (catchesQ.get(r.login, d30) as { n: number }).n;
    const heat = heatQ.get(r.login, d7) as { s: number | null; n: number };
    const watchers = watchQ ? (watchQ.get(r.login) as { n: number }).n : 0;
    const suggested = suggestQ ? (suggestQ.get(r.login) as { n: number }).n : 0;
    const vols = volQ.all(r.login, dayKey(now - 8 * DAY)) as { day: string; volume: number }[];
    const today = vols.length ? vols[vols.length - 1].volume : (r.volume_usd ?? 0);
    const before = vols.slice(0, -1);
    const avg = before.length ? before.reduce((s, v) => s + v.volume, 0) / before.length : r.volume_h6 != null && r.volume_usd ? (r.volume_h6 * 4 + r.volume_usd) / 2 : today;
    const trend = avg > 0 ? today / avg : 1;
    const pairDays = r.pair_created_at ? Math.max(0, (now - r.pair_created_at) / DAY) : 0;

    const raw: Raw = {
      commits,
      contributors,
      releases,
      newRepos,
      stars,
      forks,
      issues: { ...issues, merged30d: merged["30d"] },
      followers: { total: r.followers ?? 0 },
      pushd: { catches30d: catches, avgHeat7d: Math.round((heat.s ?? 0) * 10) / 10, lines7d: heat.n, holderWatches: watchers, suggestions: suggested },
      token: { pairDays: Math.floor(pairDays), volumeUsd: Math.round(today), volumeTrend: Math.round(trend * 100) / 100 },
    };
    const dk = decayDays;
    const rates: Record<PartKey, number> = {
      commits: blend(commits, dk),
      contributors: contributors["7d"] * 0.7 + contributors["30d"] * 0.3,
      releases: blend(releases, dk),
      newRepos: blend(newRepos, dk),
      stars: blend(stars, dk),
      forks: blend(forks, dk),
      issues: blend(issues, dk) + merged["30d"] / 30,
      followers: r.followers ?? 0,
      pushd: catches * 2 + (heat.s ?? 0) / 2 + watchers + suggested * 0.5,
      token: 0.5 * Math.min(1, Math.log1p(pairDays) / Math.log1p(365)) + 0.5 * Math.min(1, trend / 2),
    };
    const repos = (reposQ.all(r.login, dayKey(now - 30 * DAY)) as { repo: string; n: number }[]).map((x) => x.repo);
    const topRepos = repos.length ? repos : own.filter((x) => x.pushedAt).sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "")).slice(0, 3).map((x) => `${g?.display ?? r.display}/${x.name}`);
    const lastAct = [g?.pushedAt ?? null, ev.length ? ev.reduce((m, e) => (e.github_at > m ? e.github_at : m), "") : null, mine.length ? new Date(Math.max(...mine.map((a) => a.t)) + HOUR).toISOString() : null].filter((x): x is string => !!x).sort().pop() ?? null;
    out.set(r.login, { raw, rates, topRepos, lastActiveAt: lastAct && Date.parse(lastAct) <= now ? lastAct : lastAct ? new Date(now).toISOString() : null });
  }
  return out;
}

/** Scores every project against the rest of the pool. Highest first. */
export function scoreAll(db: DB, rows: PoolRow[], c: Pick<RankConfig, "weights" | "decayDays">, now = Date.now()): Scored[] {
  const counts = rawCounts(db, rows, now, c.decayDays);
  const ref = Object.fromEntries(PART_DEFS.map((p) => [p.key, p95([...counts.values()].map((x) => x.rates[p.key]))])) as Record<PartKey, number>;
  const wsum = PART_DEFS.reduce((s, p) => s + c.weights[p.key], 0) || 1;
  const out: Scored[] = [];
  for (const r of rows) {
    const x = counts.get(r.login);
    if (!x) continue;
    const parts: ScorePart[] = PART_DEFS.map((p) => {
      const v = x.rates[p.key];
      const norm = p.key === "token" ? Math.max(0, Math.min(1, v)) : ref[p.key] > 0 ? Math.max(0, Math.min(1, Math.log1p(v) / Math.log1p(ref[p.key]))) : 0;
      const weight = c.weights[p.key];
      return { key: p.key, label: p.label, raw: x.raw[p.key], norm: Math.round(norm * 1000) / 1000, weight, points: Math.round(((100 * weight * norm) / wsum) * 10) / 10 };
    });
    const score = Math.round(parts.reduce((s, p) => s + p.points, 0) * 10) / 10;
    out.push({ login: r.login, score, parts, topRepos: x.topRepos, lastActiveAt: x.lastActiveAt });
  }
  return out.sort((a, b) => b.score - a.score || a.login.localeCompare(b.login));
}
