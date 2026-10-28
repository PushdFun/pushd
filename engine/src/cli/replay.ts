// The replay: `npm run replay -- <handle> [--days 30] [--pages 1]`.
// Reads the account's recent public events, its repo list and its gists once, runs them through the same filter,
// heat and summary as the watcher, and prints what PUSHD would have shown and when it happened on GitHub.
// It keeps its own store in memory (the live feed is never touched) and caches GitHub's answers in
// data/replay-cache.sqlite, so a second run costs (almost) nothing against the rate limit.
import { join } from "node:path";
import { ROOT, config, loadWatchlist } from "../config.ts";
import { openDb } from "../db.ts";
import { GitHub, type GhEvent, type GhGist, type GhRepo } from "../github.ts";
import { HOT_WORDS } from "../heat.ts";
import { fromEvents, fromGists, fromRepos, Pipeline, type Outcome } from "../pipeline.ts";
import { arg } from "./common.ts";

const handle = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
if (!handle) {
  console.error("usage: npm run replay -- <handle> [--days 30] [--pages 1]");
  process.exit(2);
}
const entry = loadWatchlist().accounts.find((a) => a.handle.toLowerCase() === handle.toLowerCase());
if (!entry) {
  console.error(`${handle} is not on the watchlist (data/watchlist.json)`);
  process.exit(2);
}

const days = Number(arg("days") || 30);
const cacheDb = openDb(join(ROOT, "data", "replay-cache.sqlite"));
const gh = new GitHub({ db: cacheDb, token: config.githubToken, log: (m) => console.error(m) });
const pages = Number(arg("pages") || (gh.authenticated ? 3 : 1));
const db = openDb(":memory:");
const now = Date.now();
const windowStart = new Date(now - days * 86_400_000).toISOString();
const pipeline = new Pipeline({ db, gh, openRouterKey: config.openRouterKey, openRouterModel: config.openRouterModel, readCommits: gh.authenticated });

const h = entry.handle;
const events: GhEvent[] = [];
for (let page = 1; page <= pages; page++) {
  const path = entry.type === "org" ? `/orgs/${h}/events?per_page=100&page=${page}` : `/users/${h}/events/public?per_page=100&page=${page}`;
  const r = await gh.get<GhEvent[]>(path);
  if (!Array.isArray(r.data) || r.data.length === 0) break;
  events.push(...r.data);
  if (r.data.length < 100) break;
}
const repos = (await gh.get<GhRepo[]>(`/users/${h}/repos?sort=created&direction=desc&per_page=30&type=owner`)).data ?? [];
const gists = entry.type === "user" ? ((await gh.get<GhGist[]>(`/users/${h}/gists?per_page=10`)).data ?? []) : [];

const inWindow = events.filter((e) => e.created_at >= windowStart);
const { candidates, activity } = fromEvents(entry, inWindow);
const newRepos = fromRepos(entry, repos, () => false, windowStart, new Date(now).toISOString()).filter((c) => c.sub === "new-repo");
const newGists = fromGists(entry, gists, () => false).filter((c) => c.githubAt >= windowStart);
pipeline.rememberRepos(h, repos);
pipeline.recordActivity(activity);

const oldestEvent = events.reduce((m, e) => (e.created_at < m ? e.created_at : m), new Date(now).toISOString());
const historySince = events.length ? oldestEvent : new Date(now - 90 * 86_400_000).toISOString();
const all = [...candidates, ...newRepos, ...newGists].sort((a, b) => a.githubAt.localeCompare(b.githubAt));
const outcomes: Outcome[] = [];
for (const c of all) {
  outcomes.push(await pipeline.run(entry, c, { historySince, skipBefore: windowStart, eventType: c.key.startsWith("repo:") ? "RepoList" : undefined }));
}

// ---- the report ----
const utc = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");
const kept = outcomes.filter((o) => o.item).map((o) => o.item!);
console.log(`\nPUSHD replay: ${entry.handle} (${entry.name}, ${entry.org}), last ${days} days`);
console.log(`read: ${events.length} public events (${inWindow.length} in the window), ${repos.length} repos, ${gists.length} gists; ${gh.requests} request(s) to the GitHub API, ${gh.notModified} unchanged`);
console.log(`\nwhat PUSHD would have shown, newest first:\n`);
if (kept.length === 0) console.log("  nothing: every event in the window was routine or noise");
for (const it of [...kept].sort((a, b) => b.githubAt.localeCompare(a.githubAt))) {
  console.log(`  ${utc(it.githubAt)}  ${it.kind.padEnd(7)} ${it.handle}/${it.repo}${it.version ? " " + it.version : ""}`);
  console.log(`    heat ${it.heat} (${it.score}/10): ${it.signals.map((s) => `${s.label} +${s.points}`).join(", ")}`);
  console.log(`    "${it.summary}"  (${it.summarySource === "ai" ? "model" : "from the repo's own words"})`);
  console.log(`    ${it.url}`);
}
const catches = kept.filter((it) => it.heat === "high" || it.heat === "veryHigh");
console.log(`\ncatches (high and up): ${catches.length ? catches.map((c) => `${c.repo} (${c.heat}, githubAt ${utc(c.githubAt)})`).join("; ") : "none"}`);

const old = repos.filter((r) => r.created_at < windowStart && !r.fork);
if (old.length) {
  console.log(`\nolder repos in the list, not new (created before the window): ${old.length}, newest ${old.slice(0, 4).map((r) => `${r.name} (${r.created_at.slice(0, 10)})`).join(", ")}`);
  // the ones a reader could mistake for news: a hot word in an old repo's name is still an old repo
  const hot = old.filter((r) => HOT_WORDS.some((w) => r.name.toLowerCase().split(/[^a-z0-9]+/).includes(w)));
  for (const r of hot) console.log(`  not new: ${r.name}, created ${utc(r.created_at)}, last pushed ${r.pushed_at ? utc(r.pushed_at) : "never"}`);
}

const reasons = new Map<string, number>();
for (const o of outcomes.filter((x) => !x.item)) {
  const r = o.verdict.replace(/ [^ ]+\/[^ ]+$/, "").replace(/^(dropped: (routine push to|side branch|tool branch|contribution to)).*$/, "$1 ...");
  reasons.set(r, (reasons.get(r) ?? 0) + 1);
}
console.log(`\nnot shown (${outcomes.length - kept.length} candidates; ${activity.length} other events count only as activity):`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

const n = loadWatchlist().accounts.length;
const withToken = Math.max(60, Math.round((n * 1.3 * 3600) / 4950));
const without = Math.round((n * 1.3 * 3600) / 57 / 60);
console.log(
  `\nwhen: the watcher reads each account about every ${Math.round(withToken / 60 * 10) / 10} min with a token (${n} accounts), about every ${Math.round(without / 6) / 10} h without one,` +
    `\nplus however long GitHub takes to list the event (seconds to minutes). So a line shows within one poll interval of GitHub listing it; never instant.\n`,
);
cacheDb.close();
db.close();
