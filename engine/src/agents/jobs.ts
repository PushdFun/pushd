// The jobs an agent can do, one function each. A job reads what it needs from the repo in code (through the repo client,
// on the one repo the run is for), asks the model once at most (ask.ts), checks every field of the answer, and acts
// only through the repo client's guarded writes: a new pushd/ branch and a pull request, a comment, labels that already
// exist on the repo, a draft release. Nothing is ever pushed to the default branch, nothing under .github/ is written,
// nothing is posted to X or anywhere else. Every action is handed to `act`, which writes the run's receipt.
//
// Without a model (no key, or the owner's run over a cap) the jobs that can still be honest do their part from the
// repo's own words and say so; the rest stop with the reason.
import { checkText } from "../scouts/guard.ts";
import { cleanBlock, cleanTitle, JobError, type Answer, type AskOpts } from "./ask.ts";
import { BRANCH_PREFIX, safePath, type RepoClient } from "./github-app.ts";
import { findSecrets, maskSecrets, scanPatches, type Finding } from "./secrets.ts";
import type { AgentSpec, JobId, JobSpec, Trigger } from "./spec.ts";

export type RunInput = {
  /** a push: the commits before and after, and the branch */
  before?: string;
  after?: string;
  ref?: string;
  /** a pull request or an issue by number */
  pr?: number;
  issue?: number;
  /** the owner's own words for a small change, and its kind */
  request?: string;
  kind?: "fix" | "docs" | "readme" | "tests";
};

export type Output =
  | { type: "draft"; title: string; text: string }
  | { type: "post"; text: string }
  | { type: "report"; text: string }
  | { type: "warning"; text: string }
  | { type: "findings"; items: Finding[] }
  | { type: "deps"; items: DepFinding[] }
  | { type: "link"; label: string; url: string }
  | { type: "approval"; kind: "issue_reply"; issue: number; text: string; state: "waiting" | "posted" | "dismissed"; url?: string };

export type JobResult = { summary: string; outputs: Output[]; flags: string[] };

export type Action = { action: "branch" | "commit" | "pull_request" | "comment" | "labels" | "release" | "merge"; url?: string | null; sha?: string | null; note?: string | null };

/** The fixed outside sources dependency watch reads (osv.dev and the npm registry). The tests pass their own. */
export type Outside = {
  vulns(q: { name: string; version: string; ecosystem: "npm" | "PyPI" }[]): Promise<string[][]>;
  npmLatest(name: string): Promise<string | null>;
};

export type RunCtx = {
  run: { id: string; job: JobId; trigger: Trigger; repo: string; input: RunInput };
  spec: AgentSpec;
  jobSpec: JobSpec;
  owner: { id: number; login: string };
  repo: RepoClient;
  /** one model call on the agent's model, within the agents' budget */
  ask: (o: AskOpts) => Promise<Answer>;
  act: (a: Action) => void;
  outside: Outside;
  /** where the project's public page is, for the links PUSHD writes */
  proofUrl: string;
  now: () => number;
};

const ZERO = /^0+$/;
const short = (sha: string) => sha.slice(0, 7);
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const subject = (m: string) => maskSecrets(m.split("\n")[0].replace(/[–—]/g, "-").trim()).slice(0, 120);
const branchFor = (c: RunCtx, what: string) => `${BRANCH_PREFIX}${what}-${c.run.id.slice(0, 8)}`;

const footer = (c: RunCtx) => `\n\n---\nOpened by a PUSHD agent for @${c.owner.login}, on a new branch. Nothing was pushed to the default branch. Read it before you merge.\nWhat this agent shipped: ${c.proofUrl}`;

/** A bullet list of commit subjects, the honest notes when no model writes them. */
const plainNotes = (commits: { message: string }[]) =>
  commits
    .map((x) => subject(x.message))
    .filter((s) => s && !/^merge (branch|pull request)/i.test(s))
    .slice(0, 12)
    .map((s) => `- ${s}`)
    .join("\n");

/** What a push or a request is about: the commits and the files, read in code. */
async function changes(c: RunCtx): Promise<{ commits: { sha: string; message: string }[]; files: { filename: string; status: string; patch: string | null }[]; link: string }> {
  const { before, after } = c.run.input;
  if (after && /^[0-9a-f]{40}$/.test(after)) {
    if (before && /^[0-9a-f]{40}$/.test(before) && !ZERO.test(before)) {
      const d = await c.repo.compare(before, after);
      return { commits: d.commits, files: d.files, link: `https://github.com/${c.run.repo}/compare/${short(before)}...${short(after)}` };
    }
    const one = await c.repo.commit(after);
    return { commits: one ? [{ sha: after, message: one.message }] : [], files: one?.files ?? [], link: `https://github.com/${c.run.repo}/commit/${after}` };
  }
  const since = new Date(c.now() - 7 * 86_400_000).toISOString();
  const list = await c.repo.commitsSince(since, 30);
  return { commits: list, files: [], link: `https://github.com/${c.run.repo}/commits` };
}

