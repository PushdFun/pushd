// Smoke test for the built site: run `npm run build` first. It starts `next start` on a free port with no engine set
// (so the sample data shows), reads the real HTML of every page, and holds it to the rules.
//   node --test test/smoke.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const PAGES = {
  "/": /Know the moment builders\s*push/,
  "/feed": /The feed\./,
  "/catches": /Catches\./,
  "/watchlist": /^(\d+ projects|The list)\.$/,
  "/gh": /Look up anyone\./,
  "/admin/suggestions": /Admin\./,
  "/how": /How it works\./,
  "/holders": /Holders see it live\./,
  "/token": /\$PUSHD/,
  "/own-risk": /Own risk, terms\s*and privacy\./,
  "/pulse": /Pulse\./,
  "/replay": /Replay\./,
  "/brief": /.+/,
  "/compare": /Compare\./,
  "/builders/toly": /toly/,
  "/scouts": /The scouts\./,
  "/scouts/claude": /Claude\./,
  "/scouts/deepseek": /DeepSeek\./,
  "/my-scout": /Your own scout\./,
  "/agents": /PUSHD for agents\./,
};
// the header nav; home is the logo
// the header's links (the Top list's page, /watchlist, is reached from the home page and the palette, not the header)
const NAV = ["/feed", "/scouts", "/pulse", "/replay", "/brief", "/catches", "/how", "/agents", "/holders", "/token"];
const SAMPLE_IDS = ["frog-oracle", "gm-cli", "launch-txt", "dts02-6502-signer", "agent-kit-lite", "tiny-wallet", "zk-receipts"];
const SAMPLE_REPOS = ["frog-oracle", "gm-cli", "launch.txt", "dts02-6502-signer", "agent-kit-lite", "tiny-wallet", "zk-receipts"];
// the owner's rules (28 Oct): never call $PUSHD a memecoin, no risk line in the footer, and no public page names the tax
// rate, the chain or how the fees are shared
const NEVER = [/memecoin/i, /Robinhood Chain/, /\b3\s?%/, /\btax(es)?\b/i, /fee split|share of the fees|owner.s share/i];
const DASHES = /[\u2013\u2014]|&[mn]dash;|&#821[12];|&#x201[34];/i;
const FORBIDDEN = [/\binstant/i, /guarantee/i, /\bprofit/i, /telegram/i];

let server, BASE;
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const text = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
// the main heading's words as read: tags dropped, a line break read as a space
const h1 = (html) => {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? decode(m[1].replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : null;
};
const get = async (path) => {
  const r = await fetch(BASE + path, { redirect: "manual" });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
};
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** `next start` on a free port with these settings; resolves once it answers. */
async function startSite(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, PUSHD_ENGINE_URL: "", PUSHD_AGENTS: "", ...env },
  });
  proc.stdout.resume();
  proc.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  // wait until it answers, not a fixed time
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(base + "/robots.txt");
      break;
    } catch {
      if (Date.now() > until) throw new Error("the site did not start");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { proc, base };
}
const stopSite = (proc) => {
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
};

before(async () => {
  assert.ok(existsSync(ROOT + ".next/BUILD_ID"), "run `npm run build` first");
  const s = await startSite({});
  server = s.proc;
  BASE = s.base;
});

after(() => stopSite(server));

test("every page answers 200 with its main heading, the nav, the buy placeholder, and none of the owner's never-words", async () => {
  for (const [path, heading] of Object.entries(PAGES)) {
    const { status, html } = await get(path);
    assert.equal(status, 200, path);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, `${path} has one main heading`);
    assert.match(h1(html), heading, `${path} heading`);
    for (const to of ["/", ...NAV]) assert.match(html, new RegExp(`<a[^>]*href="${to.replace("/", "\\/")}"`), `${path} links to ${to}`);
    assert.match(html, /aria-label="PUSHD on GitHub"/, `${path} GitHub icon`);
    assert.match(html, /aria-label="PUSHD on X"/, `${path} X icon`);
    assert.match(text(html), /Buy \$PUSHD launching soon/i, `${path} buy placeholder`);
    // the camps are named by what they hold ("Robinhood Chain projects", "Solana and pump.fun"): a camp's name is a label, not copy about the token
    const copy = text(html).replace(/Robinhood Chain( projects)?|robinhood\//g, "");
    for (const re of NEVER) assert.doesNotMatch(copy, re, `${path} says ${re}`);
    // the footer: the legal links, no risk or memecoin line
    const footer = html.slice(html.indexOf('<footer class="ftr"'));
    assert.match(footer, /href="\/own-risk#own-risk"/, `${path} footer own risk link`);
    assert.doesNotMatch(text(footer), /memecoin|financial advice|at your own risk/i, `${path} footer has no risk line`);
  }
});

