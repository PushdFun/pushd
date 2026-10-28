// The watcher end to end against a fake GitHub: dedup by event id, one line per new repo, no flood on the first
// look, old repos never shown as new, and the catches log written once and never edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, queryCatches, queryItems } from "../src/db.ts";
import { GitHub, type GhEvent, type GhRepo } from "../src/github.ts";
import { MediaQueue, mediaId } from "../src/media.ts";
import { Watcher } from "../src/watcher.ts";
import { fakeFetch, toly } from "./helpers.ts";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function ghRepo(id: number, name: string, created: string, p: Partial<GhRepo> = {}): GhRepo {
  return {
    id,
    name,
    full_name: `aeyakovenko/${name}`,
    owner: { login: "aeyakovenko" },
    description: null,
    topics: [],
    created_at: created,
    pushed_at: created,
    stargazers_count: 1,
    size: 10,
    fork: false,
    archived: false,
    default_branch: "main",
    language: null,
    html_url: `https://github.com/aeyakovenko/${name}`,
    ...p,
  };
}
const ev = (id: string, type: string, repo: string, at: string, payload: GhEvent["payload"] = {}, actor = "aeyakovenko"): GhEvent => ({
  id,
  type,
  actor: { login: actor },
  repo: { id: 1, name: `aeyakovenko/${repo}` },
  created_at: at,
  payload,
});

const DTS = ghRepo(1435189676, "dts02-6502-signer", "2026-10-27T03:14:27Z", { description: "DTS-02: 65C02 Ed25519 breadboard signer spec with pin-level simulation", pushed_at: "2026-10-27T17:45:33Z" });
const PERC = ghRepo(2, "percolator", "2025-10-19T18:16:33Z", { default_branch: "master", pushed_at: "2026-10-27T17:36:10Z" });
const META = ghRepo(3, "percolator-meta", "2026-03-05T13:43:40Z");
const BUNKER = ghRepo(4, "bunker_coin", "2024-04-01T15:24:19Z", { description: "bunker coin", pushed_at: "2025-06-23T18:05:24Z" });

function world() {
  const state = {
    events: [
      ev("25327810283", "PushEvent", "dts02-6502-signer", "2026-10-27T03:36:11Z", { ref: "refs/heads/main", head: "abc" }),
      ev("25322143454", "CreateEvent", "dts02-6502-signer", "2026-10-27T03:14:33Z", { ref: "main", ref_type: "branch", master_branch: "main" }),
      ev("24640507115", "CreateEvent", "percolator", "2026-10-19T16:08:18Z", { ref: "fix/x", ref_type: "branch", master_branch: "master" }),
      ev("24550692951", "PushEvent", "percolator", "2026-10-19T03:06:50Z", { ref: "refs/heads/fix/x", head: "def" }),
      ev("24028786654", "PushEvent", "percolator", "2026-10-13T13:25:02Z", { ref: "refs/heads/master", head: "fed" }),
      ev("17656173495", "IssueCommentEvent", "percolator", "2026-10-19T17:09:35Z"),
    ] as GhEvent[],
    repos: [DTS, META, PERC, BUNKER] as GhRepo[],
  };
  const { fetch, calls } = fakeFetch({
    [`${API}/users/aeyakovenko/events/public`]: () => state.events,
    [`${API}/users/aeyakovenko/repos`]: () => state.repos,
    [`${API}/users/aeyakovenko/gists`]: [],
    [`${API}/repos/aeyakovenko/dts02-6502-signer/contents`]: [{ name: "README.md", type: "file" }, { name: "sim", type: "dir" }],
    [`${API}/repos/aeyakovenko/gm-coin/contents`]: [{ name: "README.md", type: "file" }],
    [`${API}/repos/aeyakovenko/old-notes/contents`]: [],
    [`${RAW}/aeyakovenko/dts02-6502-signer/HEAD/README.md`]: "# DTS-02\n\nA breadboard signer for the 65C02.\n",
    [`${RAW}/aeyakovenko/gm-coin/HEAD/README.md`]: "# gm-coin\n\nA coin that says gm, just for fun.\n",
  });
  return { state, fetch, calls };
}

function setup(nowIso: string) {
  const db = openDb(":memory:");
  const w = world();
  let now = Date.parse(nowIso);
  const gh = new GitHub({ db, fetchImpl: w.fetch, sleep: async () => {} });
  const watcher = new Watcher({ db, gh, accounts: [toly], backfillHours: 48, now: () => now });
  return { db, watcher, ...w, at: (iso: string) => (now = Date.parse(iso)) };
}