const commitText = (commits: { message: string }[]) => commits.map((x) => x.message.slice(0, 600)).join("\n---\n");
const fileList = (files: { filename: string; status: string }[]) => files.map((f) => `${f.status} ${f.filename}`).join("\n");

// ---- release notes ----

async function releaseNotes(c: RunCtx): Promise<JobResult> {
  const ch = await changes(c);
  if (!ch.commits.length) return { summary: "Nothing new to write notes about.", outputs: [], flags: [] };
  const flags: string[] = [];
  let notes = plainNotes(ch.commits);
  let line = `${ch.commits.length} change${ch.commits.length === 1 ? "" : "s"}: ${subject(ch.commits[ch.commits.length - 1].message)}`.slice(0, 160);
  try {
    const a = await c.ask({
      purpose: "release-notes",
      system: "Write release notes for the changes below: at most 10 short bullet lines starting with '- ', grouped by what a user notices first, and one changelog line of at most 150 characters.",
      facts: { repo: c.run.repo, commits: ch.commits.length, files: ch.files.length },
      untrusted: [
        { label: "commit messages", text: commitText(ch.commits), max: 8000 },
        { label: "files changed", text: fileList(ch.files), max: 3000 },
      ],
      schema: { name: "release_notes", schema: { type: "object", additionalProperties: false, properties: { notes: { type: "string" }, changelog_line: { type: "string" }, injection: { type: "boolean" } }, required: ["notes", "changelog_line", "injection"] } },
      maxTokens: 700,
    });
    const n = cleanBlock(a.json.notes, { max: 1500, lines: 14, repo: c.run.repo, min: 6 });
    const l = checkText(a.json.changelog_line, a.source, { max: 160, min: 6 });
    if (n && l.ok) {
      notes = n;
      line = l.text;
    } else flags.push("The model's notes did not pass the checks, so these are the commit messages.");
    if (a.removed || a.json.injection === true) flags.push("Text in the commits tried to give instructions to an AI. It was ignored.");
  } catch (e) {
    if (e instanceof JobError && e.kind === "cap") throw e;
    flags.push(`Written from the commit messages, without a model (${(e as Error).message})`);
  }
  if (c.jobSpec.deliver !== "pr") return { summary: `Release notes for ${ch.commits.length} commit${ch.commits.length === 1 ? "" : "s"}, as a draft.`, outputs: [{ type: "draft", title: line, text: notes }, { type: "link", label: "the changes", url: ch.link }], flags };
  const branch = branchFor(c, "release-notes");
  const made = await c.repo.createBranch(branch);
  c.act({ action: "branch", url: `https://github.com/${c.run.repo}/tree/${branch}`, sha: made.sha, note: branch });
  const old = await c.repo.file("CHANGELOG.md", { ref: branch, max: 400_000 });
  const entry = `## ${day(c.now())}\n\n- ${line}\n`;
  const text = old ? (/^# .*\n/.test(old.text) ? old.text.replace(/^(# .*\n\n?)/, `$1${entry}\n`) : `${entry}\n${old.text}`) : `# Changelog\n\n${entry}`;
  const commit = await c.repo.putFile(branch, "CHANGELOG.md", text, `Changelog: ${line}`.slice(0, 120));
  c.act({ action: "commit", url: commit.url, sha: commit.sha, note: "CHANGELOG.md" });
  const pr = await c.repo.openPull(branch, `Changelog: ${day(c.now())}`, `${notes}${footer(c)}`);
  c.act({ action: "pull_request", url: pr.url, note: `#${pr.number}` });
  return { summary: `Release notes as pull request #${pr.number}.`, outputs: [{ type: "link", label: `Pull request #${pr.number}`, url: pr.url }, { type: "draft", title: line, text: notes }], flags };
}

// ---- the post about what shipped (shown to copy; never posted) ----

async function shipPost(c: RunCtx): Promise<JobResult> {
  const ch = await changes(c);
  if (!ch.commits.length) return { summary: "Nothing new to post about.", outputs: [], flags: [] };
  const flags: string[] = [];
  let post = `Shipped in ${c.run.repo.split("/")[1]}: ${subject(ch.commits[ch.commits.length - 1].message)}`.slice(0, 230);
  try {
    const a = await c.ask({
      purpose: "ship-post",
      system: "Write one short post (at most 230 characters, no hashtags, no links) saying plainly what shipped in these changes, for the owner to post themselves.",
      facts: { repo: c.run.repo, commits: ch.commits.length },
      untrusted: [{ label: "commit messages", text: commitText(ch.commits), max: 6000 }],
      schema: { name: "ship_post", schema: { type: "object", additionalProperties: false, properties: { post: { type: "string" }, injection: { type: "boolean" } }, required: ["post", "injection"] } },
      maxTokens: 200,
    });
    const p = checkText(a.json.post, a.source + c.run.repo, { max: 240, min: 10 });
    if (p.ok) post = p.text;
    else flags.push(`The model's post did not pass the checks (${p.why}), so this one uses the commit message.`);
    if (a.removed || a.json.injection === true) flags.push("Text in the commits tried to give instructions to an AI. It was ignored.");
  } catch (e) {
    if (e instanceof JobError && e.kind === "cap") throw e;
    flags.push("Written from the commit message, without a model.");
  }
  return { summary: "A post about what shipped, ready to copy.", outputs: [{ type: "post", text: `${post}\n${ch.link}` }], flags };
}

// ---- the key check (patterns only, no model) ----

async function secretCheck(c: RunCtx): Promise<JobResult> {
  const ch = await changes(c);
  const found = scanPatches(ch.files).slice(0, 30);
  if (!found.length) return { summary: `No keys found in this push (${ch.files.length} file${ch.files.length === 1 ? "" : "s"} read).`, outputs: [], flags: [] };
  return {
    summary: `${found.length} possible key${found.length === 1 ? "" : "s"} in this push. Rotate any that are real, then remove them from the history.`,
    outputs: [{ type: "warning", text: `A push to ${c.run.repo} (${c.run.input.ref?.replace("refs/heads/", "") ?? "a branch"}) added what looks like ${found.length === 1 ? "a key" : "keys"}. Shown masked. Treat each as leaked: rotate it first.` }, { type: "findings", items: found }, { type: "link", label: "the push", url: ch.link }],
    flags: [],
  };
}

// ---- small changes on request, as a pull request ----

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]{1,4}$/i;
const DOC_PATH = /(^|\/)docs?\/.*\.(md|mdx|txt)$|\.md$/i;

