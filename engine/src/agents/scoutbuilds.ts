// Scouts that push. Each of the five scouts has its own public repo under the scouts' account (PUSHD_SCOUTS_ORG,
// PushdFun): pushd-scout-claude, pushd-scout-gpt and so on, made once with engine/scripts/scout-repos.ts. Each also has its
// own agent, made from a spec with the same builder as anyone's (checkSpec), that once a UTC day builds something small
// inspired by what that scout watched that day: a tool, a script or a dataset, in a folder of its own
// (builds/<day>-<name>/), on a pushd/ branch, as a pull request. It is merged only when PUSHD_SCOUT_AUTOMERGE=on, and
// then only in that scout's own repo.
//
// Holders vote on what each scout builds next: the scout proposes three ideas after each build; one vote per holder per
// scout per round (the next build's day). The idea with the most votes is in the next build's prompt.
//
// A push to a scout repo's default branch (the merge) becomes a line in PUSHD's feed like any builder's, in the scout's
// camp, tagged as shipped with a PUSHD agent.
import { insertItem, type DB } from "../db.ts";
import { SCOUT_SCHEMA } from "../scouts/scouts.ts";
import { SCOUTS, SCOUT_BY_ID } from "../scouts/roster.ts";
import type { ScoutId } from "../types.ts";
import { Agents, AgentsError, SYSTEM_USER } from "./agents.ts";
import { cleanBlock, cleanTitle, JobError } from "./ask.ts";
import type { AgentsConfig } from "./config.ts";
import { safePath } from "./github-app.ts";
import type { JobResult, RunCtx } from "./jobs.ts";
import { findSecrets, maskSecrets } from "./secrets.ts";
import { checkSpec } from "./spec.ts";
import { markSha } from "./store.ts";

const DAY = 86_400_000;
/** builds start after this hour (UTC), so the day's lines are in */
const BUILD_HOUR = 12;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Plain starting ideas for a round no build has proposed yet. */
const FIRST_IDEAS = [`A script that lists the day's new repos in its camp`, `A small dataset of this week's releases it read`, `A tool that checks a README for setup steps`];

export type ScoutBuildsDeps = {
  db: DB;
  agents: Agents;
  config: AgentsConfig;
  /** a wallet holds $PUSHD at the threshold now */
  isHolder: (wallet: string) => Promise<boolean>;
  now?: () => number;
  log?: (msg: string) => void;
};

