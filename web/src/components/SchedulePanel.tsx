import { everyText } from "@/lib/lookup";
import type { RankRules, SchedulePlan } from "@/lib/types";

// How often the list is read (by tier, now, with a token and without one) and how the hourly GitHub allowance is
// shared out, as the engine planned it. And the rotation rules, in plain words.

export function SchedulePanel({ plan, sample = false }: { plan: SchedulePlan; sample?: boolean }) {
  const spent = new Map(plan.spentLastHour.map((s) => [s.key, s.n]));
  const reserved = plan.shares.reduce((n, s) => n + s.perHour, 0);
  return (
    <div className="panel sched">
      <div className="ptitle">
        <h3>How often each project is read</h3>
        <span>{plan.authenticated ? "with a GitHub token" : "without a token: slower"}</span>
      </div>
      <div className="sched-tiers" role="table" aria-label="Polling tiers">
        <div className="st-row st-head" role="row">
          <span role="columnheader">tier</span>
          <span role="columnheader">ranks</span>
          <span role="columnheader">now</span>
          <span role="columnheader" className="hide-s">with a token</span>
          <span role="columnheader" className="hide-s">without</span>
        </div>
        {plan.tiers.map((t) => (
          <div key={t.tier} className="st-row" role="row">
            <span role="cell" className="st-tier">{t.tier}</span>
            <span role="cell">
              {t.ranks} <small className="muted">({t.accounts})</small>
            </span>
            <span role="cell">
              <b>{everyText(t.everyMin)}</b>
            </span>
            <span role="cell" className="hide-s">
              {everyText(t.withTokenMin)}
            </span>
            <span role="cell" className="hide-s">
              {everyText(t.withoutTokenMin)}
            </span>
          </div>
        ))}
      </div>
      <div className="ptitle" style={{ marginTop: 26 }}>
        <h3>The hourly GitHub allowance</h3>
        <span>
          {reserved.toLocaleString("en-US")} of {plan.limitPerHour.toLocaleString("en-US")} reserved
        </span>
      </div>
      <div className="mix">
        {plan.shares.map((s) => {
          const used = spent.get(s.key);
          return (
            <div key={s.key} className="mix-row sched-share">
              <span>{s.label}</span>
              <span className="bar">
                <i style={{ width: `${Math.max(2, Math.round((s.perHour / Math.max(1, plan.limitPerHour)) * 100))}%` }} />
              </span>
              <b>{s.perHour.toLocaleString("en-US")}</b>
              {used != null && <small className="muted sched-used">{used.toLocaleString("en-US")} used, last hour</small>}
            </div>
          );
        })}
      </div>
      <p className="footnote">
        {plan.note}
        {sample ? " (Sample.)" : ""} The rest stays unused as headroom. A check that finds nothing new is answered with 304 and costs nothing.
      </p>
    </div>
  );
}

export function RulesPanel({ rules, weights }: { rules: RankRules; weights: { key: string; label: string; weight: number }[] }) {
  const max = Math.max(1, ...weights.map((w) => w.weight));
  return (
    <div className="panel rules">
      <div className="ptitle">
        <h3>How the list rotates</h3>
        <span>so it does not churn</span>
      </div>
      <ul className="rules-list">
        <li>
          <b>In</b> after {rules.enterPasses} passes in a row in the top {rules.enterRank}.
        </li>
        <li>
          <b>Out</b> after {rules.exitPasses} passes in a row below {rules.exitRank}.
        </li>
        <li>
          <b>Stays</b> at least {rules.minDwellHours} hours once in.
        </li>
        <li>
          <b>Every camp</b> keeps up to {rules.campMin} places when it has that many projects, so each scout has a camp to read.
        </li>
        <li>
          <b>Size</b> {rules.size} at most. Every entry and exit is logged with its reason.
        </li>
      </ul>
      <div className="ptitle" style={{ marginTop: 22 }}>
        <h3>What the score weighs</h3>
        <span>each part 0 to 1, recent counts most</span>
      </div>
      <div className="mix">
        {weights.map((w) => (
          <div key={w.key} className="mix-row">
            <span>{w.label}</span>
            <span className="bar">
              <i style={{ width: `${Math.round((w.weight / max) * 100)}%` }} />
            </span>
            <b>x{w.weight}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