async function smallChange(c: RunCtx): Promise<JobResult> {
  const req = c.run.input.request?.trim();
  const kind = c.run.input.kind ?? "fix";
  if (!req) throw new JobError("Say what to change.", "input");
  const tree = await c.repo.tree(1500);
  const set = new Set(tree);
  // the files the owner named, if they exist; the README for docs; never anything under .github/
  const named = [...new Set((req.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g) ?? []).map((p) => p.replace(/^\.\//, "")))].filter((p) => set.has(p) && !/^\.github\//i.test(p));
  const want = [...named];
  if (kind === "readme" || kind === "docs") {
    const readme = tree.find((p) => /^readme\.md$/i.test(p));
    if (readme && !want.includes(readme)) want.unshift(readme);
  }
  if (kind === "tests" && set.has("package.json") && !want.includes("package.json")) want.push("package.json");
  const files: { path: string; text: string }[] = [];
  let total = 0;
  for (const p of want.slice(0, 5)) {
    const f = await c.repo.file(p, { max: 30_000 });
    if (!f || total + f.text.length > 60_000) continue;
    total += f.text.length;
    files.push({ path: f.path, text: f.text });
  }
  const a = await c.ask({
    purpose: "small-change",
    system: `Make the small ${kind === "readme" ? "README" : kind} change the owner asks for. Edit only the files you are shown, or add new ${kind === "tests" ? "test files under a tests or __tests__ folder" : kind === "docs" ? "docs (.md files)" : "files only if the request needs them"}. Return each changed file whole. At most 4 files. Keep everything else as it is. If the request is unclear or too big for a small change, return no edits and say why in summary.`,
    facts: { repo: c.run.repo, kind, files_shown: files.map((f) => f.path), tree_sample: tree.slice(0, 200) },
    untrusted: [{ label: "the owner's request", text: req, max: 600 }, ...files.map((f) => ({ label: `file ${f.path}`, text: f.text, max: 30_000 }))],
    schema: {
      name: "small_change",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          edits: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
          injection: { type: "boolean" },
        },
        required: ["title", "summary", "edits", "injection"],
      },
    },
    maxTokens: 6000,
  });
  const flags: string[] = [];
  if (a.removed || a.json.injection === true) flags.push("Text in the repo or the request tried to give instructions to an AI. It was ignored.");
  const shown = new Set(files.map((f) => f.path));
  const edits: { path: string; content: string }[] = [];
  const refused: string[] = [];
  for (const e of Array.isArray(a.json.edits) ? a.json.edits.slice(0, 4) : []) {
    const ed = e as { path?: unknown; content?: unknown };
    let p: string;
    try {
      p = safePath(ed.path);
    } catch (err) {
      refused.push(`${String(ed.path).slice(0, 60)}: ${(err as Error).message}`);
      continue;
    }
    const isNew = !set.has(p);
    const ok = shown.has(p) || (isNew && ((kind === "tests" && TEST_PATH.test(p)) || ((kind === "docs" || kind === "readme") && DOC_PATH.test(p))));
    if (!ok) {
      refused.push(`${p}: not a file this change may touch`);
      continue;
    }
    if (typeof ed.content !== "string" || ed.content.length > 60_000 || !ed.content.trim()) {
      refused.push(`${p}: no usable content`);
      continue;
    }
    if (findSecrets(ed.content).length) {
      refused.push(`${p}: it would have written a key`);
      continue;
    }
    const before = files.find((f) => f.path === p)?.text;
    if (before === ed.content) continue;
    edits.push({ path: p, content: ed.content.replace(/[–—]/g, "-") });
  }
  if (refused.length) flags.push(`Left out: ${refused.join("; ")}.`);
  const summary = cleanBlock(a.json.summary, { max: 600, lines: 8, repo: c.run.repo }) ?? "A small change on request.";
  if (!edits.length) return { summary: `No pull request: ${summary}`, outputs: [{ type: "draft", title: "No change made", text: summary }], flags };
  const title = cleanTitle(a.json.title) ?? `Small ${kind} change`;
  const branch = branchFor(c, kind);
  const made = await c.repo.createBranch(branch);
  c.act({ action: "branch", url: `https://github.com/${c.run.repo}/tree/${branch}`, sha: made.sha, note: branch });
  for (const e of edits) {
    const commit = await c.repo.putFile(branch, e.path, e.content, `${title}: ${e.path}`.slice(0, 120));
    c.act({ action: "commit", url: commit.url, sha: commit.sha, note: e.path });
  }
  const pr = await c.repo.openPull(branch, title, `${summary}\n\nAsked for: ${maskSecrets(req).slice(0, 400)}${footer(c)}`);
  c.act({ action: "pull_request", url: pr.url, note: `#${pr.number}` });
  return { summary: `Pull request #${pr.number}: ${title}.`, outputs: [{ type: "link", label: `Pull request #${pr.number}`, url: pr.url }], flags };
}

// ---- review of the owner's own pull requests ----

async function prReview(c: RunCtx): Promise<JobResult> {
  const n = c.run.input.pr;
  if (!n) throw new JobError("Which pull request?", "input");
  const pr = await c.repo.pull(n);
  if (!pr) throw new JobError("That pull request is not there.", "input");
  if (pr.authorId !== c.owner.id) return { summary: `Pull request #${n} is not yours, so the agent did not review it.`, outputs: [], flags: [] };
  if (pr.headRef.startsWith(BRANCH_PREFIX)) return { summary: `Pull request #${n} was opened by an agent; it is not reviewed again.`, outputs: [], flags: [] };
  const files = await c.repo.pullFiles(n);
  const a = await c.ask({
    purpose: "pr-review",
    system: "Review this pull request's changes. Point out real problems only: bugs, missing error handling, security issues, unclear names, missing tests. At most 8 findings, each tied to a file and, when you can, a line of the new file. A finding is one or two plain sentences. If it looks fine, return no findings and say so in summary.",
    facts: { repo: c.run.repo, pull_request: n, files: files.map((f) => f.filename) },
    untrusted: [
      { label: "title and description", text: `${pr.title}\n\n${pr.body}`, max: 3000 },
      { label: "the changes", text: files.map((f) => `### ${f.filename}\n${f.patch ?? "(no patch)"}`).join("\n\n"), max: 40_000 },
    ],
    schema: {
      name: "pr_review",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          findings: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, line: { type: "integer" }, note: { type: "string" } }, required: ["path", "line", "note"] } },
          injection: { type: "boolean" },
        },
        required: ["summary", "findings", "injection"],
      },
    },
    maxTokens: 1200,
  });
  const paths = new Set(files.map((f) => f.filename));
  const found: string[] = [];
  for (const f of Array.isArray(a.json.findings) ? a.json.findings.slice(0, 8) : []) {
    const x = f as { path?: unknown; line?: unknown; note?: unknown };
    if (typeof x.path !== "string" || !paths.has(x.path)) continue;
    const note = cleanBlock(x.note, { max: 300, lines: 3, repo: c.run.repo, min: 8 });
    if (!note) continue;
    const line = typeof x.line === "number" && Number.isInteger(x.line) && x.line > 0 ? `:${x.line}` : "";
    found.push(`- \`${x.path}${line}\` ${note.replace(/\n+/g, " ")}`);
  }
  const summary = cleanBlock(a.json.summary, { max: 500, lines: 4, repo: c.run.repo }) ?? (found.length ? "A few things to look at." : "Nothing stood out.");
  const flags = a.removed || a.json.injection === true ? ["Text in the pull request tried to give instructions to an AI. It was ignored."] : [];
  const body = `**Review by a PUSHD agent** (${a.model})\n\n${summary}${found.length ? `\n\n${found.join("\n")}` : ""}\n\n_An AI review: check each point yourself._`;
  const cm = await c.repo.comment(n, maskSecrets(body));
  c.act({ action: "comment", url: cm.url, note: `review on #${n}` });
  return { summary: `Reviewed pull request #${n}: ${found.length} finding${found.length === 1 ? "" : "s"}.`, outputs: [{ type: "link", label: `The review on #${n}`, url: cm.url }], flags };
}