test("the current page is marked in the nav", async () => {
  for (const path of NAV) {
    const { html } = await get(path);
    assert.match(html, new RegExp(`href="${path}" aria-current="page"|aria-current="page" href="${path}"`), path);
  }
  const item = await get("/feed/dts02-6502-signer");
  assert.match(item.html, /href="\/feed" aria-current="page"|aria-current="page" href="\/feed"/, "an item page marks Feed");
});

test("no em or en dashes anywhere in the HTML, and no forbidden words", async () => {
  const paths = [...Object.keys(PAGES), "/feed?view=gallery", ...SAMPLE_IDS.map((id) => `/feed/${id}`), "/feed/x", "/builders/kaiwren", "/compare?b=toly,kaiwren", "/offline"];
  for (const path of paths) {
    const { html } = await get(path);
    assert.doesNotMatch(html, DASHES, `${path} has a long dash`);
    const t = text(html);
    for (const re of FORBIDDEN) assert.doesNotMatch(t, re, `${path} says ${re}`);
    for (const re of FORBIDDEN) assert.doesNotMatch(html, re, `${path} markup says ${re}`);
  }
});

test("the feed shows every sample line, marked Sample", async () => {
  const { html } = await get("/feed");
  const t = text(html);
  for (const repo of SAMPLE_REPOS) assert.ok(t.includes(repo), `feed shows ${repo}`);
  for (const id of SAMPLE_IDS) assert.match(html, new RegExp(`id="${id}"`), `feed has line ${id}`);
  assert.match(t, /Sample data/);
  assert.equal((t.match(/· Sample\b/g) ?? []).length, SAMPLE_IDS.length, "each line says Sample");
  assert.match(t, /showing 7 of 7 sample lines/);
  // home and catches mark their sample lines too
  assert.match(text((await get("/")).html), /Sample/);
  assert.match(text((await get("/catches")).html), /Sample data/);
});