test("first look: the new repo is one line (backfill), the old ones are not news, nothing floods", async () => {
  const { db, watcher } = setup("2026-10-27T18:00:00Z");
  const r = await watcher.poll(toly);
  const items = queryItems(db);
  assert.deepEqual(items.map((i) => i.repo), ["dts02-6502-signer"]);
  const it = items[0];
  assert.equal(it.kind, "repo");
  assert.equal(it.githubAt, "2026-10-27T03:14:27Z", "githubAt is when GitHub created the repo");
  assert.equal(it.seenAt, "2026-10-27T18:00:00.000Z", "seenAt is when the watcher saw it");
  assert.equal(it.backfill, true);
  assert.ok(it.heat === "high" || it.heat === "veryHigh", it.heat);
  assert.match(it.summary, /65C02 Ed25519/);
  // bunker_coin (2024) never shows as new, nor do the other old repos
  assert.ok(!items.some((i) => /bunker|percolator/.test(i.repo)));
  // the branch-shaped CreateEvent and the repo list told about the same repo: one line
  const verdicts = r.outcomes.map((o) => `${o.key} ${o.verdict}`);
  assert.ok(verdicts.some((v) => v.startsWith("25322143454 already a line")), verdicts.join("\n"));
  assert.ok(verdicts.some((v) => v.startsWith("25327810283 part of a new repo")), verdicts.join("\n"));
});

test("dedup: a second look at the same events adds nothing, and costs no extra lines", async () => {
  const { db, watcher, at } = setup("2026-10-27T18:00:00Z");
  await watcher.poll(toly);
  const n = db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
  at("2026-10-27T18:05:00Z");
  const again = await watcher.poll(toly);
  assert.equal(again.outcomes.length, 0);
  assert.equal(queryItems(db).length, 1);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM events").get(), n);
});

test("later looks: a new repo is a fresh line (not backfill), an old repo turning up is 'made public'", async () => {
  const { db, watcher, state, at } = setup("2026-10-27T18:00:00Z");
  await watcher.poll(toly);
  at("2026-10-27T19:00:00Z");
  const GM = ghRepo(10, "gm-coin", "2026-10-27T18:58:00Z", { description: null });
  const OLD = ghRepo(11, "old-notes", "2023-02-01T00:00:00Z", { description: "Notes from 2023" });
  state.repos = [GM, DTS, META, PERC, BUNKER, OLD];
  state.events = [ev("999", "CreateEvent", "gm-coin", "2026-10-27T18:58:02Z", { ref_type: "repository" }), ...state.events];
  await watcher.poll(toly);
  const gm = queryItems(db).find((i) => i.repo === "gm-coin")!;
  assert.ok(gm, "gm-coin is a line");
  assert.equal(gm.backfill, false);
  assert.equal(gm.githubAt, "2026-10-27T18:58:00Z");
  assert.ok(gm.signals.some((s) => s.label === 'word "gm" in the name' || s.label === 'word "coin" in the name'));
  assert.ok(["high", "veryHigh"].includes(gm.heat));
  assert.equal(gm.summary, "A coin that says gm, just for fun.");
  const old = queryItems(db).find((i) => i.repo === "old-notes")!;
  assert.ok(old.signals.some((s) => s.label === "repo made public"));
  assert.equal(queryItems(db).filter((i) => i.repo === "gm-coin").length, 1, "CreateEvent and the repo list: one line");
});

test("the catches log: hot lines only, written once, never edited", async () => {
  const { db, watcher } = setup("2026-10-27T18:00:00Z");
  await watcher.poll(toly);
  const c = queryCatches(db);
  assert.equal(c.length, 1);
  assert.equal(c[0].repo, "dts02-6502-signer");
  assert.ok(c[0].githubAt && c[0].seenAt && c[0].shownAt);
  assert.throws(() => db.prepare("UPDATE catches SET heat = 'low'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM catches").run(), /append-only/);
});

test("bots and side branches never become lines", async () => {
  const { db, watcher, state, at } = setup("2026-10-27T18:00:00Z");
  await watcher.poll(toly);
  at("2026-10-27T20:00:00Z");
  state.events = [
    ev("1001", "PushEvent", "percolator", "2026-10-27T19:59:00Z", { ref: "refs/heads/dependabot/cargo/x", head: "1" }, "dependabot[bot]"),
    ev("1002", "PushEvent", "percolator", "2026-10-27T19:58:00Z", { ref: "refs/heads/fix/y", head: "2" }),
    ...state.events,
  ];
  const r = await watcher.poll(toly);
  assert.equal(queryItems(db).length, 1);
  assert.deepEqual(r.outcomes.map((o) => o.verdict.split(" ")[0]).sort(), ["dropped:", "dropped:"]);
});

