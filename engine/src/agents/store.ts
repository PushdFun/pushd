// The agents' tables, in the engine's store. GitHub accounts and their sessions (only a hash of a session token is
// kept; no GitHub token is ever stored), the installations of the PUSHD GitHub App and the repos each person reached
// through them, webhook deliveries already handled, the agents, their runs (each run is its receipt), every action a
// run took (written once, never changed), the commits and releases agents made (so the feed can tag them), the inbox,
// the scouts' build rounds and holders' votes.
import type { DB } from "../db.ts";

export const AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS gh_users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  wallet TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_installs (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gh_user_repos (
  user_id INTEGER NOT NULL,
  install_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (user_id, full_name)
);
CREATE INDEX IF NOT EXISTS gh_user_repos_name ON gh_user_repos(lower(full_name));
CREATE TABLE IF NOT EXISTS gh_deliveries (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  spec TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  proof INTEGER NOT NULL DEFAULT 1,
  scout TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_user ON agents(user_id);
CREATE TABLE IF NOT EXISTS agent_schedule (
  agent_id TEXT NOT NULL,
  job TEXT NOT NULL,
  repo TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, job, repo)
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  job TEXT NOT NULL,
  trigger TEXT NOT NULL,
  repo TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  billing TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  model TEXT,
  usd REAL NOT NULL DEFAULT 0,
  summary TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  payment_tx TEXT,
  public INTEGER NOT NULL DEFAULT 0,
  dedupe TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS agent_runs_user ON agent_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_repo ON agent_runs(lower(repo), created_at);
CREATE TABLE IF NOT EXISTS agent_actions (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT,
  sha TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS agent_actions_run ON agent_actions(run_id);
CREATE TRIGGER IF NOT EXISTS agent_actions_no_update BEFORE UPDATE ON agent_actions BEGIN SELECT RAISE(ABORT, 'agent actions are written once'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_no_delete BEFORE DELETE ON agent_actions BEGIN SELECT RAISE(ABORT, 'agent actions are written once'); END;
CREATE TABLE IF NOT EXISTS agent_marks (
  k TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_inbox (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  run_id TEXT,
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_inbox_user ON agent_inbox(user_id, n);
CREATE TABLE IF NOT EXISTS agent_acts (key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scout_rounds (
  scout TEXT NOT NULL,
  round TEXT NOT NULL,
  options TEXT NOT NULL,
  PRIMARY KEY (scout, round)
);
CREATE TABLE IF NOT EXISTS scout_votes (
  scout TEXT NOT NULL,
  round TEXT NOT NULL,
  address TEXT NOT NULL,
  option INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (scout, round, address)
);
`;

export function ensureAgentsSchema(db: DB) {
  db.exec(AGENTS_SCHEMA);
}

/** The feed's tag: keys for a commit and for a link agents made. */
export const markSha = (repo: string, sha: string) => `sha:${repo.toLowerCase()}@${sha.toLowerCase()}`;
export const markUrl = (url: string) => `url:${url.toLowerCase()}`;
