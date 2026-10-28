// The preview picture queue: one fetch per repo, a pause after a 429 that doubles, the hourly cap, retries and
// giving up, the files on disk, and the API serving them with long cache headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { insertItem, openDb, toFeedItem, type StoredItem } from "../src/db.ts";
import { MediaQueue, OG_HOST, mediaId, mediaUrlFor, repoOfItem } from "../src/media.ts";
import { toly } from "./helpers.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const MIN = 60_000;

/** A clock the test moves by hand, and a fetch that answers from a list of replies (the last one repeats). */
function rig(replies: (() => Response)[], o: { perHour?: number; maxAttempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pushd-media-"));
  const db = openDb(":memory:");
  let t = Date.parse("2026-10-28T10:00:00Z");
  const urls: string[] = [];
  const fetchImpl = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return replies[Math.min(urls.length - 1, replies.length - 1)]();
  }) as typeof fetch;
  const q = new MediaQueue({ db, dir, fetchImpl, now: () => t, perHour: o.perHour ?? 30, maxAttempts: o.maxAttempts, backoffMs: 10 * MIN });
  return { db, dir, q, urls, tick: (ms: number) => (t += ms), now: () => t, done: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}
const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
const tooMany = (retryAfter?: number) => () => new Response("slow down", { status: 429, headers: retryAfter ? { "retry-after": String(retryAfter) } : {} });

function item(p: Partial<StoredItem> & { id: string }): StoredItem {
  return {
    key: `k:${p.id}`,
    handle: "aeyakovenko",
    group: "chain",
    kind: "repo",
    repo: p.id,
    summary: "A thing.",
    summarySource: "fallback",
    heat: "low",
    score: 2,
    signals: [],
    githubAt: "2026-10-01T09:00:00Z",
    seenAt: "2026-10-01T09:00:30Z",
    shownAt: "2026-10-01T09:00:30Z",
    url: `https://github.com/aeyakovenko/${p.id}`,
    backfill: false,
    ...p,
  };
}

test("repoOfItem: repos, pushes and releases have one; gists and lines without a GitHub link do not", () => {
  assert.equal(repoOfItem({ kind: "repo", url: "https://github.com/aeyakovenko/dts02-6502-signer" }), "aeyakovenko/dts02-6502-signer");
  assert.equal(repoOfItem({ kind: "push", url: "https://github.com/simonw/llm/commit/abc123" }), "simonw/llm");
  assert.equal(repoOfItem({ kind: "release", url: "https://github.com/karpathy/nanochat/releases/tag/v2.0.0" }), "karpathy/nanochat");
  assert.equal(repoOfItem({ kind: "gist", url: "https://gist.github.com/x/abc" }), null);
  assert.equal(repoOfItem({ kind: "repo", url: null }), null);
  assert.equal(repoOfItem({ kind: "repo", url: "https://example.com/a/b" }), null);
  assert.match(mediaId("Aeyakovenko/DTS"), /^[a-f0-9]{24}$/);
  assert.equal(mediaId("Aeyakovenko/DTS"), mediaId("aeyakovenko/dts"));
});

