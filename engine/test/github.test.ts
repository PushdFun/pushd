// The GitHub client: conditional requests and the rate limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { GitHub } from "../src/github.ts";

const hdr = (remaining: number, extra: Record<string, string> = {}) => ({
  "x-ratelimit-limit": "60",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
  "x-ratelimit-used": String(60 - remaining),
  ...extra,
});

test("an unchanged list is a 304 sent with the ETag, answered from the cache", async () => {
  const seen: (string | undefined)[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string>)["if-none-match"];
    seen.push(inm);
    if (inm === '"v1"') return new Response(null, { status: 304, headers: hdr(58) });
    return new Response(JSON.stringify([{ id: "1" }]), { status: 200, headers: hdr(59, { etag: '"v1"' }) });
  }) as typeof fetch;
  const gh = new GitHub({ db: openDb(":memory:"), fetchImpl: f });
  const a = await gh.get<{ id: string }[]>("/users/x/events/public");
  const b = await gh.get<{ id: string }[]>("/users/x/events/public");
  assert.deepEqual(seen, [undefined, '"v1"']);
  assert.equal(a.status, 200);
  assert.equal(b.status, 304);
  assert.equal(b.fromCache, true);
  assert.deepEqual(b.data, [{ id: "1" }]);
  assert.equal(gh.notModified, 1);
  assert.equal(gh.rate?.remaining, 58);
});

test("no token: no authorization header; with one: a bearer token", async () => {
  const auth: (string | undefined)[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => (auth.push((init?.headers as Record<string, string>).authorization), new Response("[]", { headers: hdr(50) }))) as typeof fetch;
  await new GitHub({ db: openDb(":memory:"), fetchImpl: f }).get("/a");
  await new GitHub({ db: openDb(":memory:"), fetchImpl: f, token: "t0k" }).get("/a");
  assert.deepEqual(auth, [undefined, "Bearer t0k"]);
});

test("rate limit: runs low, it waits for the reset; a 403 with retry-after, it backs off and retries", async () => {
  const waits: number[] = [];
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 2) return new Response("{}", { status: 403, headers: hdr(0, { "retry-after": "30" }) });
    return new Response("[]", { headers: hdr(n === 1 ? 2 : 40) });
  }) as typeof fetch;
  const gh = new GitHub({ db: openDb(":memory:"), fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
  await gh.get("/a"); // leaves 2, under the reserve of 3
  const r = await gh.get("/b"); // waits for the reset, gets a 403, waits 30 s, retries
  assert.equal(r.status, 200);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] > 500_000, `waited ${waits[0]} ms for the reset`);
  assert.equal(waits[1], 30_000);
  // spacing spreads what is left over the time to the reset
  assert.ok(gh.spacingMs(5_000) >= 5_000);
});
