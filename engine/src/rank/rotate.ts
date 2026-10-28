// The rotation of the Top N, with hysteresis so the list does not churn:
//   - a project enters after it ranks in the top `enterRank` (about 90) for `enterPasses` passes in a row, when a seat
//     is free (the best-ranked first); a free seat with nobody qualified goes to the best project ranked inside N;
//   - it leaves after it ranks below `exitRank` (about 130) for `exitPasses` passes in a row, and never before it has
//     been in for `minDwellHours`; a project that stops being eligible (its token fades, it stops pushing) leaves at once;
//   - each camp keeps at least `campMin` seats when it has that many projects, so every scout has a camp to read.
// Every entry and exit is logged with its reason. Pure: the store is read and written by src/rank/ranker.ts.
import type { GroupKey, ScorePart } from "../types.ts";
import type { RankConfig } from "./config.ts";

export type StateRow = { login: string; in_top: number; entered_at: number | null; left_at: number | null; streak_in: number; streak_out: number; rank: number | null; score: number | null };
export type Change = { login: string; change: "enter" | "exit"; rank: number; reason: string };
export type Ranked = { login: string; score: number; parts: ScorePart[] };

type Rules = Pick<RankConfig, "size" | "enterRank" | "enterPasses" | "exitRank" | "exitPasses" | "minDwellHours" | "campMin">;

/** The order with each camp's minimum kept inside the first `size` places. */
export function campOrder(scored: Ranked[], camp: (login: string) => GroupKey, size: number, campMin: number): Ranked[] {
  const head = scored.slice(0, size);
  const tail = scored.slice(size);
  if (campMin > 0) {
    const count = (g: GroupKey) => head.filter((x) => camp(x.login) === g).length;
    for (const g of ["chain", "wallets", "launchpads", "ai", "oss"] as GroupKey[]) {
      while (count(g) < campMin) {
        const i = tail.findIndex((x) => camp(x.login) === g);
        if (i < 0) break;
        // the lowest place held by a camp that has more than its minimum gives way
        let j = -1;
        for (let k = head.length - 1; k >= 0 && j < 0; k--) if (count(camp(head[k].login)) > campMin) j = k;
        if (j < 0) break;
        const [out] = head.splice(j, 1);
        const [inn] = tail.splice(i, 1);
        head.push(inn);
        tail.unshift(out);
      }
    }
    head.sort((a, b) => b.score - a.score);
    tail.sort((a, b) => b.score - a.score);
  }
  return [...head, ...tail];
}

const lead = (parts: ScorePart[]) => {
  const p = [...parts].sort((a, b) => b.points - a.points)[0];
  return p && p.points > 0 ? `, led by ${p.label}` : "";
};

export type RotateInput = {
  order: Ranked[];
  state: Map<string, StateRow>;
  /** projects in the Top N that are no longer eligible, with why */
  gone: Map<string, string>;
  /** the highest score a project had in the last 14 days (for the exit reason) */
  peak14: (login: string) => number | null;
  rules: Rules;
  now: number;
};

export function rotate(i: RotateInput): { next: Map<string, StateRow>; changes: Change[] } {
  const r = i.rules;
  const next = new Map<string, StateRow>();
  for (const [k, v] of i.state) next.set(k, { ...v });
  const changes: Change[] = [];
  const rankOf = new Map(i.order.map((x, idx) => [x.login, idx + 1]));
  const byLogin = new Map(i.order.map((x) => [x.login, x]));
  const blank = (login: string): StateRow => ({ login, in_top: 0, entered_at: null, left_at: null, streak_in: 0, streak_out: 0, rank: null, score: null });

  // streaks
  for (const x of i.order) {
    const st = next.get(x.login) ?? blank(x.login);
    const rank = rankOf.get(x.login)!;
    if (st.in_top) {
      st.streak_out = rank > r.exitRank ? st.streak_out + 1 : 0;
      st.streak_in = 0;
    } else {
      st.streak_in = rank <= r.enterRank ? st.streak_in + 1 : 0;
      st.streak_out = 0;
    }
    st.rank = rank;
    st.score = x.score;
    next.set(x.login, st);
  }

  // exits: no longer eligible (at once), or below the exit rank long enough and in long enough
  for (const st of next.values()) {
    if (!st.in_top) continue;
    const why = i.gone.get(st.login);
    const inFor = st.entered_at ? i.now - st.entered_at : Infinity;
    if (why || !rankOf.has(st.login)) {
      changes.push({ login: st.login, change: "exit", rank: st.rank ?? 0, reason: `no longer eligible: ${why ?? "it left the pool"}` });
      Object.assign(st, { in_top: 0, left_at: i.now, streak_out: 0, streak_in: 0 });
      continue;
    }
    if (st.streak_out >= r.exitPasses && inFor >= r.minDwellHours * 3_600_000) {
      const peak = i.peak14(st.login);
      const now = st.score ?? 0;
      const drop = peak && peak > 0 ? 1 - now / peak : 0;
      const reason =
        drop >= 0.3
          ? `activity dropped ${Math.round(drop * 100)}% over 14 days (score ${Math.round(peak!)} to ${Math.round(now)})`
          : `ranked below ${r.exitRank} for ${st.streak_out} passes in a row`;
      changes.push({ login: st.login, change: "exit", rank: st.rank ?? 0, reason });
      Object.assign(st, { in_top: 0, left_at: i.now, streak_out: 0, streak_in: 0 });
    }
  }

  // entries
  const members = () => [...next.values()].filter((s) => s.in_top).length;
  const enter = (login: string, reason: string) => {
    const st = next.get(login)!;
    Object.assign(st, { in_top: 1, entered_at: i.now, streak_in: 0, streak_out: 0 });
    changes.push({ login, change: "enter", rank: st.rank ?? 0, reason: reason + lead(byLogin.get(login)?.parts ?? []) });
  };
  if (members() === 0) {
    for (const x of i.order.slice(0, r.size)) enter(x.login, "in the first ranking pass");
    return { next, changes };
  }
  const qualified = i.order.filter((x) => !next.get(x.login)!.in_top && next.get(x.login)!.streak_in >= r.enterPasses && !i.gone.has(x.login));
  for (const x of qualified) {
    if (members() >= r.size) break;
    enter(x.login, `ranked in the top ${r.enterRank} for ${next.get(x.login)!.streak_in} passes in a row`);
  }
  for (const x of i.order) {
    if (members() >= r.size) break;
    const st = next.get(x.login)!;
    if (st.in_top || (st.rank ?? Infinity) > r.size || i.gone.has(x.login)) continue;
    enter(x.login, `a seat was free and it ranked #${st.rank}`);
  }
  return { next, changes };
}