test("dedup: a repo is queued and fetched once, however many lines and spellings point at it", async () => {
  const r = rig([png]);
  const a = r.q.enqueue("aeyakovenko/dts02-6502-signer");
  const b = r.q.enqueue("AEYAKOVENKO/dts02-6502-signer");
  r.q.enqueueItem({ kind: "push", url: "https://github.com/aeyakovenko/dts02-6502-signer/commit/abc" });
  r.q.enqueueItem({ kind: "release", url: "https://github.com/aeyakovenko/dts02-6502-signer/releases/tag/v1" });
  assert.equal(r.q.enqueueItem({ kind: "gist", url: "https://gist.github.com/aeyakovenko/1" }), null);
  assert.equal(a, b);
  assert.equal((r.db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n, 1);

  assert.equal(await r.q.step(), "fetched");
  assert.equal(await r.q.step(), "idle");
  r.tick(24 * 60 * MIN);
  assert.equal(await r.q.step(), "idle", "a stored picture is never fetched again");
  assert.deepEqual(r.urls, [`${OG_HOST}/pushd/aeyakovenko/dts02-6502-signer`]);

  // lines already in the store are queued on start, once; a repo already queued is skipped
  insertItem(r.db, item({ id: "dts02-6502-signer" }));
  insertItem(r.db, item({ id: "percolator" }));
  insertItem(r.db, item({ id: "gisty", kind: "gist", url: "https://gist.github.com/aeyakovenko/1" }));
  assert.equal(r.q.enqueueExisting(), 1);
  assert.equal(r.q.enqueueExisting(), 0);
  r.done();
});

test("a stored picture is a file on disk, and a line's mediaUrl points at it", async () => {
  const r = rig([png]);
  const it = item({ id: "dts02-6502-signer" });
  insertItem(r.db, it);
  assert.equal(mediaUrlFor(r.db, it), null, "nothing until it is fetched");
  const id = r.q.enqueueItem(it)!;
  assert.equal(await r.q.step(), "fetched");
  assert.deepEqual(readFileSync(join(r.dir, `${id}.png`)), PNG);
  assert.equal(mediaUrlFor(r.db, it), `/v1/media/${id}`);
  assert.equal(toFeedItem(it, undefined, mediaUrlFor(r.db, it)).mediaUrl, `/v1/media/${id}`);
  assert.equal(toFeedItem(it, undefined).mediaUrl, null);
  r.done();
});

test("429: everything pauses, the pause doubles with each 429 in a row, and the repo is fetched once it clears", async () => {
  const r = rig([tooMany(), tooMany(), png]);
  r.q.enqueue("a/one");
  r.q.enqueue("b/two");

  assert.equal(await r.q.step(), "rate-limited");
  assert.equal(r.q.pausedUntil - r.now(), 10 * MIN);
  assert.equal(await r.q.step(), "paused", "no fetch while paused");
  r.tick(9 * MIN);
  assert.equal(await r.q.step(), "paused");
  assert.equal(r.urls.length, 1);

  r.tick(MIN);
  assert.equal(await r.q.step(), "rate-limited");
  assert.equal(r.q.pausedUntil - r.now(), 20 * MIN, "the second 429 in a row waits twice as long");
  r.tick(20 * MIN);
  assert.equal(await r.q.step(), "fetched");
  // a 429 never counts against the picture: it was fetched, not given up on
  const one = r.db.prepare("SELECT status, attempts FROM media WHERE full_name = 'a/one'").get() as { status: string; attempts: number };
  assert.deepEqual(one, { status: "done", attempts: 0 });
  // a success resets the pause: the next 429 starts at 10 minutes again
  r.done();

  const s = rig([tooMany(120)]);
  s.q.enqueue("a/one");
  assert.equal(await s.q.step(), "rate-limited");
  assert.equal(s.q.pausedUntil - s.now(), 120_000, "Retry-After wins when GitHub sends it");
  s.done();
});

test("the hourly cap: no more than perHour fetches in any hour, 429s included", async () => {
  const r = rig([png], { perHour: 2 });
  for (const n of ["a/1", "a/2", "a/3"]) r.q.enqueue(n);
  assert.equal(await r.q.step(), "fetched");
  r.tick(MIN);
  assert.equal(await r.q.step(), "fetched");
  r.tick(MIN);
  assert.equal(await r.q.step(), "capped");
  r.tick(57 * MIN);
  assert.equal(await r.q.step(), "capped", "the first fetch is still inside the hour");
  r.tick(MIN + 1);
  assert.equal(await r.q.step(), "fetched");
  assert.equal(r.urls.length, 3);
  r.done();
});

test("404 is missing (never retried); errors retry later and give up after maxAttempts; not-a-picture is refused", async () => {
  const r = rig([() => new Response("no", { status: 404 })]);
  r.q.enqueue("gone/repo");
  assert.equal(await r.q.step(), "missing");
  r.tick(24 * 60 * MIN);
  assert.equal(await r.q.step(), "idle");
  assert.equal(r.urls.length, 1);
  r.done();

  const e = rig([() => new Response("oops", { status: 502 })], { maxAttempts: 3 });
  e.q.enqueue("flaky/repo");
  assert.equal(await e.q.step(), "retry");
  assert.equal(await e.q.step(), "idle", "waits before the retry");
  e.tick(10 * MIN);
  assert.equal(await e.q.step(), "retry");
  e.tick(20 * MIN);
  assert.equal(await e.q.step(), "failed");
  e.tick(24 * 60 * MIN);
  assert.equal(await e.q.step(), "idle");
  assert.equal(e.urls.length, 3);
  e.done();

  const h = rig([() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), () => new Response(Buffer.from("not a png"), { status: 200, headers: { "content-type": "image/png" } })], { maxAttempts: 2 });
  h.q.enqueue("odd/repo");
  assert.equal(await h.q.step(), "retry");
  h.tick(60 * MIN);
  assert.equal(await h.q.step(), "failed");
  assert.equal(existsSync(join(h.dir, `${mediaId("odd/repo")}.png`)), false);
  h.done();
});

