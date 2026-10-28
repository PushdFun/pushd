// The filter: drops the boring 95% before anything is scored. Pure: it reads only what it is given.
import type { Candidate, Context } from "./types.ts";

export type Verdict = { keep: true } | { keep: false; reason: string };

const DAY = 86_400_000;

/** Accounts that are bots, by their login. */
export const BOT_LOGIN = /(\[bot\]$|^dependabot|^renovate|^github-actions|^greenkeeper|^snyk-bot|^imgbot|^allcontributors|^pre-commit-ci|-bot$|^bot-)/i;

/** Branches made by tools, or that only hold builds. */
const NOISE_BRANCH = /^(refs\/heads\/)?(dependabot\/|renovate\/|release-please--|changeset-release\/|gh-pages$|pages$|snyk-|imgbot$|all-contributors\/)/i;

/** Commit messages that are housekeeping, not news. */
export const NOISE_COMMIT = [
  /^(build|chore|ci|style|test|deps?)(\([^)]*\))?!?:/i,
  /\bbump(s|ed)?\b.*\b(from|to|version|deps?|dependencies)\b/i,
  /^bump\b/i,
  /\bupdate (dependency|dependencies|deps|lock ?file|package-lock|yarn\.lock|cargo\.lock|pnpm-lock)\b/i,
  /\b(fix(es|ed)?|correct(s|ed)?) (a |the |some )?typos?\b/i,
  /^typo\b/i,
  /\b(format(ting)?|reformat|prettier|rustfmt|cargo fmt|gofmt|lint(ing)?|clippy|whitespace)\b/i,
  /^merge (pull request|branch|remote-tracking)\b/i,
  /\b(ci|workflow|github actions?|gh actions?)\b.*\b(fix|update|bump|tweak|change)\b|\b(fix|update|bump|tweak)\b.*\b(ci|workflows?)\b/i,
  /^(wip|tmp|temp|cleanup|clean up|minor|nit|nits)\b/i,
  /^revert\b/i,
  /^v?\d+\.\d+\.\d+(-[\w.]+)?$/i,
];

export const isNoiseCommit = (message: string) => {
  const first = message.split("\n")[0].trim();
  return first === "" || NOISE_COMMIT.some((re) => re.test(first));
};

/** "v2.0.0" -> [2, 0, 0]; null when the tag is not a version. */
export function parseVersion(tag: string): number[] | null {
  const m = tag.match(/(?:^|[^\d])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Tags that are builds, not releases: nightlies, release candidates, alphas and the like. */
const PRE_TAG = /(nightly|canary|snapshot|-rc|\.rc|rc\d|alpha|beta|-dev|\.dev|preview|edge|insiders|-pre)/i;

/** A long-lived repo where pushes are everyday work: older than 90 days and pushed to in the 30 days before. */
export function isRoutineRepo(ctx: Context, at: string): boolean {
  const r = ctx.repo;
  if (!r) return false;
  const t = Date.parse(at);
  const age = t - Date.parse(r.createdAt);
  if (age < 90 * DAY) return false;
  if (!r.pushedAt) return true;
  return t - Date.parse(r.pushedAt) < 30 * DAY;
}

export function filter(c: Candidate, ctx: Context): Verdict {
  if (BOT_LOGIN.test(c.actor)) return { keep: false, reason: `bot account ${c.actor}` };
  const r = ctx.repo;
  if (r?.fork && (c.sub === "new-repo" || c.sub === "push" || c.sub === "made-public")) return { keep: false, reason: "a fork" };

  switch (c.sub) {
    case "new-repo":
    case "made-public":
      return { keep: true };

    case "gist":
      return { keep: true };

    case "release": {
      if (c.prerelease || PRE_TAG.test(c.tag ?? "")) return { keep: false, reason: `pre-release ${c.tag}` };
      const v = parseVersion(c.tag ?? "");
      if (v && v[2] > 0) return { keep: false, reason: `patch release ${c.tag}` };
      return { keep: true };
    }

    case "push": {
      if (c.ref && NOISE_BRANCH.test(c.ref)) return { keep: false, reason: `tool branch ${c.ref}` };
      if (c.defaultBranch === false) return { keep: false, reason: `side branch ${c.ref}` };
      if (c.commits && c.commits.length > 0 && c.commits.every(isNoiseCommit)) return { keep: false, reason: "housekeeping commits" };
      if (ctx.entry.type === "org" && !isSilenceBreak(c, ctx)) return { keep: false, reason: "routine push to an org repo" };
      if (isRoutineRepo(ctx, c.githubAt)) return { keep: false, reason: `routine push to ${c.repo}` };
      return { keep: true };
    }
  }
}

/** Days of quiet before this candidate: from the account's previous activity, or the repo's previous push. */
export function silenceDays(c: Candidate, ctx: Context): number | null {
  const before = [ctx.prevActivityAt, c.sub === "push" ? ctx.repo?.pushedAt : null].filter((x): x is string => !!x);
  if (before.length === 0) return null;
  const last = Math.max(...before.map((x) => Date.parse(x)));
  return Math.floor((Date.parse(c.githubAt) - last) / DAY);
}

/** The first push after a long silence: 30 days or more. */
export const isSilenceBreak = (c: Candidate, ctx: Context) => (silenceDays(c, ctx) ?? 0) >= 30;