test("the gallery: /feed?view=gallery draws a card per line, each opening its page, with no broken picture", async () => {
  const { status, html } = await get("/feed?view=gallery");
  assert.equal(status, 200);
  assert.match(h1(html), /The feed\./);
  assert.match(text(html), /ls --gallery/);
  const cards = [...html.matchAll(/<article class="gcard" id="([^"]+)">([\s\S]*?)<\/article>/g)];
  assert.deepEqual(cards.map((c) => c[1]).sort(), [...SAMPLE_IDS].sort(), "one card per sample line");
  for (const [, id, card] of cards) {
    assert.match(card, new RegExp(`<a class="gcard-in" href="/feed/${id}"`), `${id} links to its page`);
    assert.match(card, /class="gart[ "]/, `${id} has a picture`);
    assert.match(card, /class="gheat (low|medium|high|vhigh)"/, `${id} has its heat`);
    assert.match(text(card), /\. Sample/, `${id} is marked Sample`);
  }
  // the pictures each kind gets: the release its version, the gist its line, the command line tool a terminal, the rest drawn
  const card = (id) => cards.find((c) => c[1] === id)[2];
  assert.match(text(card("tiny-wallet")), /v2\.0 release/);
  assert.match(card("launch-txt"), /<pre class="gterm big">soon<\/pre>/);
  assert.match(card("gm-cli"), /<pre class="gterm">\$ gm-cli\ngm\n\$ _<\/pre>/);
  assert.match(card("dts02-6502-signer"), /class="fo-owner">aeyakovenko\/</);
  assert.match(card("frog-oracle"), /class="fo-owner">kaiwren\/</);
  // the sample has no stored pictures: every card is drawn, and any <img> on the page must load
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const img of imgs) {
    const src = img.match(/\ssrc="([^"]*)"/)?.[1];
    assert.ok(src, `an img without a src: ${img}`);
    if (src.startsWith("data:")) continue;
    const r = await fetch(new URL(src.replace(/&amp;/g, "&"), BASE));
    assert.equal(r.status, 200, `${src} loads`);
    assert.match(r.headers.get("content-type") ?? "", /^image\//, `${src} is a picture`);
  }
  assert.equal(imgs.filter((i) => /GitHub preview/.test(i)).length, 0, "sample cards never use a stored picture");
  assert.match(text(html), /showing 7 of 7 sample cards/);
  // the filter row and the view switch, the same in both views
  for (const path of ["/feed", "/feed?view=gallery"]) {
    const t = text((await get(path)).html);
    for (const label of ["All", "Robinhood Chain", "Base and EVM", "Solana and pump.fun", "AI agents", "Tools and infra", "All heat", "Newest", "Everyone", "Log", "Gallery"]) assert.ok(t.includes(label), `${path} filter row has ${label}`);
  }
  // the log stays the default, and an unknown view is the log
  assert.match((await get("/feed")).html, /class="feed"/);
  const odd = (await get("/feed?view=nope")).html;
  assert.match(odd, /class="feed"/);
  assert.doesNotMatch(odd, /class="masonry"/);
  // no engine: no pictures to serve
  assert.equal((await fetch(BASE + "/media/" + "a".repeat(24))).status, 404);
  assert.equal((await fetch(BASE + "/media/..%2F..%2Fetc")).status, 404);
});

test("home: the catches panel lists what there is", async () => {
  const { html } = await get("/");
  assert.match(text(html), /tail -3 catches\.log/);
  // the sample has three catches beside the hot one, so the panel is full and needs no note
  assert.equal((html.match(/class="mini-row"/g) ?? []).length, 3);
  assert.doesNotMatch(text(html), /More catches land here/);
});

test("each sample line has its own page; an unknown one is a 404", async () => {
  for (const [i, id] of SAMPLE_IDS.entries()) {
    const { status, html } = await get(`/feed/${id}`);
    assert.equal(status, 200, id);
    assert.ok(h1(html).includes(SAMPLE_REPOS[i]), `${id} heading names the repo`);
    assert.match(text(html), /Sample/, `${id} is marked Sample`);
  }
  const missing = await get("/feed/x");
  assert.equal(missing.status, 404);
  // Next 16 sends a not-found from a dynamic page as a bare shell plus the page in its payload, drawn in the browser
  assert.match(missing.html, /No such page/);
  assert.match(missing.html, /<meta name="robots" content="noindex"/);
});

test("only the real builder's lines link to GitHub", async () => {
  const toly = await get("/feed/dts02-6502-signer");
  assert.match(toly.html, /href="https:\/\/github\.com\/aeyakovenko\/dts02-6502-signer"/);
  // bunker_coin is a 2024 paper, never a 27 Oct push: it must not appear anywhere.
  assert.equal((await get("/feed")).html.includes("bunker_coin"), false);
  const made = await get("/feed/frog-oracle");
  // the header's own link to PUSHD's GitHub is not a builder's line
  assert.doesNotMatch(made.html.replace(/href="https:\/\/github\.com\/PushdFun\/pushd"/g, ""), /href="https:\/\/github\.com\//);
});

test("the token: only the burn; launching soon; no address before launch; never the tax, the chain or the fee split", async () => {
  const { html } = await get("/token");
  const t = text(html);
  for (const w of ["burn", "launching soon"]) assert.ok(t.toLowerCase().includes(w), `/token says ${w}`);
  for (const re of NEVER) assert.doesNotMatch(t, re, `/token says ${re}`);
  assert.doesNotMatch(t, /pump\.?fun|phantom|solana/i);
  assert.doesNotMatch(t, /\b70\b|\b30\b|split|owner.s share|share of the fees/i);
  assert.doesNotMatch(html, /0x[0-9a-fA-F]{40}/, "no address before launch");
});

test("holders: MetaMask sign-in that opens at launch; nothing about the old plan anywhere", async () => {
  const t = text((await get("/holders")).html);
  for (const w of ["Sign in with MetaMask", "opens at launch", "sign a message, not a transaction"]) assert.ok(t.includes(w), `/holders says ${w}`);
  assert.doesNotMatch(t, /\b70\b|\b30\b/);
  for (const path of Object.keys(PAGES)) {
    const page = text((await get(path)).html);
    assert.doesNotMatch(page, /phantom/i, `${path} never names Phantom`);
    // pump.fun only as a camp of the watched projects ("Solana and pump.fun"), never for the token
    assert.doesNotMatch(page.replace(/Solana and pump\.fun( projects)?/gi, ""), /pump\.?fun/i, `${path} never names pump.fun`);
  }
});

test("the launch page is a 404 unless switched on, and holder sign-in is closed with no engine", async () => {
  assert.equal((await get("/token/launch")).status, 404);
  const r = await fetch(BASE + "/api/holder/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0x" + "1".repeat(40) }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /opens at launch/);
  assert.equal((await fetch(BASE + "/api/holder/me")).status, 409);
});