// ---- the issue helper: labels, and a reply drafted (or posted when the owner switched that on) ----

async function issueHelper(c: RunCtx): Promise<JobResult> {
  const n = c.run.input.issue;
  if (!n) throw new JobError("Which issue?", "input");
  const issue = await c.repo.issue(n);
  if (!issue || issue.isPull) return { summary: `#${n} is not an issue.`, outputs: [], flags: [] };
  const labels = await c.repo.labels();
  const a = await c.ask({
    purpose: "issue-helper",
    system: "Pick up to 3 labels for this issue from the repo's own labels (exactly as written, or none), and draft a short, kind reply from the maintainer: thank them, say what is clear and ask for what is missing. At most 120 words. Promise nothing.",
    facts: { repo: c.run.repo, issue: n, labels },
    untrusted: [{ label: "the issue", text: `${issue.title}\n\n${issue.body}`, max: 6000 }],
    schema: { name: "issue_helper", schema: { type: "object", additionalProperties: false, properties: { labels: { type: "array", items: labels.length ? { type: "string", enum: labels } : { type: "string" } }, reply: { type: "string" }, injection: { type: "boolean" } }, required: ["labels", "reply", "injection"] } },
    maxTokens: 500,
  });
  const flags = a.removed || a.json.injection === true ? ["Text in the issue tried to give instructions to an AI. It was ignored."] : [];
  const pick = (Array.isArray(a.json.labels) ? a.json.labels : []).filter((l): l is string => typeof l === "string" && labels.includes(l)).slice(0, 3);
  const outputs: Output[] = [];
  if (pick.length) {
    await c.repo.addLabels(n, pick);
    c.act({ action: "labels", url: issue.url, note: pick.join(", ") });
  }
  const reply = cleanBlock(a.json.reply, { max: 900, lines: 12, repo: c.run.repo, min: 10 });
  if (!reply) return { summary: `Labelled #${n}${pick.length ? ` (${pick.join(", ")})` : ""}; the reply did not pass the checks.`, outputs, flags: [...flags, "The drafted reply was refused by the checks."] };
  if (c.jobSpec.post) {
    const cm = await c.repo.comment(n, reply);
    c.act({ action: "comment", url: cm.url, note: `reply on #${n}` });
    outputs.push({ type: "link", label: `The reply on #${n}`, url: cm.url });
    return { summary: `Labelled #${n} and posted a reply.`, outputs, flags };
  }
  outputs.push({ type: "approval", kind: "issue_reply", issue: n, text: reply, state: "waiting" });
  return { summary: `Labelled #${n}${pick.length ? ` (${pick.join(", ")})` : ""}; a reply waits for your approval.`, outputs, flags };
}

