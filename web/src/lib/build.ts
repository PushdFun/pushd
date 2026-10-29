// PUSHD Agents as the site shows them: the jobs and triggers (the engine's whitelist, engine/src/agents/spec.ts, word
// for word: the engine's test/agents-site.test.ts checks the two agree) and the shapes the engine's /v1/build routes
// answer in. Safe for the browser: no settings, no secrets.
import type { ScoutId } from "./types";

export const TRIGGERS = ["push", "schedule_daily", "schedule_weekly", "issue_opened", "pr_opened", "request"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABEL: Record<Trigger, string> = {
  push: "after every push",
  schedule_daily: "every day",
  schedule_weekly: "every week",
  issue_opened: "on each new issue",
  pr_opened: "on each new pull request",
  request: "when you ask",
};

export const JOB_IDS = ["release_notes", "ship_post", "secret_check", "small_change", "pr_review", "issue_helper", "weekly_report", "dependency_watch", "release_maker", "docs_keeper"] as const;
export type JobId = (typeof JOB_IDS)[number];

export type JobInfo = { title: string; what: string; triggers: readonly Trigger[]; byDefault: Trigger; free?: boolean };

export const JOBS: Record<JobId, JobInfo> = {
  release_notes: { title: "Release notes", what: "Release notes and a changelog line for what was pushed, as a pull request or a draft here.", triggers: ["push", "request"], byDefault: "push" },
  ship_post: { title: "What shipped post", what: "A short post about what shipped, for you to copy. It is never posted for you.", triggers: ["push", "schedule_weekly", "request"], byDefault: "push" },
  secret_check: { title: "Key check", what: "Reads each push for keys and passwords and warns you, with the key masked.", triggers: ["push"], byDefault: "push", free: true },
  small_change: { title: "Small changes", what: "A fix, docs, the README or tests when you ask, always as a pull request on a new branch.", triggers: ["request"], byDefault: "request" },
  pr_review: { title: "Pull request review", what: "Comments its findings on your own pull requests.", triggers: ["pr_opened", "request"], byDefault: "pr_opened" },
  issue_helper: { title: "Issue helper", what: "Labels new issues and drafts a reply for you to approve, or posts it if you switch that on.", triggers: ["issue_opened", "request"], byDefault: "issue_opened" },
  weekly_report: { title: "Weekly report", what: "What the project shipped this week, on its public page, with a post to copy.", triggers: ["schedule_weekly", "request"], byDefault: "schedule_weekly" },
  dependency_watch: { title: "Dependency watch", what: "Flags dependencies with known vulnerabilities or far behind, with an optional pull request to bump them.", triggers: ["schedule_daily", "schedule_weekly", "request"], byDefault: "schedule_weekly" },
  release_maker: { title: "Release maker", what: "Drafts a GitHub release with notes. You publish it.", triggers: ["request", "schedule_weekly"], byDefault: "request" },
  docs_keeper: { title: "Docs keeper", what: "A pull request when the README no longer matches the code.", triggers: ["schedule_weekly", "request"], byDefault: "schedule_weekly" },
};

export type JobSpec = { job: JobId; trigger: Trigger; deliver?: "pr" | "draft"; post?: boolean; bumpPr?: boolean };
export type AgentSpec = { name: string; model: ScoutId; repos: string[]; jobs: JobSpec[] };

export type BuildConfig = {
  on: boolean;
  ready: boolean;
  signIn: boolean;
  installUrl: string | null;
  freePerDay: number;
  price: { wei: string; eth: string };
  paused: boolean;
  scoutsOrg: string;
  stats: { agents: number; runs: number; pullRequests: number; paidRuns: number };
};

export type Finding = { file: string; line: number | null; kind: string; masked: string };
export type DepFinding = { name: string; ecosystem: string; current: string; latest: string | null; vulns: string[]; behind: boolean };

export type Output =
  | { type: "draft"; title: string; text: string }
  | { type: "post"; text: string }
  | { type: "report"; text: string }
  | { type: "warning"; text: string }
  | { type: "findings"; items: Finding[] }
  | { type: "deps"; items: DepFinding[] }
  | { type: "link"; label: string; url: string }
  | { type: "approval"; kind: "issue_reply"; issue: number; text: string; state: "waiting" | "posted" | "dismissed"; url?: string };

export type RunView = {
  id: string;
  agentId: string;
  job: string;
  jobTitle: string;
  trigger: string;
  repo: string;
  status: string;
  billing: string;
  createdAt: number;
  finishedAt: number | null;
  model: string | null;
  usd: number;
  summary: string | null;
  outputs: Output[];
  flags: string[];
  error: string | null;
  actions: { action: string; url: string | null; note: string | null; at: number }[];
  payment: { tx: string } | null;
};

export type AgentView = { id: string; name: string; text: string; spec: AgentSpec; paused: boolean; proof: boolean; createdAt: number; updatedAt: number; runs: number; lastRunAt: number | null };

export type BuildMe = {
  user: { id: number; login: string };
  wallet: string | null;
  holder: boolean;
  repos: string[];
  agents: AgentView[];
  allowed: number;
  tiers: { minWhole: string; agents: number }[];
  freePerDay: number;
  freeLeft: number | null;
  paused: boolean;
  price: { wei: string; eth: string; payTo: string | null; open: boolean };
  inbox: { n: number; runId: string | null; at: number; title: string; body: string; seen: boolean }[];
  installUrl: string | null;
};

export type Shipped = {
  repo: string;
  runs: RunView[];
  counts: { runs: number; pullRequests: number; commits: number; releases: number; last30d: number };
  reports: { at: number; text: string }[];
  since: number | null;
};

export type ScoutBuild = {
  id: ScoutId;
  name: string;
  maker: string;
  repo: string;
  installed: boolean;
  round: string;
  options: { text: string; votes: number }[];
  myVote: number | null;
  latest: { at: number; title: string | null; summary: string | null; url: string | null }[];
};

/** A run's state in plain words. */
export const STATUS_WORDS: Record<string, string> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "did not finish",
  paused: "paused for today",
  skipped: "not run",
  waiting_payment: "waits for payment",
  lapsed: "not paid",
  cancelled: "cancelled",
};

/** The jobs an agent can be asked to run now: its own jobs whose whitelist allows a request. */
export const requestable = (spec: AgentSpec): JobId[] => [...new Set(spec.jobs.map((j) => j.job))].filter((j) => JOBS[j].triggers.includes("request"));
