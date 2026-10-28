// PUSHD for AI agents through the API: the REST tools and the OpenAPI document, MCP over Streamable HTTP
// (initialize, tools/list, tools/call, notifications, errors, the origin check), the paid tools' 402 and the whole
// paid flow against a pretend chain, closed before launch, rate limits, API keys and the public counters.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/api.ts";
import { Payments, payMessage, type ChainTx, type PaymentChain } from "../src/agent/payments.ts";
import { insertItem, openDb, type DB } from "../src/db.ts";
import { Scouts } from "../src/scouts/scouts.ts";
import type { WatchEntry } from "../src/types.ts";
import { someOrg, toly } from "./helpers.ts";
import { line, scoutConfig } from "./scout-helpers.ts";
import { POT } from "./token-helpers.ts";

const accounts: WatchEntry[] = [toly, someOrg, { handle: "karpathy", name: "Andrej Karpathy", org: "nanoGPT", group: "ai", type: "user", followers: 228000, source: "t" }];
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

class MockChain implements PaymentChain {
  txs = new Map<string, ChainTx>();
  async tx(h: string) {
    return this.txs.get(h) ?? null;
  }
}

type World = { db: DB; server: Server; base: string; chain: MockChain };

async function start(o: { payTo: string | null; env?: Record<string, string> }): Promise<World> {
  const db = openDb(":memory:");
  const now = Date.now();
  insertItem(db, line(now, { id: "dts02-6502-signer", score: 7, heat: "high", summary: "A signer for the 6502." }));
  insertItem(db, line(now, { id: "nanochat-v2", handle: "karpathy", group: "ai", kind: "release", repo: "nanochat", version: "v2", url: "https://github.com/karpathy/nanochat/releases/tag/v2" }));
  insertItem(db, line(now, { id: "fresh", githubAt: new Date(now - 60_000).toISOString(), shownAt: new Date(now - 30_000).toISOString() }));
  const config = scoutConfig({ PUSHD_AGENT_FREE_PER_MIN: "40", ...o.env }, null);
  const scouts = new Scouts({ db, accounts, config, provider: null, gh: null });
  scouts.follow();
  const chain = new MockChain();
  const payments = new Payments({ db, chain, payTo: o.payTo, switchOn: true, maxAgeMs: config.agent.payMaxAgeMs });
  const server = createApi({ db, accounts, publicDelayMinutes: 5, liveKey: null, scouts, agent: { payments, config: config.agent, siteUrl: "https://pushd.fun" } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { db, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chain };
}
const stop = (w: World) => (w.server.closeAllConnections(), w.server.close());

const rpc = (w: World, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${w.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("before launch (no burn pot)", () => {
  let w: World;
  before(async () => (w = await start({ payTo: null })));
  after(() => stop(w));

  test("REST: free tools answer behind the public delay, with the scout's call; paid tools say they open at launch", async () => {
    const feed = (await (await fetch(`${w.base}/v1/agent/feed?limit=5`)).json()) as { items: { id: string; call?: { scout: string; source: string } }[]; delayMinutes: number; note: string };
    assert.deepEqual(feed.items.map((i) => i.id).sort(), ["dts02-6502-signer", "nanochat-v2"], "the fresh line is still inside the delay");
    assert.equal(feed.delayMinutes, 5);
    assert.equal(feed.items.find((i) => i.id === "nanochat-v2")!.call!.scout, "gemini");
    assert.equal(feed.items[0].call!.source, "template");
    assert.match(feed.note, /^Information, not advice/);
    const item = (await (await fetch(`${w.base}/v1/agent/item?id=dts02-6502-signer`)).json()) as { item: { call: { heatReason: string } } };
    assert.match(item.item.call.heatReason, /^The watcher's score, 7\/10/);
    assert.equal((await fetch(`${w.base}/v1/agent/item?id=fresh`)).status, 404);
    assert.equal((await fetch(`${w.base}/v1/agent/item?id=../../x`)).status, 400);
    assert.equal((await fetch(`${w.base}/v1/agent/search?q=signer`)).status, 200);
    assert.equal(((await (await fetch(`${w.base}/v1/agent/builder?handle=karpathy`)).json()) as { builder: { camp: string } }).builder.camp, "ai");
    assert.equal((await fetch(`${w.base}/v1/agent/builder?handle=sama`)).status, 404);
    const scouts = (await (await fetch(`${w.base}/v1/agent/scouts`)).json()) as { scouts: unknown[]; mode: string };
    assert.equal(scouts.scouts.length, 5);
    assert.equal(scouts.mode, "template");
    assert.equal(((await (await fetch(`${w.base}/v1/agent/scouts?scout=gemini`)).json()) as { record: { id: string } }).record.id, "gemini");
    const live = await fetch(`${w.base}/v1/agent/live`);
    assert.equal(live.status, 409);
    assert.deepEqual(await live.json(), { error: "Paid tools open at launch.", opensAtLaunch: true });
    assert.equal((await fetch(`${w.base}/v1/agent/deep-read?repo=a/b`)).status, 409);
    assert.equal((await fetch(`${w.base}/v1/agent/nothing`)).status, 404);
    assert.equal((await fetch(`${w.base}/v1/agent/feed?limit=500`)).status, 400);
  });

  test("the OpenAPI document and the pricing", async () => {
    const doc = (await (await fetch(`${w.base}/v1/agent/openapi.json`)).json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, { get?: { operationId: string; responses: Record<string, unknown> } }> };
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.servers[0].url, "https://pushd.fun/api/agent");
    for (const p of ["/feed", "/search", "/builder", "/item", "/scouts", "/live", "/deep-read"]) assert.ok(doc.paths[p]?.get, p);
    assert.ok("402" in doc.paths["/live"].get!.responses);
    assert.ok(!("402" in doc.paths["/feed"].get!.responses));
    const pr = (await (await fetch(`${w.base}/v1/agent/pricing`)).json()) as { open: boolean; chainId: number; tools: { priceEth: string }[]; note: string };
    assert.equal(pr.open, false);
    assert.equal(pr.chainId, 4663);
    assert.deepEqual(pr.tools.map((t) => t.priceEth), ["0.00002", "0.0003"]);
    assert.equal(pr.note, "Paid tools open at launch.");
  });

  test("MCP: initialize, tools/list, a free call, a paid one before launch, notifications and errors", async () => {
    const init = (await (await rpc(w, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object } } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "pushd");
    assert.ok(init.result.capabilities.tools);
    const old = (await (await rpc(w, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json()) as { result: { protocolVersion: string } };
    assert.equal(old.result.protocolVersion, "2025-06-18", "an unknown version gets the newest one");
    const note = await rpc(w, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const list = (await (await rpc(w, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    assert.deepEqual(list.result.tools.map((t) => t.name), ["pushd_latest", "pushd_search", "pushd_builder", "pushd_item", "pushd_scouts", "pushd_live", "pushd_deep_read"]);
    assert.ok(list.result.tools.every((t) => t.inputSchema.type === "object"));
    const call = (await (await rpc(w, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pushd_latest", arguments: { limit: 1 } } })).json()) as { result: { isError: boolean; structuredContent: { items: unknown[] }; content: { type: string; text: string }[] } };
    assert.equal(call.result.isError, false);
    assert.equal(call.result.structuredContent.items.length, 1);
    assert.equal(call.result.content[0].type, "text");
    const paid = (await (await rpc(w, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pushd_live", arguments: {} } })).json()) as { result: { isError: boolean; structuredContent: { error: string } } };
    assert.equal(paid.result.isError, true);
    assert.equal(paid.result.structuredContent.error, "Paid tools open at launch.");
    const bad = (await (await rpc(w, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pushd_item", arguments: { id: "nope" } } })).json()) as { result: { isError: boolean } };
    assert.equal(bad.result.isError, true);
    assert.equal(((await (await rpc(w, { jsonrpc: "2.0", id: 6, method: "nope" })).json()) as { error: { code: number } }).error.code, -32601);
    assert.equal(((await (await rpc(w, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rm_rf" } })).json()) as { error: { code: number } }).error.code, -32602);
    const batch = (await (await rpc(w, [{ jsonrpc: "2.0", id: 8, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }])).json()) as unknown[];
    assert.deepEqual(batch, [{ jsonrpc: "2.0", id: 8, result: {} }]);
    assert.equal((await fetch(`${w.base}/mcp`)).status, 405, "no server-sent stream on GET");
    assert.equal((await rpc(w, { jsonrpc: "2.0", id: 9, method: "ping" }, { origin: "https://evil.example" })).status, 403, "a browser page on another site is refused");
    assert.equal((await rpc(w, { jsonrpc: "2.0", id: 9, method: "ping" }, { origin: "https://pushd.fun" })).status, 200);
    const parse = await fetch(`${w.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    assert.equal(parse.status, 400);
  });

  test("keys raise the limit; a made-up key is refused; the limit answers 429 with Retry-After", async () => {
    const k = (await (await fetch(`${w.base}/v1/agent/keys`, { method: "POST", body: JSON.stringify({ label: "my agent" }) })).json()) as { key: string };
    assert.match(k.key, /^pushd_[A-Za-z0-9_-]{30,}$/);
    assert.equal((await fetch(`${w.base}/v1/agent/feed`, { headers: { "x-pushd-key": k.key } })).status, 200);
    assert.equal((await fetch(`${w.base}/v1/agent/feed`, { headers: { "x-pushd-key": "pushd_" + "x".repeat(32) } })).status, 401);
    await fetch(`${w.base}/v1/agent/keys`, { method: "POST" });
    await fetch(`${w.base}/v1/agent/keys`, { method: "POST" });
    assert.equal((await fetch(`${w.base}/v1/agent/keys`, { method: "POST" })).status, 429, "three keys a day per address");
    let last: Response | null = null;
    for (let i = 0; i < 45; i++) last = await fetch(`${w.base}/v1/agent/scouts`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(last!.status, 429);
    assert.ok(Number(last!.headers.get("retry-after")) >= 1);
    assert.equal((await fetch(`${w.base}/v1/agent/scouts`, { headers: { "x-forwarded-for": "203.0.113.10" } })).status, 200, "another client is not held up");
    assert.equal((await fetch(`${w.base}/v1/agent/scouts`, { headers: { "x-pushd-key": k.key, "x-forwarded-for": "203.0.113.9" } })).status, 200, "with a key: its own, higher limit");
  });
});

describe("after launch (burn pot set): the paid flow", () => {
  let w: World;
  before(async () => (w = await start({ payTo: POT })));
  after(() => stop(w));

  test("402 with the price; pay, sign, retry: served, counted, the hash spent; the counters show the ETH to the burn", async () => {
    const r402 = await fetch(`${w.base}/v1/agent/live?limit=10`);
    assert.equal(r402.status, 402);
    assert.equal(r402.headers.get("x-pushd-payment-required"), "pushd-burn/1");
    const body = (await r402.json()) as { payTo: string; chainId: number; priceWei: string; priceEth: string };
    assert.equal(body.payTo, POT);
    assert.equal(body.chainId, 4663);
    assert.equal(body.priceEth, "0.00002");

    const me = privateKeyToAccount(generatePrivateKey());
    const tx = hash(77);
    w.chain.txs.set(tx, { hash: tx, from: me.address, to: POT, value: BigInt(body.priceWei), chainId: 4663, blockNumber: 5, status: "success", timestamp: Date.now() - 30_000 });
    const sig = await me.signMessage({ message: payMessage(tx) });
    const ok = await fetch(`${w.base}/v1/agent/live?limit=10`, { headers: { "x-pushd-payment-tx": tx, "x-pushd-payment-signature": sig } });
    assert.equal(ok.status, 200);
    const out = (await ok.json()) as { items: { id: string }[]; delayMinutes: number; payment: { tx: string; wallet: string; valueEth: string } };
    assert.ok(out.items.some((i) => i.id === "fresh"), "live: no delay");
    assert.equal(out.delayMinutes, 0);
    assert.deepEqual(out.payment, { tx, wallet: me.address.toLowerCase(), valueEth: "0.00002" });
    const again = await fetch(`${w.base}/v1/agent/live`, { headers: { "x-pushd-payment-tx": tx, "x-pushd-payment-signature": sig } });
    assert.equal(again.status, 409);

    // the same through MCP, with a new payment
    const tx2 = hash(78);
    w.chain.txs.set(tx2, { hash: tx2, from: me.address, to: POT, value: 50_000_000_000_000n, chainId: 4663, blockNumber: 6, status: "success", timestamp: Date.now() - 30_000 });
    const noPay = (await (await rpc(w, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pushd_live", arguments: {} } })).json()) as { result: { isError: boolean; structuredContent: { status: number; payTo: string }; content: { text: string }[] } };
    assert.equal(noPay.result.isError, true);
    assert.equal(noPay.result.structuredContent.status, 402);
    assert.equal(noPay.result.structuredContent.payTo, POT);
    assert.match(noPay.result.content[0].text, /^Payment required: send 0.00002 ETH to 0x/);
    const paid = (await (await rpc(w, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pushd_live", arguments: { limit: 2, payment: { tx: tx2, signature: await me.signMessage({ message: payMessage(tx2) }) } } } })).json()) as { result: { isError: boolean; structuredContent: { items: unknown[]; payment: { valueEth: string } } } };
    assert.equal(paid.result.isError, false);
    assert.equal(paid.result.structuredContent.items.length, 2);
    assert.equal(paid.result.structuredContent.payment.valueEth, "0.00005");

    // a wrong signer through MCP: refused, nothing served
    const tx3 = hash(79);
    w.chain.txs.set(tx3, { hash: tx3, from: me.address, to: POT, value: 50_000_000_000_000n, chainId: 4663, blockNumber: 7, status: "success", timestamp: Date.now() });
    const thief = privateKeyToAccount(generatePrivateKey());
    const stolen = (await (await rpc(w, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pushd_live", arguments: { payment: { tx: tx3, signature: await thief.signMessage({ message: payMessage(tx3) }) } } } })).json()) as { result: { isError: boolean; structuredContent: { code: string } } };
    assert.equal(stolen.result.isError, true);
    assert.equal(stolen.result.structuredContent.code, "wrong_signer");

    // the deep read: closed with no model here, said before any payment is asked for
    const deep = await fetch(`${w.base}/v1/agent/deep-read?repo=aeyakovenko/dts02-6502-signer`);
    assert.equal(deep.status, 503);

    const stats = (await (await fetch(`${w.base}/v1/agent/stats`)).json()) as { calls: number; paidCalls: number; mcpCalls: number; burn: { payments: number; eth: string; wallets: number }; paid: { open: boolean } };
    assert.equal(stats.paidCalls, 2);
    assert.equal(stats.burn.payments, 2);
    assert.equal(stats.burn.eth, "0.00007");
    assert.equal(stats.burn.wallets, 1);
    assert.equal(stats.paid.open, true);
    assert.ok(stats.mcpCalls >= 1);
  });
});
