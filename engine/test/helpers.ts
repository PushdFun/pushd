// Small builders for the tests: a watched account, a candidate, a repo, and a fake GitHub that answers from a map.
import type { Candidate, Context, RepoInfo, WatchEntry } from "../src/types.ts";

export const toly: WatchEntry = { handle: "aeyakovenko", name: "Anatoly Yakovenko", org: "Solana", group: "chain", type: "user", followers: 1800, source: "test" };
export const someOrg: WatchEntry = { handle: "solana-labs", name: "Solana Labs", org: "Solana", group: "chain", type: "org", followers: 5967, source: "test" };

export function repo(p: Partial<RepoInfo> = {}): RepoInfo {
  return {
    name: "thing",
    fullName: "aeyakovenko/thing",
    description: null,
    topics: [],
    createdAt: "2026-10-27T03:14:27Z",
    pushedAt: null,
    stars: 0,
    size: 10,
    fork: false,
    archived: false,
    defaultBranch: "main",
    language: null,
    readme: null,
    files: null,
    ...p,
  };
}

export function cand(p: Partial<Candidate> = {}): Candidate {
  return {
    key: "1",
    handle: "aeyakovenko",
    sub: "new-repo",
    repo: "thing",
    fullName: "aeyakovenko/thing",
    githubAt: "2026-10-27T03:14:27Z",
    actor: "aeyakovenko",
    url: "https://github.com/aeyakovenko/thing",
    ...p,
  };
}

export function ctx(p: Partial<Context> = {}): Context {
  return { entry: toly, repo: null, prevActivityAt: null, prevRepoCreatedAt: null, ...p };
}

/** A fetch that answers from a map of URL -> JSON (or a function). Unknown URLs are 404s. Counts calls. */
export function fakeFetch(routes: Record<string, unknown>, opts: { remaining?: number } = {}) {
  const calls: string[] = [];
  let remaining = opts.remaining ?? 4000;
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const headers = {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(--remaining),
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-used": "1",
      etag: `"e-${url.length}"`,
    };
    const hit = Object.entries(routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([k]) => url === k || url.startsWith(k));
    if (!hit) return new Response("not found", { status: 404, headers });
    const body = typeof hit[1] === "function" ? (hit[1] as () => unknown)() : hit[1];
    if (typeof body === "string") return new Response(body, { status: 200, headers });
    return new Response(JSON.stringify(body), { status: 200, headers: { ...headers, "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