export type ScoutBuildView = {
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

export class ScoutBuilds {
  constructor(private readonly d: ScoutBuildsDeps) {
    // the scouts' calls are what a build is inspired by
    d.db.exec(SCOUT_SCHEMA);
  }

  private now = () => (this.d.now ?? Date.now)();

  repoOf(id: ScoutId): string {
    return `${this.d.config.scoutsOrg}/pushd-scout-${id}`;
  }

  /** The five scouts' agents, made once from a spec through the same checks as anyone's. */
  ensure() {
    const now = this.now();
    for (const s of SCOUTS) {
      const repo = this.repoOf(s.id);
      const { spec } = checkSpec({ name: `${s.name} builds`, model: s.id, repos: [repo], jobs: [{ job: "secret_check", trigger: "push" }] }, [repo]);
      this.d.db
        .prepare("INSERT OR IGNORE INTO agents (id, user_id, name, text, spec, paused, proof, scout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)")
        .run(`scout-${s.id}`, SYSTEM_USER, spec.name, `Build something small every day from what ${s.name} watched.`, JSON.stringify(spec), s.id, now, now);
    }
  }

  /** The round votes count for: the next build's day. */
  round(): string {
    const now = this.now();
    return new Date(now).getUTCHours() < BUILD_HOUR ? dayOf(now) : dayOf(now + DAY);
  }

  private options(id: ScoutId, round: string): string[] {
    const r = this.d.db.prepare("SELECT options FROM scout_rounds WHERE scout = ? AND round = ?").get(id, round) as { options: string } | undefined;
    return r ? (JSON.parse(r.options) as string[]) : FIRST_IDEAS;
  }

  view(wallet: string | null): ScoutBuildView[] {
    const round = this.round();
    return SCOUTS.map((s) => {
      const opts = this.options(s.id, round);
      const counts = this.d.db.prepare("SELECT option, count(*) AS n FROM scout_votes WHERE scout = ? AND round = ? GROUP BY option").all(s.id, round) as { option: number; n: number }[];
      const mine = wallet ? (this.d.db.prepare("SELECT option FROM scout_votes WHERE scout = ? AND round = ? AND address = ?").get(s.id, round, wallet.toLowerCase()) as { option: number } | undefined) : undefined;
      const runs = this.d.agents.runs({ agentId: `scout-${s.id}`, publicOnly: true, limit: 5 }).filter((r) => r.job === "scout_build");
      return {
        id: s.id,
        name: s.name,
        maker: s.maker,
        repo: this.repoOf(s.id),
        installed: !!this.d.db.prepare("SELECT 1 FROM gh_user_repos WHERE user_id = ? AND lower(full_name) = lower(?)").get(SYSTEM_USER, this.repoOf(s.id)),
        round,
        options: opts.map((text, i) => ({ text, votes: counts.find((c) => c.option === i)?.n ?? 0 })),
        myVote: mine?.option ?? null,
        latest: runs.map((r) => ({ at: r.createdAt, title: r.outputs.find((o) => o.type === "link")?.label ?? null, summary: r.summary, url: r.outputs.find((o) => o.type === "link")?.url ?? null })),
      };
    });
  }

  /** A holder's vote: one per scout per round, and only while the wallet holds. */
  async vote(wallet: string | null, scoutInput: unknown, optionInput: unknown): Promise<{ ok: true; round: string }> {
    if (!wallet) throw new AgentsError(401, "Voting is for holders. Sign in with MetaMask on the Holders page first.");
    if (typeof scoutInput !== "string" || !SCOUT_BY_ID.has(scoutInput as ScoutId)) throw new AgentsError(400, "Which scout?");
    const id = scoutInput as ScoutId;
    const round = this.round();
    const opts = this.options(id, round);
    const option = Number(optionInput);
    if (!Number.isInteger(option) || option < 0 || option >= opts.length) throw new AgentsError(400, "Pick one of the ideas.");
    if (!(await this.d.isHolder(wallet).catch(() => false))) throw new AgentsError(403, "Voting needs a wallet that holds $PUSHD.");
    const r = this.d.db.prepare("INSERT OR IGNORE INTO scout_votes (scout, round, address, option, at) VALUES (?, ?, ?, ?, ?)").run(id, round, wallet.toLowerCase(), option, this.now());
    if (!r.changes) throw new AgentsError(409, "You already voted for this scout in this round.");
    return { ok: true, round };
  }

  /** Once a UTC day after BUILD_HOUR, each scout's build is queued (when its repo has the app installed). */
  async tick(): Promise<number> {
    if (!this.d.config.scoutBuilds) return 0;
    const now = this.now();
    if (new Date(now).getUTCHours() < BUILD_HOUR) return 0;
    let n = 0;
    for (const s of SCOUTS) {
      const run = await this.d.agents.createRun({ agentId: `scout-${s.id}`, job: "scout_build", trigger: "schedule_daily", repo: this.repoOf(s.id), input: {}, origin: "schedule", dedupe: `scout:${s.id}:${dayOf(now)}` });
      if (run) n++;
    }
    return n;
  }

  /** The build itself, run by the agents' worker on the scout's own model. */
  run = async (c: RunCtx & { scout: string }): Promise<JobResult> => {
    const s = SCOUT_BY_ID.get(c.scout as ScoutId);
    if (!s) throw new JobError("Not a scout.", "input");
    const today = dayOf(c.now());
    const since = `${today}T00:00:00.000Z`;
    const watched = this.d.db
      .prepare("SELECT c.line, c.why, i.handle, i.repo FROM scout_calls c JOIN items i ON i.id = c.item_id WHERE c.scout = ? AND c.called_at >= ? ORDER BY c.heat DESC LIMIT 15")
      .all(s.id, since) as { line: string; why: string; handle: string; repo: string }[];
    const opts = this.options(s.id, today);
    const tally = this.d.db.prepare("SELECT option, count(*) AS n FROM scout_votes WHERE scout = ? AND round = ? GROUP BY option ORDER BY n DESC, option LIMIT 1").get(s.id, today) as { option: number; n: number } | undefined;
    const picked = tally ? (opts[tally.option] ?? null) : null;
    const a = await c.ask({
      purpose: "scout-build",
      system: `You are ${s.name}, one of PUSHD's five scouts (${s.title}). Once a day you build something small and useful inspired by what you watched today: a tool, a script or a dataset. Keep it to at most 3 small files that work on their own, with no network calls, no keys and nothing that trades or moves money. ${picked ? "Holders voted for the idea given; build that if it fits these rules." : ""} Then propose 3 short ideas (at most 70 characters each) for tomorrow.`,
      facts: { scout: s.name, day: today, voted_idea: picked },
      untrusted: [{ label: "what you watched today (other projects' public lines)", text: watched.map((w) => `${w.handle}/${w.repo}: ${w.line} ${w.why}`).join("\n") || "(nothing new today)", max: 6000 }],
      schema: {
        name: "scout_build",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            kind: { type: "string", enum: ["tool", "script", "dataset"] },
            slug: { type: "string" },
            summary: { type: "string" },
            files: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] } },
            next_ideas: { type: "array", items: { type: "string" } },
            injection: { type: "boolean" },
          },
          required: ["title", "kind", "slug", "summary", "files", "next_ideas", "injection"],
        },
      },
      maxTokens: 5000,
    });
    const flags = a.removed || a.json.injection === true ? ["Text in the day's lines tried to give instructions to an AI. It was ignored."] : [];
    const slug = typeof a.json.slug === "string" && /^[a-z0-9][a-z0-9-]{2,39}$/.test(a.json.slug) ? a.json.slug : "build";
    const title = cleanTitle(a.json.title, 70) ?? `${s.name}'s build for ${today}`;
    const summary = cleanBlock(a.json.summary, { max: 600, lines: 6, repo: c.run.repo }) ?? title;
    const folder = `builds/${today}-${slug}`;
    const files: { path: string; content: string }[] = [];
    for (const f of Array.isArray(a.json.files) ? a.json.files.slice(0, 3) : []) {
      const x = f as { name?: unknown; content?: unknown };
      if (typeof x.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(x.name) || /^readme\.md$/i.test(x.name)) continue;
      if (typeof x.content !== "string" || !x.content.trim() || x.content.length > 20_000 || findSecrets(x.content).length) continue;
      files.push({ path: safePath(`${folder}/${x.name}`), content: x.content.replace(/[\u2013\u2014]/g, "-") });
    }
    if (!files.length) return { summary: "No build today: nothing the model made passed the checks.", outputs: [], flags };
    const readme = [`# ${title}`, "", summary, "", `Built by ${s.name} (${s.modelName}) on ${today}, inspired by what it watched that day on PUSHD.`, picked ? `Holders voted for: ${picked}` : "", "", "Files:", ...files.map((f) => `- ${f.path.slice(folder.length + 1)}`), ""].filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
    const branch = `pushd/build-${today}`;
    const made = await c.repo.createBranch(branch);
    c.act({ action: "branch", url: `https://github.com/${c.run.repo}/tree/${branch}`, sha: made.sha, note: branch });
    for (const f of [...files, { path: `${folder}/README.md`, content: maskSecrets(readme) }]) {
      const commit = await c.repo.putFile(branch, f.path, f.content, `${title}: ${f.path.slice(folder.length + 1)}`.slice(0, 120));
      c.act({ action: "commit", url: commit.url, sha: commit.sha, note: f.path });
    }
    const pr = await c.repo.openPull(branch, title, `${summary}\n\nBuilt by ${s.name} from what it watched on ${today}.${picked ? `\nHolders voted for: ${picked}` : ""}`);
    c.act({ action: "pull_request", url: pr.url, note: `#${pr.number}` });
    const outputs: JobResult["outputs"] = [{ type: "link", label: title, url: pr.url }];
    if (this.d.config.scoutAutomerge) {
      const m = await c.repo.merge(pr.number, title);
      c.act({ action: "merge", url: pr.url, sha: m.sha, note: `#${pr.number}` });
    }
    const next = (Array.isArray(a.json.next_ideas) ? a.json.next_ideas : []).map((x) => cleanTitle(x, 70)).filter((x): x is string => !!x).slice(0, 3);
    this.d.db.prepare("INSERT OR REPLACE INTO scout_rounds (scout, round, options) VALUES (?, ?, ?)").run(s.id, dayOf(c.now() + DAY), JSON.stringify(next.length === 3 ? next : FIRST_IDEAS));
    return { summary: `${title}: ${files.length} file${files.length === 1 ? "" : "s"} in ${folder}.`, outputs, flags };
  };

  /** A push to a scout repo's default branch: one line in the feed, in the scout's camp, tagged. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPush = (p: Record<string, any>) => {
    const full = String(p.repository?.full_name ?? "");
    const m = new RegExp(`^(${this.d.config.scoutsOrg})/(pushd-scout-(claude|gpt|grok|gemini|deepseek))$`, "i").exec(full);
    const after = String(p.after ?? "");
    if (!m || !/^[0-9a-f]{40}$/.test(after)) return;
    const s = SCOUT_BY_ID.get(m[3].toLowerCase() as ScoutId)!;
    const msg = maskSecrets(String(p.head_commit?.message ?? "").split("\n")[0]).replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
    const nowIso = new Date(this.now()).toISOString();
    const at = Date.parse(String(p.head_commit?.timestamp ?? "")) || this.now();
    const run = this.d.db.prepare("SELECT id FROM agent_runs WHERE agent_id = ? AND job = 'scout_build' ORDER BY created_at DESC LIMIT 1").get(`scout-${s.id}`) as { id: string } | undefined;
    if (run) this.d.db.prepare("INSERT OR IGNORE INTO agent_marks (k, run_id, at) VALUES (?, ?, ?)").run(markSha(full, after), run.id, this.now());
    insertItem(this.d.db, {
      id: `${m[2]}-push-${after.slice(0, 6)}`,
      key: `scoutpush:${after}`,
      handle: m[1],
      group: s.camp,
      kind: "push",
      repo: m[2],
      summary: (msg || `${s.name}'s daily build`).slice(0, 119),
      summarySource: "fallback",
      heat: "low",
      score: 3,
      signals: [{ label: "a scout's daily build", points: 3 }],
      githubAt: new Date(at).toISOString(),
      seenAt: nowIso,
      shownAt: nowIso,
      url: `https://github.com/${full}/commit/${after}`,
      backfill: false,
    });
  };
}