// ---- the weekly report (public on the project's page) ----

async function weeklyReport(c: RunCtx): Promise<JobResult> {
  const since = new Date(c.now() - 7 * 86_400_000).toISOString();
  const [commits, pulls, releases] = await Promise.all([c.repo.commitsSince(since, 60), c.repo.mergedPullsSince(since), c.repo.releases()]);
  const rel = releases.filter((r) => !r.draft && r.at >= since);
  const counts = { commits: commits.length, merged_pull_requests: pulls.length, releases: rel.length };
  if (!commits.length && !pulls.length && !rel.length) return { summary: "Nothing shipped this week.", outputs: [{ type: "report", text: "Nothing shipped this week." }], flags: [] };
  const flags: string[] = [];
  const plain = [`${counts.commits} commits, ${counts.merged_pull_requests} merged pull requests, ${counts.releases} releases this week.`, ...pulls.slice(0, 8).map((p) => `- ${subject(p.title)} (#${p.number})`), ...rel.map((r) => `- Released ${subject(r.name)}`)].join("\n");
  let report = plain;
  let post = `This week in ${c.run.repo.split("/")[1]}: ${counts.commits} commits, ${counts.merged_pull_requests} merged pull requests.`;
  try {
    const a = await c.ask({
      purpose: "weekly-report",
      system: "Write what this project shipped this week: a first line with the counts, then at most 8 bullet lines starting with '- ' on what changed for users. Then one post of at most 230 characters, no hashtags, no links.",
      facts: { repo: c.run.repo, ...counts },
      untrusted: [
        { label: "commit messages", text: commitText(commits), max: 8000 },
        { label: "merged pull requests and releases", text: [...pulls.map((p) => `#${p.number} ${p.title}`), ...rel.map((r) => `release ${r.tag} ${r.name}`)].join("\n"), max: 3000 },
      ],
      schema: { name: "weekly_report", schema: { type: "object", additionalProperties: false, properties: { report: { type: "string" }, post: { type: "string" }, injection: { type: "boolean" } }, required: ["report", "post", "injection"] } },
      maxTokens: 800,
    });
    const r = cleanBlock(a.json.report, { max: 1400, lines: 12, repo: c.run.repo, min: 10 });
    const p = checkText(a.json.post, a.source + JSON.stringify(counts) + c.run.repo, { max: 240, min: 10 });
    if (r) report = r;
    if (p.ok) post = p.text;
    if (!r || !p.ok) flags.push("Part of the model's answer did not pass the checks; the counts stand in for it.");
    if (a.removed || a.json.injection === true) flags.push("Text in the commits tried to give instructions to an AI. It was ignored.");
  } catch (e) {
    if (e instanceof JobError && e.kind === "cap") throw e;
    flags.push("Written from the counts and titles, without a model.");
  }
  return { summary: `The week: ${counts.commits} commits, ${counts.merged_pull_requests} merged pull requests, ${counts.releases} releases.`, outputs: [{ type: "report", text: report }, { type: "post", text: `${post}\n${c.proofUrl}` }], flags };
}