test("/v1/media/:id: the bytes with a year's cache; 304 on a matching ETag; 404 for unknown or odd ids", async () => {
  const r = rig([png]);
  const it = item({ id: "dts02-6502-signer", heat: "high" });
  insertItem(r.db, it);
  const id = r.q.enqueueItem(it)!;
  await r.q.step();
  insertItem(r.db, item({ id: "no-picture", url: "https://github.com/aeyakovenko/no-picture" }));

  const server = createApi({ db: r.db, accounts: [toly], publicDelayMinutes: 0, liveKey: null, mediaDir: r.dir });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/media/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    const again = await fetch(`${base}/v1/media/${id}`, { headers: { "if-none-match": res.headers.get("etag")! } });
    assert.equal(again.status, 304);
    for (const bad of ["0".repeat(24), "../../etc/passwd", "abc", `${id}.png`]) assert.equal((await fetch(`${base}/v1/media/${encodeURIComponent(bad)}`)).status, 404, bad);

    const feed = (await (await fetch(`${base}/v1/feed`)).json()) as { items: { id: string; mediaUrl: string | null }[] };
    assert.equal(feed.items.find((i) => i.id === "dts02-6502-signer")!.mediaUrl, `/v1/media/${id}`);
    assert.equal(feed.items.find((i) => i.id === "no-picture")!.mediaUrl, null);
    // the catches log carries it too
    const catches = (await (await fetch(`${base}/v1/catches`)).json()) as { items: { mediaUrl: string | null }[] };
    assert.equal(catches.items[0].mediaUrl, `/v1/media/${id}`);
  } finally {
    server.close();
    r.done();
  }
  // without a media folder the API has no pictures and no line points at one
  const r2 = rig([png]);
  const it2 = item({ id: "x" });
  insertItem(r2.db, it2);
  r2.q.enqueueItem(it2);
  await r2.q.step();
  const bare = createApi({ db: r2.db, accounts: [toly], publicDelayMinutes: 0, liveKey: null });
  await new Promise<void>((ok) => bare.listen(0, "127.0.0.1", ok));
  const b2 = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${b2}/v1/media/${mediaId("aeyakovenko/x")}`)).status, 404);
    const f = (await (await fetch(`${b2}/v1/feed`)).json()) as { items: { mediaUrl: string | null }[] };
    assert.equal(f.items[0].mediaUrl, null);
  } finally {
    bare.close();
    r2.done();
  }
});
