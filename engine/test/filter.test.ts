import { test } from "node:test";
import assert from "node:assert/strict";
import { filter, isNoiseCommit, isRoutineRepo, parseVersion } from "../src/filter.ts";
import { cand, ctx, repo, someOrg } from "./helpers.ts";

const drop = (v: ReturnType<typeof filter>) => (v.keep ? null : v.reason);

test("bots are dropped, whatever they did", () => {
  for (const actor of ["dependabot[bot]", "renovate[bot]", "github-actions[bot]", "agave-dependabot-helper[bot]", "some-ci-bot"])
    assert.match(drop(filter(cand({ actor, sub: "push", ref: "refs/heads/main" }), ctx())) ?? "", /bot/, actor);
  assert.equal(filter(cand({ actor: "aeyakovenko" }), ctx()).keep, true);
});

test("housekeeping commits are noise; real work is not", () => {
  for (const m of [
    "chore(deps): bump serde from 1.0.1 to 1.0.2",
    "Bump actions/checkout from 3 to 4",
    "build(deps): update dependency typescript",
    "ci: fix workflow",
    "fix typo in README",
    "Fix typos",
    "cargo fmt",
    "Run prettier",
    "Merge pull request #12 from x/y",
    "Merge branch 'main' into dev",
    "update lockfile",
    "v1.2.3",
    "",
  ])
    assert.equal(isNoiseCommit(m), true, m);
  for (const m of ["Add a 6502 signer", "gm", "launch the coin page", "Implement ed25519 on 65C02", "first commit"]) assert.equal(isNoiseCommit(m), false, m);
});

test("pushes: tool branches, side branches, housekeeping-only pushes and routine repos are dropped", () => {
  const live = repo({ createdAt: "2025-10-19T18:16:33Z" });
  assert.match(drop(filter(cand({ sub: "push", ref: "refs/heads/dependabot/cargo/serde-1.0" }), ctx())) ?? "", /tool branch/);
  assert.match(drop(filter(cand({ sub: "push", ref: "refs/heads/gh-pages" }), ctx())) ?? "", /tool branch/);
  assert.match(drop(filter(cand({ sub: "push", ref: "refs/heads/fix/x", defaultBranch: false }), ctx())) ?? "", /side branch/);
  assert.match(
    drop(filter(cand({ sub: "push", ref: "refs/heads/main", defaultBranch: true, commits: ["chore(deps): bump x", "fix typo"] }), ctx())) ?? "",
    /housekeeping/,
  );
  // a long-lived repo pushed to last week: routine
  const at = "2026-10-27T17:00:00Z";
  assert.match(drop(filter(cand({ sub: "push", githubAt: at, defaultBranch: true }), ctx({ repo: { ...live, pushedAt: "2026-10-20T00:00:00Z" } }))) ?? "", /routine/);
  // the same repo after 4 months of quiet: kept
  assert.equal(filter(cand({ sub: "push", githubAt: at, defaultBranch: true }), ctx({ repo: { ...live, pushedAt: "2026-06-01T00:00:00Z" } })).keep, true);
  // a young repo is never routine
  assert.equal(isRoutineRepo(ctx({ repo: repo({ createdAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-26T00:00:00Z" }) }), at), false);
});

test("an org's pushes are routine unless they break a long silence", () => {
  const c = cand({ sub: "push", handle: "solana-labs", actor: "someone", fullName: "solana-labs/x", githubAt: "2026-10-27T00:00:00Z" });
  assert.match(drop(filter(c, ctx({ entry: someOrg, prevActivityAt: "2026-10-26T00:00:00Z" }))) ?? "", /org/);
  assert.equal(filter(c, ctx({ entry: someOrg, prevActivityAt: "2026-07-01T00:00:00Z" })).keep, true);
});

test("forks are not news", () => {
  assert.match(drop(filter(cand(), ctx({ repo: repo({ fork: true }) }))) ?? "", /fork/);
});

test("releases: pre-releases and patch releases are dropped, minor and major kept", () => {
  assert.match(drop(filter(cand({ sub: "release", tag: "v2.0.0-rc.1" }), ctx())) ?? "", /pre-release/);
  assert.match(drop(filter(cand({ sub: "release", tag: "nightly-2026-10-27" }), ctx())) ?? "", /pre-release/);
  assert.match(drop(filter(cand({ sub: "release", tag: "v1.4.2", prerelease: false }), ctx())) ?? "", /patch/);
  assert.match(drop(filter(cand({ sub: "release", tag: "v3.0.0", prerelease: true }), ctx())) ?? "", /pre-release/);
  assert.equal(filter(cand({ sub: "release", tag: "v2.0.0" }), ctx()).keep, true);
  assert.equal(filter(cand({ sub: "release", tag: "v1.5.0" }), ctx()).keep, true);
  assert.deepEqual(parseVersion("v2.0"), [2, 0, 0]);
  assert.deepEqual(parseVersion("release-1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("latest"), null);
});

test("new repos, repos made public and gists pass the filter", () => {
  for (const sub of ["new-repo", "made-public", "gist"] as const) assert.equal(filter(cand({ sub }), ctx()).keep, true, sub);
});