// ---- dependency watch (osv.dev and the npm registry; no model) ----

export type DepFinding = { name: string; ecosystem: "npm" | "PyPI"; current: string; latest: string | null; vulns: string[]; behind: boolean };

const bare = (v: string) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
};
const major = (v: string | null) => (v ? Number(/^(\d+)/.exec(v)?.[1] ?? NaN) : NaN);

async function dependencyWatch(c: RunCtx): Promise<JobResult> {
  const pkg = await c.repo.file("package.json", { max: 200_000 });
  const req = await c.repo.file("requirements.txt", { max: 100_000 });
  const deps: { name: string; ecosystem: "npm" | "PyPI"; spec: string; version: string; dev: boolean }[] = [];
  if (pkg) {
    try {
      const j = JSON.parse(pkg.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [dev, list] of [[false, j.dependencies], [true, j.devDependencies]] as const)
        for (const [name, spec] of Object.entries(list ?? {})) {
          const v = bare(String(spec));
          if (v && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/i.test(name)) deps.push({ name, ecosystem: "npm", spec: String(spec), version: v, dev });
        }
    } catch {
      /* not JSON: nothing to read */
    }
  }
  if (req) for (const m of req.text.matchAll(/^([A-Za-z0-9._-]{1,100})==([0-9][0-9A-Za-z.]*)\s*$/gm)) deps.push({ name: m[1], ecosystem: "PyPI", spec: m[2], version: m[2], dev: false });
  if (!deps.length) return { summary: "No package.json or pinned requirements.txt to read.", outputs: [], flags: [] };
  const list = deps.slice(0, 80);
  const vulns = await c.outside.vulns(list.map((d) => ({ name: d.name, version: d.version, ecosystem: d.ecosystem }))).catch(() => null);
  const found: DepFinding[] = [];
  let looked = 0;
  for (const [i, d] of list.entries()) {
    let latest: string | null = null;
    if (d.ecosystem === "npm" && looked < 40) {
      looked++;
      latest = await c.outside.npmLatest(d.name).catch(() => null);
    }
    const behind = latest != null && major(latest) - major(d.version) >= 2;
    const v = vulns?.[i] ?? [];
    if (v.length || behind) found.push({ name: d.name, ecosystem: d.ecosystem, current: d.version, latest, vulns: v.slice(0, 5), behind });
  }
  const flags = vulns ? [] : ["osv.dev did not answer, so known vulnerabilities were not checked this time."];
  if (!found.length) return { summary: `${list.length} dependencies read; none flagged.`, outputs: [], flags };
  const outputs: Output[] = [{ type: "deps", items: found }];
  const bump = found.filter((f) => f.ecosystem === "npm" && f.latest);
  if (c.jobSpec.bumpPr && pkg && bump.length) {
    const j = JSON.parse(pkg.text) as Record<string, unknown>;
    for (const f of bump)
      for (const k of ["dependencies", "devDependencies"]) {
        const sec = j[k] as Record<string, string> | undefined;
        if (sec && sec[f.name] != null) sec[f.name] = `^${f.latest}`;
      }
    const branch = branchFor(c, "deps");
    const made = await c.repo.createBranch(branch);
    c.act({ action: "branch", url: `https://github.com/${c.run.repo}/tree/${branch}`, sha: made.sha, note: branch });
    const commit = await c.repo.putFile(branch, "package.json", `${JSON.stringify(j, null, 2)}\n`, `Bump ${bump.length} dependenc${bump.length === 1 ? "y" : "ies"}`);
    c.act({ action: "commit", url: commit.url, sha: commit.sha, note: "package.json" });
    const body = bump.map((f) => `- ${f.name} ${f.current} to ${f.latest}${f.vulns.length ? ` (${f.vulns.join(", ")})` : ""}`).join("\n");
    const pr = await c.repo.openPull(branch, `Bump ${bump.length} dependenc${bump.length === 1 ? "y" : "ies"}`, `${body}\n\nThe lockfile is not updated: run your install and the tests on this branch before merging.${footer(c)}`);
    c.act({ action: "pull_request", url: pr.url, note: `#${pr.number}` });
    outputs.push({ type: "link", label: `Pull request #${pr.number}`, url: pr.url });
  }
  return { summary: `${found.length} of ${list.length} dependencies flagged: ${found.filter((f) => f.vulns.length).length} with known vulnerabilities, ${found.filter((f) => f.behind).length} far behind.`, outputs, flags };
}