test("a push to an old repo: kept only when the head before it shows a quiet spell", async () => {
  const { db, watcher, state, at } = setup("2026-10-27T18:00:00Z");
  const OLD = ghRepo(11, "old-notes", "2023-02-01T00:00:00Z", { description: "Notes from 2023" });
  const BUSY = ghRepo(12, "busy-tool", "2023-02-01T00:00:00Z", { description: "A busy tool" });
  state.repos = [DTS, META, PERC, BUNKER, OLD, BUSY];
  await watcher.poll(toly);
  at("2026-10-27T19:00:00Z");
  state.events = [
    ev("2001", "PushEvent", "old-notes", "2026-10-27T18:30:00Z", { ref: "refs/heads/main", head: "h1", before: "quiet" }),
    ev("2002", "PushEvent", "busy-tool", "2026-10-27T18:31:00Z", { ref: "refs/heads/main", head: "h2", before: "unknown" }),
    ...state.events,
  ];
  // only old-notes' earlier head can be read: committed in May
  const gh = (watcher as unknown as { o: { gh: { o: { fetchImpl: typeof fetch } } } }).o.gh.o;
  const inner = gh.fetchImpl;
  gh.fetchImpl = (async (u: string | URL | Request, init?: RequestInit) =>
    String(u).endsWith("/commits/quiet") ? new Response(JSON.stringify({ commit: { committer: { date: "2026-05-01T00:00:00Z" } } }), { status: 200 }) : inner(u, init)) as typeof fetch;
  const r = await watcher.poll(toly);
  const v = Object.fromEntries(r.outcomes.map((o) => [o.key, o.verdict]));
  assert.match(v["2001"], /^kept: low/);
  assert.match(v["2002"], /routine push/);
  assert.ok(queryItems(db).some((i) => i.repo === "old-notes" && i.kind === "push"));
});

test("a new line about a repo queues that repo's preview picture, once", async () => {
  const db = openDb(":memory:");
  const w = world();
  const media = new MediaQueue({ db, dir: "/nonexistent", fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch });
  const gh = new GitHub({ db, fetchImpl: w.fetch, sleep: async () => {} });
  const watcher = new Watcher({ db, gh, accounts: [toly], backfillHours: 48, now: () => Date.parse("2026-10-27T18:00:00Z"), media });
  await watcher.poll(toly);
  await watcher.poll(toly);
  const rows = db.prepare("SELECT id, full_name, status FROM media").all();
  assert.deepEqual(rows, [{ id: mediaId("aeyakovenko/dts02-6502-signer"), full_name: "aeyakovenko/dts02-6502-signer", status: "queued" }]);
  // the queue never fetches from GitHub's API: no opengraph address went through the API client
  assert.ok(!w.calls.some((u) => u.includes("opengraph")));
});

test("one push line per repo a day: more pushes to the same repo the same day add no lines (the minidregg flood)", async () => {
  const { db, watcher, state, at } = setup("2026-10-27T18:00:00Z");
  const OLD = ghRepo(11, "old-notes", "2023-02-01T00:00:00Z", { description: "Notes from 2023" });
  state.repos = [DTS, META, PERC, BUNKER, OLD];
  await watcher.poll(toly);
  at("2026-10-27T21:00:00Z");
  state.events = [
    ev("3003", "PushEvent", "old-notes", "2026-10-27T20:30:00Z", { ref: "refs/heads/main", head: "h3", before: "h2" }),
    ev("3002", "PushEvent", "old-notes", "2026-10-27T19:30:00Z", { ref: "refs/heads/main", head: "h2", before: "h1" }),
    ev("3001", "PushEvent", "old-notes", "2026-10-27T18:30:00Z", { ref: "refs/heads/main", head: "h1", before: "quiet" }),
    ...state.events,
  ];
  const gh = (watcher as unknown as { o: { gh: { o: { fetchImpl: typeof fetch } } } }).o.gh.o;
  const inner = gh.fetchImpl;
  gh.fetchImpl = (async (u: string | URL | Request, init?: RequestInit) =>
    String(u).endsWith("/commits/quiet") ? new Response(JSON.stringify({ commit: { committer: { date: "2026-05-01T00:00:00Z" } } }), { status: 200 }) : inner(u, init)) as typeof fetch;
  await watcher.poll(toly);
  assert.equal(queryItems(db).filter((i) => i.repo === "old-notes" && i.kind === "push").length, 1);
});