test("the list, lookups and admin without an engine", async () => {
  const top = await get("/top");
  assert.ok([307, 308].includes(top.status), "/top redirects");
  assert.ok(top.location.endsWith("/watchlist"), `/top -> ${top.location}`);
  const wl = text((await get("/watchlist")).html);
  assert.match(wl, /Sample/, "the sample list says Sample");
  assert.match(wl, /Suggest a project/);
  assert.match(text((await get("/gh?q=paradigmxyz%2Freth")).html), /open the repo paradigmxyz\/reth/);
  const gh = text((await get("/gh/torvalds")).html);
  assert.match(gh, /not connected here/, "a lookup page without an engine says so, never a made-up page");
  const r = await fetch(BASE + "/api/lookup?q=toly");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.offline, true);
  assert.equal(j.direct.href, "/gh/toly");
  const admin = text((await get("/admin/suggestions")).html);
  assert.match(admin, /Admin is off/);
  assert.equal((await fetch(BASE + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "x" }) })).status, 404);
});

test("terms and privacy lead to their sections", async () => {
  for (const [path, hash] of [["/terms", "#terms"], ["/privacy", "#privacy"]]) {
    const r = await get(path);
    assert.ok([301, 307, 308].includes(r.status), path);
    assert.ok(r.location.endsWith(`/own-risk${hash}`), `${path} -> ${r.location}`);
  }
  const { html } = await get("/own-risk");
  for (const id of ["own-risk", "terms", "privacy"]) assert.match(html, new RegExp(`id="${id}"`));
});