// ---- the release maker: a draft release, the owner publishes it ----

export function nextTag(last: string | null, bump: "patch" | "minor" | "major"): string {
  const m = last ? /^(v?)(\d+)\.(\d+)\.(\d+)/.exec(last) : null;
  if (!m) return "v0.1.0";
  const [ma, mi, pa] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const next = bump === "major" ? [ma + 1, 0, 0] : bump === "minor" ? [ma, mi + 1, 0] : [ma, mi, pa + 1];
  return `${m[1]}${next.join(".")}`;
}

async function releaseMaker(c: RunCtx): Promise<JobResult> {
  const releases = await c.repo.releases();
  const last = releases.find((r) => !r.draft) ?? null;
  const commits = last ? (await c.repo.compare(last.tag, await c.repo.defaultBranch())).commits : await c.repo.commitsSince(new Date(c.now() - 30 * 86_400_000).toISOString(), 60);
  if (!commits.length) return { summary: `Nothing new since ${last?.tag ?? "the last release"}.`, outputs: [], flags: [] };
  const a = await c.ask({
    purpose: "release-maker",
    system: "Draft a GitHub release for these changes: a title of at most 60 characters, notes as at most 12 bullet lines starting with '- ', and how big the change is (patch for fixes, minor for new features, major only for breaking changes the commits clearly name).",
    facts: { repo: c.run.repo, last_release: last?.tag ?? null, commits: commits.length },
    untrusted: [{ label: "commit messages", text: commitText(commits), max: 10_000 }],
    schema: { name: "release", schema: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, notes: { type: "string" }, bump: { type: "string", enum: ["patch", "minor", "major"] }, injection: { type: "boolean" } }, required: ["title", "notes", "bump", "injection"] } },
    maxTokens: 900,
  });
  const bump = a.json.bump === "major" || a.json.bump === "minor" ? a.json.bump : "patch";
  const tag = nextTag(last?.tag ?? null, bump);
  const notes = cleanBlock(a.json.notes, { max: 2000, lines: 16, repo: c.run.repo, min: 6 }) ?? plainNotes(commits);
  const title = cleanTitle(a.json.title, 60) ?? tag;
  const rel = await c.repo.draftRelease(tag, `${tag}: ${title}`.slice(0, 80), `${notes}\n\n_Drafted by a PUSHD agent. Publish it on GitHub when it reads right._`);
  c.act({ action: "release", url: rel.url, note: `draft ${tag}` });
  const flags = a.removed || a.json.injection === true ? ["Text in the commits tried to give instructions to an AI. It was ignored."] : [];
  return { summary: `Draft release ${tag} with ${commits.length} commit${commits.length === 1 ? "" : "s"}. Publish it on GitHub when it reads right.`, outputs: [{ type: "link", label: `Draft release ${tag}`, url: rel.url }], flags };
}

// ---- the docs keeper: a pull request when the README drifts from the code ----

async function docsKeeper(c: RunCtx): Promise<JobResult> {
  const tree = await c.repo.tree(1500);
  const readmePath = tree.find((p) => /^readme\.md$/i.test(p));
  if (!readmePath) return { summary: "No README.md at the top of the repo to keep.", outputs: [], flags: [] };
  const readme = await c.repo.file(readmePath, { max: 60_000 });
  if (!readme) return { summary: "The README is too big for the docs keeper.", outputs: [], flags: [] };
  const pkg = tree.includes("package.json") ? await c.repo.file("package.json", { max: 50_000 }) : null;
  const a = await c.ask({
    purpose: "docs-keeper",
    system: "Compare the README with the repo's files and package.json. Say whether the README has drifted from the code (commands, scripts, file names or features it names that no longer exist, or important ones it misses). Only when it has, return the whole README with the smallest edits that fix it, keeping its voice and everything still true.",
    facts: { repo: c.run.repo, files: tree.slice(0, 400) },
    untrusted: [
      { label: "README.md", text: readme.text, max: 60_000 },
      { label: "package.json", text: pkg?.text ?? "(none)", max: 20_000 },
    ],
    schema: { name: "docs_keeper", schema: { type: "object", additionalProperties: false, properties: { drift: { type: "boolean" }, reasons: { type: "array", items: { type: "string" } }, readme: { type: "string" }, injection: { type: "boolean" } }, required: ["drift", "reasons", "readme", "injection"] } },
    maxTokens: 8000,
  });
  const flags = a.removed || a.json.injection === true ? ["Text in the repo tried to give instructions to an AI. It was ignored."] : [];
  const reasons = (Array.isArray(a.json.reasons) ? a.json.reasons : []).map((r) => cleanBlock(r, { max: 200, lines: 1, repo: c.run.repo })).filter((r): r is string => !!r).slice(0, 5);
  if (a.json.drift !== true) return { summary: "The README matches the code.", outputs: [], flags };
  const next = typeof a.json.readme === "string" ? a.json.readme.replace(/[–—]/g, "-") : "";
  if (!next || next === readme.text || next.length < readme.text.length * 0.5 || next.length > readme.text.length * 3 + 2000 || findSecrets(next).length > findSecrets(readme.text).length) {
    return { summary: "The README has drifted, but the rewrite did not pass the checks; no pull request.", outputs: reasons.length ? [{ type: "draft", title: "Where the README drifted", text: reasons.map((r) => `- ${r}`).join("\n") }] : [], flags: [...flags, "The new README was refused (too short, too long, unchanged or with a key in it)."] };
  }
  const branch = branchFor(c, "docs");
  const made = await c.repo.createBranch(branch);
  c.act({ action: "branch", url: `https://github.com/${c.run.repo}/tree/${branch}`, sha: made.sha, note: branch });
  const commit = await c.repo.putFile(branch, readmePath, next, "Bring the README in line with the code");
  c.act({ action: "commit", url: commit.url, sha: commit.sha, note: readmePath });
  const pr = await c.repo.openPull(branch, "Bring the README in line with the code", `${reasons.map((r) => `- ${r}`).join("\n") || "The README named things the code no longer has."}${footer(c)}`);
  c.act({ action: "pull_request", url: pr.url, note: `#${pr.number}` });
  return { summary: `The README drifted; pull request #${pr.number}.`, outputs: [{ type: "link", label: `Pull request #${pr.number}`, url: pr.url }], flags };
}

export const RUNNERS: Record<JobId, (c: RunCtx) => Promise<JobResult>> = {
  release_notes: releaseNotes,
  ship_post: shipPost,
  secret_check: secretCheck,
  small_change: smallChange,
  pr_review: prReview,
  issue_helper: issueHelper,
  weekly_report: weeklyReport,
  dependency_watch: dependencyWatch,
  release_maker: releaseMaker,
  docs_keeper: docsKeeper,
};

/** The real outside sources, at fixed addresses: osv.dev's batch query and the npm registry. 10 seconds each. */
export function realOutside(fetchImpl: typeof fetch = fetch): Outside {
  return {
    async vulns(q) {
      const res = await fetchImpl("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: q.map((x) => ({ package: { name: x.name, ecosystem: x.ecosystem }, version: x.version })) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`osv ${res.status}`);
      const j = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
      return q.map((_, i) => (j.results?.[i]?.vulns ?? []).map((v) => String(v.id).slice(0, 40)));
    },
    async npmLatest(name) {
      const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json()) as { version?: string };
      return typeof j.version === "string" && /^\d+\.\d+\.\d+/.test(j.version) ? j.version : null;
    },
  };
}