test("metadata: titles, share picture, favicon, robots", async () => {
  const titles = { "/": "PUSHD", "/pulse": "PUSHD Pulse", "/compare": "PUSHD Compare", "/feed": "PUSHD Feed", "/catches": "PUSHD Catches", "/watchlist": "PUSHD: the list", "/gh": "PUSHD Look up", "/how": "How PUSHD Works", "/holders": "PUSHD Holders", "/token": "PUSHD Token", "/own-risk": "PUSHD Own Risk" };
  for (const [path, title] of Object.entries(titles)) {
    const { html } = await get(path);
    assert.match(html, new RegExp(`<title>${title.replace("$", "\\$")}</title>`), path);
    assert.match(html, /<meta name="description" content="[^"]+"/, `${path} description`);
    assert.match(html, /<meta property="og:image"/, `${path} og:image`);
    assert.match(html, /<link rel="icon"/, `${path} favicon`);
  }
  const og = await fetch(BASE + "/opengraph-image");
  assert.equal(og.status, 200);
  assert.equal(og.headers.get("content-type"), "image/png");
  const robots = await (await fetch(BASE + "/robots.txt")).text();
  assert.match(robots, /Allow: \//);
});

test("builder pages: each sample builder has one, marked Sample; strangers go to their lookup page; the real one links to GitHub", async () => {
  const toly = await get("/builders/toly");
  assert.equal(toly.status, 200);
  assert.match(text(toly.html), /Sample/);
  assert.match(text(toly.html), /Anatoly Yakovenko/);
  const kai = await get("/builders/kaiwren");
  assert.equal(kai.status, 200);
  assert.match(text(kai.html), /frog-oracle/);
  assert.doesNotMatch(kai.html, /href="https:\/\/github\.com\/kaiwren"/, "a made-up handle never links to GitHub");
  // anyone not watched has a page as any GitHub account
  const stranger = await fetch(BASE + "/builders/nobody-here", { redirect: "manual" });
  assert.ok([307, 308].includes(stranger.status), "a stranger is sent on");
  assert.match(stranger.headers.get("location") ?? "", /\/gh\/nobody-here$/);
  const og = await fetch(BASE + "/builders/toly/opengraph-image");
  assert.equal(og.status, 200);
  assert.equal(og.headers.get("content-type"), "image/png");
  const item = await fetch(BASE + "/feed/frog-oracle/opengraph-image");
  assert.equal(item.headers.get("content-type"), "image/png");
});

test("the item page: share text, timing, the line's own picture; compare and pulse mark the sample", async () => {
  const { html } = await get("/feed/frog-oracle");
  const t = text(html);
  assert.match(t, /Copy as post/);
  assert.match(t, /post\.txt/);
  assert.match(html, /src="\/feed\/frog-oracle\/opengraph-image"/);
  assert.match(t, /shown by PUSHD/);
  assert.match(text((await get("/pulse")).html), /Sample data/);
  const cmp = await get("/compare?b=toly,kaiwren");
  assert.equal(cmp.status, 200);
  assert.match(text(cmp.html), /Sample data/);
  assert.match(text(cmp.html), /Public events per day, 30 days/);
});

test("the public feeds and the widget: RSS, JSON Feed, an embeddable page; the rest of the site cannot be framed", async () => {
  const rss = await fetch(BASE + "/feed.xml");
  assert.equal(rss.status, 200);
  assert.match(rss.headers.get("content-type") ?? "", /application\/rss\+xml/);
  const x = await rss.text();
  assert.equal((x.match(/<item>/g) ?? []).length, SAMPLE_IDS.length);
  assert.doesNotMatch(x, DASHES);
  const jf = await fetch(BASE + "/feed.json");
  const j = await jf.json();
  assert.equal(j.version, "https://jsonfeed.org/version/1.1");
  assert.equal(j.items.length, SAMPLE_IDS.length);
  assert.ok(j.items.every((i) => i._pushd.sample === true));
  const em = await fetch(BASE + "/embed?n=3&heat=high");
  assert.equal(em.status, 200);
  assert.equal(em.headers.get("x-frame-options"), null, "the widget can be framed");
  assert.match(em.headers.get("content-security-policy") ?? "", /frame-ancestors \*/);
  const page = await em.text();
  assert.equal((page.match(/class="row"/g) ?? []).length, 3);
  assert.doesNotMatch(page, /<script/i, "the widget runs no script");
  const home = await fetch(BASE + "/");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.match(home.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("search, the palette's index, the app manifest and the offline page", async () => {
  const s = await (await fetch(BASE + "/api/search?q=frog")).json();
  assert.deepEqual(s.items.map((i) => i.id), ["frog-oracle"]);
  const idx = await (await fetch(BASE + "/api/index")).json();
  assert.ok(idx.builders.some((b) => b.handle === "toly"));
  assert.equal(idx.items.length, SAMPLE_IDS.length);
  const m = await fetch(BASE + "/manifest.webmanifest");
  assert.equal(m.status, 200);
  assert.equal((await m.json()).name, "PUSHD");
  assert.equal((await get("/offline")).status, 200);
  // no engine: nothing to stream, said with a 204 rather than a hanging connection
  assert.equal((await fetch(BASE + "/api/stream")).status, 204);
});

test("the scouts, my scout and the agents page without an engine: honest empty states, nothing pretends", async () => {
  const scouts = text((await get("/scouts")).html);
  assert.match(scouts, /Sample/);
  assert.match(scouts, /The engine is not connected here/);
  for (const name of ["Claude", "GPT", "Grok", "Gemini", "DeepSeek"]) assert.ok(scouts.includes(name), `scouts page shows ${name}`);
  assert.match(scouts, /information, not advice/i);
  assert.equal((await get("/scouts/nobody")).status, 404);
  const mine = text((await get("/my-scout")).html);
  assert.match(mine, /Opens at launch\./);
  assert.match(mine, /Example/);
  const agents = text((await get("/agents")).html);
  assert.match(agents, /paid tools open at launch/i);
  assert.match(agents, /every paid call buys \$PUSHD and burns it/i);
  assert.match(agents, /chain id 4663|chainId 4663/);
  const api = await fetch(BASE + "/api/agent/feed");
  assert.equal(api.status, 503, "no engine: the agent API says so");
  const mcp = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(mcp.status, 503);
  assert.equal((await fetch(BASE + "/api/agent/../../etc")).status, 404);
});

test("PUSHD Agents switched off (no PUSHD_AGENTS): every page and route of it is a 404 and the nav has no Build", async () => {
  for (const path of ["/build", "/build/0123456789abcdef", "/shipped/alice/thing", "/shipped/alice/thing/badge", "/api/build/me", "/api/build/github/login", "/api/build/github/callback?code=x&state=y"]) assert.equal((await get(path)).status, 404, path);
  for (const [m, path] of [["POST", "/api/build/github/webhook"], ["POST", "/api/build/draft"], ["POST", "/api/build/signout"]]) assert.equal((await fetch(BASE + path, { method: m })).status, 404, `${m} ${path}`);
  for (const path of ["/", "/feed", "/agents"]) {
    const { html } = await get(path);
    assert.doesNotMatch(html, /href="\/build"/, `${path} has no Build link`);
    assert.doesNotMatch(text(html), /shipped with a PUSHD agent|Build your agent/, `${path} says nothing about agents`);
  }
});

test("PUSHD Agents switched on with no engine: the Build page says so plainly, the routes refuse, nothing pretends", async () => {
  const on = await startSite({ PUSHD_AGENTS: "on" });
  try {
    const r = await fetch(on.base + "/build");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(h1(html), /^Build your agent\.$/);
    assert.match(text(html), /The engine is not connected here/);
    assert.match(html, /href="\/build" aria-current="page"|aria-current="page" href="\/build"/, "Build is in the nav and marked");
    for (const job of ["Release notes", "What shipped post", "Key check", "Small changes", "Pull request review", "Issue helper", "Weekly report", "Dependency watch", "Release maker", "Docs keeper"]) assert.ok(text(html).includes(job), `/build lists ${job}`);
    assert.match(text(html), /never pushes to your default branch, never touches workflows and never posts to X/);
    assert.doesNotMatch(html, DASHES);
    const copy = text(html).replace(/Robinhood Chain( projects)?|robinhood\//g, "");
    for (const re of [...NEVER, ...FORBIDDEN]) assert.doesNotMatch(copy, re, `/build says ${re}`);
    assert.doesNotMatch(copy, /\$\s?\d+(\.\d+)?\s?(a|per) day|daily (cap|budget)|cap of/i, "no cap is shown");
    const agents = await (await fetch(on.base + "/agents")).text();
    assert.match(text(agents), /An agent that helps you ship\./);
    assert.doesNotMatch(agents, DASHES);
    assert.equal((await fetch(on.base + "/api/build/me")).status, 503, "no engine: the API says so");
    assert.equal((await fetch(on.base + "/api/build/agents/xyz")).status, 404, "an unknown path never reaches the engine");
    assert.equal((await fetch(on.base + "/api/build/github/webhook", { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(on.base + "/shipped/alice/thing")).status, 404, "nothing shipped: no page");
    const login = await fetch(on.base + "/api/build/github/login", { redirect: "manual" });
    assert.ok([302, 307].includes(login.status));
    assert.match(login.headers.get("location") ?? "", /\/build\?signin=off$/);
    const cb = await fetch(on.base + "/api/build/github/callback?code=abc&state=nope", { redirect: "manual" });
    assert.match(cb.headers.get("location") ?? "", /\/build\?signin=again$/, "a state this browser was not given is refused");
  } finally {
    stopSite(on.proc);
  }
});
