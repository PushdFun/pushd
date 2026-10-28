/**
 * Screen-sized screenshots of the token pages in headless Chrome, at 1440x900 and 390x844, dark and light, each
 * checked for sideways scroll and long dashes. A wallet is injected into the page (an EIP-1193 provider whose
 * requests this script answers): it sends by having the local fork impersonate the wallet, and signs messages with a
 * throwaway fork key, so no real key exists anywhere. Run by scripts/launch-rehearsal.sh (the repo root):
 *
 *   node scripts/screens.mjs soon   before anything exists: /token, /holders and home (no engine, no addresses)
 *   node scripts/screens.mjs pre    deployed, not launched: /token, and the launch page's states (start, wrong
 *                                   wallet, short of ETH, ready), then the button pressed on a snapshot of the fork
 *                                   that is rolled back afterwards
 *   node scripts/screens.mjs post   after the launch and a burn: the launch page (already launched), /token live,
 *                                   holder sign-in in the browser and the holder's tools, home, the live feed
 *
 * BASE (the site), OUT (folder, web/shots/token by default), FORK_RPC (http://127.0.0.1:<port> only), FORK_LAUNCHER,
 * FORK_HOLDER_KEY (post).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:3911";
const MODE = process.argv[2] ?? "soon";
const OUT = process.env.OUT ?? join(process.cwd(), "shots", "token");
const RPC = process.env.FORK_RPC ?? "";
const LAUNCHER = process.env.FORK_LAUNCHER ?? "";
const STRANGER = "0x5ec0000000000000000000000000000000057a9e";
const PORT = 9368;
if (MODE !== "soon") {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(RPC)) throw new Error("FORK_RPC must be the local fork, http://127.0.0.1:<port>");
  if (!/^0x[0-9a-fA-F]{40}$/.test(LAUNCHER)) throw new Error("FORK_LAUNCHER is not an address");
}
const holderKey = process.env.FORK_HOLDER_KEY ?? "";
const holder = /^0x[0-9a-fA-F]{64}$/.test(holderKey) ? privateKeyToAccount(holderKey) : null;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpcId = 0;
async function fork(method, params = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}
const hexWei = (eth) => `0x${(BigInt(Math.round(eth * 1e6)) * BigInt(1e12)).toString(16)}`;

const profile = join(tmpdir(), `pushd-shots-${process.pid}`);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--lang=en-US", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method) events.forEach((fn) => fn(msg));
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

/* The wallet in the page. `account` is whoever the step needs; `null` means no wallet in the browser at all. */
let account = LAUNCHER || null;
let walletOn = MODE !== "soon";
let signDelay = 0;
const sent = [];
await send("Runtime.addBinding", { name: "__pushdBridge" });
// whether the next page gets a wallet: a cookie set before each navigation (this runs before the wallet below)
await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pushdWallet = document.cookie.includes('shot_wallet=1');" });
// browser notifications, allowed and written down instead of shown, when the shot_notify cookie is set
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `if (document.cookie.includes("shot_notify=1")) { window.__notes = []; window.Notification = class { static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } constructor(title, opts) { window.__notes.push({ title, body: opts && opts.body, tag: opts && opts.tag }); } }; }`,
});
// a tap that leaves for MetaMask's app link is caught here, never sent
await send("Fetch.enable", { patterns: [{ urlPattern: "https://metamask.app.link/*" }] });
const leftFor = [];
events.push(async (msg) => {
  if (msg.method !== "Fetch.requestPaused") return;
  leftFor.push(msg.params.request.url);
  await send("Fetch.fulfillRequest", { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<p>MetaMask app link</p>").toString("base64") });
});
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    if (!window.__pushdWallet) return;
    let n = 0; const waiting = new Map();
    window.__pushdReply = (id, result, error) => { const w = waiting.get(id); if (!w) return; waiting.delete(id); error ? w.reject(Object.assign(new Error(error.message), { code: error.code })) : w.resolve(result); };
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: ({ method, params }) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); window.__pushdBridge(JSON.stringify({ id, method, params: params ?? [] })); }) };
  })();`,
});
events.push(async (msg) => {
  if (msg.method !== "Runtime.bindingCalled" || msg.params.name !== "__pushdBridge") return;
  const { id, method, params } = JSON.parse(msg.params.payload);
  let result = null;
  let error = null;
  try {
    if (method === "eth_requestAccounts" || method === "eth_accounts") result = [account];
    else if (method === "eth_chainId") result = "0x1237";
    else if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") result = null;
    else if (method === "personal_sign") {
      const [data, from] = params;
      if (!holder || from.toLowerCase() !== holder.address.toLowerCase()) throw new Error("no key for that wallet here");
      result = await holder.signMessage({ message: hexToString(data) });
    } else if (method === "eth_sendTransaction") {
      if (signDelay) await sleep(signDelay);
      const tx = params[0];
      const keys = Object.keys(tx).sort().join(",");
      if (keys !== "data,from,gas,to,value") throw new Error(`the page sent other fields: ${keys}`);
      sent.push(tx);
      await fork("anvil_impersonateAccount", [tx.from]);
      result = await fork("eth_sendTransaction", [tx]);
      await fork("anvil_stopImpersonatingAccount", [tx.from]);
      console.log("  the page's wallet sent", result, "value", BigInt(tx.value).toString(), "gas", BigInt(tx.gas).toString());
    } else error = { code: 4200, message: `not supported here: ${method}` };
  } catch (e) {
    error = { code: -32000, message: String(e.message).slice(0, 200) };
  }
  await send("Runtime.evaluate", { expression: `window.__pushdReply(${id}, ${JSON.stringify(result)}, ${JSON.stringify(error)})`, contextId: msg.params.executionContextId });
});

let mobile = false;
let theme = "dark";
let notify = false;
async function setViewport(width, height, isMobile) {
  mobile = isMobile;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: isMobile ? 2 : 1, mobile: isMobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: isMobile });
  await send("Emulation.setUserAgentOverride", {
    userAgent: isMobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: isMobile ? "coarse" : "fine" }] });
}
function untilLoad() {
  return new Promise((resolve) => {
    const fn = (msg) => {
      if (msg.method === "Page.loadEventFired") {
        events.splice(events.indexOf(fn), 1);
        resolve();
      }
    };
    events.push(fn);
  });
}
const host = new URL(BASE).hostname;
async function open(path) {
  await send("Network.setCookie", { name: "shot_wallet", value: walletOn ? "1" : "0", domain: host, path: "/" });
  await send("Network.setCookie", { name: "shot_notify", value: notify ? "1" : "0", domain: host, path: "/" });
  const loaded = untilLoad();
  await send("Page.navigate", { url: `${BASE}${path}` });
  await loaded;
  await evaluate(`(async () => { try { localStorage.setItem("pushd-theme", ${JSON.stringify(theme)}); } catch {} document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}); await document.fonts.ready; return true; })()`);
  await sleep(600);
}
const has = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
async function waitFor(expression, ms = 90000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await sleep(150);
  }
  const where = await evaluate(`location.href + " | " + document.body.innerText.slice(0, 800)`).catch(() => "?");
  throw new Error("timed out waiting for " + expression + " on " + where);
}
async function clickText(text) {
  await evaluate(`(() => { const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error("no button " + ${JSON.stringify(text)}); el.click(); return true; })()`);
}
async function scrollTo(selector, offset = 84) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no " + ${JSON.stringify(selector)}); const y = el.getBoundingClientRect().top + window.scrollY - ${offset}; window.scrollTo({ top: y, behavior: "instant" }); return y; })()`);
}
async function top() {
  await evaluate(`window.scrollTo({ top: 0, behavior: "instant" })`);
}
async function checks(name) {
  const over = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  if (over > 1) {
    const wide = await evaluate(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((e) => e.tagName + "." + String(e.className).slice(0, 60)).join(" | ")`);
    throw new Error(`${name}: the page scrolls sideways by ${over}px: ${wide}`);
  }
  if (await evaluate(`/[\\u2013\\u2014]/.test(document.body.innerText)`)) throw new Error(`${name}: a long dash on the page`);
  // pump.fun may appear as a topic (builders on the watchlist, their lines in the feed), never about the token
  const copy = `(() => { const c = document.body.cloneNode(true); c.querySelectorAll("script, style, .ht-rows, .feed, .gwrap, .wl").forEach((e) => e.remove()); return c.textContent; })()`;
  if (await evaluate(`/pump\\.?fun|phantom/i.test(${copy}) && !location.pathname.startsWith("/watchlist")`)) throw new Error(`${name}: the old token plan is named on the page`);
}
const shots = [];
async function shot(name, settle = 700) {
  await sleep(settle);
  await checks(name);
  const file = join(OUT, `${name}-${mobile ? "phone" : "desktop"}-${theme}.png`);
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(data, "base64"));
  shots.push(file);
  console.log("  wrote", file);
}
/** A new line straight into the engine's store (the fork rehearsal's own copy), shown now, very high heat. */
function addLine(id) {
  const db = process.env.FORK_ENGINE_DB ?? "";
  if (!db.includes("pushd-launch-rehearsal")) throw new Error("FORK_ENGINE_DB is not the rehearsal's own copy");
  const now = new Date().toISOString();
  const code = `const D = require("better-sqlite3"); const d = new D(process.argv[1]); d.prepare("INSERT INTO items (id, key, handle, group_key, kind, repo, version, summary, summary_source, heat, heat_rank, score, signals, github_at, seen_at, shown_at, url, backfill) VALUES (?, ?, 'aeyakovenko', 'chain', 'repo', ?, NULL, 'A line added on the fork to check live alerts.', 'fallback', 'veryHigh', 4, 9, '[]', ?, ?, ?, NULL, 0)").run(process.argv[2], 'k:' + process.argv[2], process.argv[2], process.argv[3], process.argv[3], process.argv[3]); d.close();`;
  const r = spawnSync(process.execPath, ["-e", code, db, id, now], { cwd: join(process.cwd(), "..", "engine"), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not add a line: ${r.stderr}`);
}
const clearRemembered = () => evaluate(`(() => { Object.keys(localStorage).filter((k) => k.startsWith("pushd-launch-tx:")).forEach((k) => localStorage.removeItem(k)); return true; })()`);

const desktop = () => setViewport(1440, 900, false);
const phone = () => setViewport(390, 844, true);
const SIZES = [
  ["desktop", desktop],
  ["phone", phone],
];
const THEMES = ["dark", "light"];

try {
  if (MODE === "soon") {
    walletOn = false;
    for (const [, size] of SIZES) {
      await size();
      for (const t of THEMES) {
        theme = t;
        await open("/");
        await waitFor(has("Buy $PUSHD"));
        // the home terminal types its lines in: let it finish
        await shot("soon-home", 4500);
        await open("/token");
        await waitFor(has("launching soon"));
        await shot("soon-token");
        await scrollTo(".facts", 100);
        await shot("soon-token-facts");
        await open("/holders");
        await scrollTo('[aria-label="Sign in"]', 100);
        await waitFor(has("at launch"));
        await shot("soon-holders-signin");
      }
    }
  } else if (MODE === "pre") {
    await fork("anvil_setBalance", [LAUNCHER, hexWei(1)]);
    await fork("anvil_setBalance", [STRANGER, hexWei(1)]);
    for (const [, size] of SIZES) {
      await size();
      for (const t of THEMES) {
        theme = t;
        walletOn = false;
        await open("/token");
        await waitFor(has("contracts live, launch soon"));
        await shot("deployed-token");
        walletOn = true;
        account = LAUNCHER;
        await open("/token/launch");
        await waitFor(has("Connect MetaMask"));
        await shot("launch-01-start");
      }
    }
    theme = "dark";
    for (const [label, size] of SIZES) {
      await size();
      walletOn = true;
      account = STRANGER;
      await open(label === "phone" ? "/token/launch?link=launch" : "/token/launch");
      if (label !== "phone") await clickText("Connect MetaMask");
      await waitFor(has("This wallet is not the launch wallet"));
      await scrollTo('[aria-label="Launch"]');
      await shot("launch-02-wrong-wallet");

      account = LAUNCHER;
      await fork("anvil_setBalance", [LAUNCHER, hexWei(0.002)]);
      await open("/token/launch");
      await clickText("Connect MetaMask");
      await waitFor(has("does not hold enough ETH"));
      await scrollTo('[aria-label="Launch"]');
      await shot("launch-03-short");
      await fork("anvil_setBalance", [LAUNCHER, hexWei(1)]);

      for (const t of THEMES) {
        theme = t;
        await open("/token/launch");
        await clickText("Connect MetaMask");
        await waitFor(has("token address it will have"));
        await scrollTo('[aria-label="Launch"]');
        await shot("launch-04-ready");
      }
      theme = "dark";
    }
    /* The button, pressed, on a snapshot of the fork that is rolled back afterwards */
    for (const [label, size] of SIZES) {
      const snap = await fork("evm_snapshot");
      await size();
      account = LAUNCHER;
      await open("/token/launch");
      await clearRemembered();
      await clickText("Connect MetaMask");
      await waitFor(has("token address it will have"));
      const predicted = await evaluate(`[...document.querySelectorAll("dt")].find((d) => d.textContent === "token address it will have")?.nextElementSibling?.textContent ?? ""`);
      signDelay = 2500;
      await clickText("Launch $PUSHD");
      await waitFor(has("Confirm the launch in MetaMask"), 20000);
      await scrollTo('[aria-label="Launch"]');
      await shot("launch-05-confirm", 300);
      // a second press while it is out does nothing
      await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Launch $PUSHD"); if (b) b.click(); return true; })()`);
      signDelay = 0;
      await waitFor(has("$PUSHD is live."), 120000);
      const token = await evaluate(`[...document.querySelectorAll("dt")].find((d) => d.textContent === "token")?.nextElementSibling?.textContent ?? ""`);
      if (!token || token.toLowerCase() !== predicted.toLowerCase()) throw new Error(`the launched token ${token} is not the predicted ${predicted}`);
      await scrollTo('[aria-label="Launched"]');
      await shot("launch-06-done");
      await clearRemembered();
      await fork("evm_revert", [snap]);
      console.log(`  ${label}: launched ${token} from the button, as predicted; the fork rolled back`);
    }
    if (sent.length !== 2) throw new Error(`the page sent ${sent.length} transactions for two presses on two snapshots, not 2`);
  } else if (MODE === "post") {
    if (!holder) throw new Error("FORK_HOLDER_KEY is not set");
    for (const [, size] of SIZES) {
      await size();
      for (const t of THEMES) {
        theme = t;
        walletOn = true;
        account = LAUNCHER;
        await open("/token/launch");
        await waitFor(has("already launched"));
        await shot("launch-07-already");
        walletOn = false;
        await open("/token");
        await waitFor(has("live on Robinhood Chain"));
        await top();
        await shot("live-token");
        await scrollTo("#burns", 90);
        await shot("live-token-burns");
        await scrollTo('[aria-label="Recent burns"]', 90);
        await shot("live-token-list");
        await open("/");
        await waitFor(`[...document.querySelectorAll(".hdr .btn, .drawer .btn")].some((a) => a.getAttribute("href")?.startsWith("https://ponsfamily.com/launchpad/0x"))`);
        await shot("live-home", 4500);
      }
    }
    // holder sign-in in the browser: MetaMask (the injected wallet) signs one message with the holder's throwaway key
    for (const [label, size] of SIZES) {
      await size();
      theme = "dark";
      walletOn = true;
      account = holder.address;
      await send("Network.clearBrowserCookies");
      if (label === "phone") {
        // inside MetaMask's own browser, the deep link's ?link=holder starts the sign-in by itself
        await open("/holders?link=holder");
      } else {
        await open("/holders");
        await scrollTo('[aria-label="Sign in"]', 100);
        await shot("live-holders-signin");
        await clickText("Sign in with MetaMask");
      }
      await waitFor(has("The live feed is open."), 60000);
      for (const t of THEMES) {
        theme = t;
        await open("/holders");
        await scrollTo('[aria-label="Signed in"]', 100);
        await shot("live-holders-signed-in");
        await scrollTo("#mine", 70);
        await shot("live-holders-tools");
      }
      theme = "dark";
      // follow two builders, save, and see the live feed's own filter
      await open("/holders");
      await scrollTo("#mine", 70);
      await evaluate(`(() => { const rows = [...document.querySelectorAll(".ht-row")].slice(0, 2); rows.forEach((r) => r.querySelector("button").click()); return rows.length; })()`);
      await clickText("Save my choices");
      await waitFor(has("saved"));
      // the live feed: a new line arrives on the stream, the page redraws with it and a browser alert goes out
      notify = true;
      await open("/feed");
      await waitFor(has("holder view"));
      await sleep(2500);
      const id = `fork-rehearsal-${label}`;
      addLine(id);
      await waitFor(`(window.__notes || []).some((n) => n.tag === ${JSON.stringify(`pushd-${id}`)})`, 30000);
      await waitFor(has(`fork-rehearsal-${label}`), 30000);
      const note = await evaluate(`window.__notes.find((n) => n.tag === ${JSON.stringify(`pushd-${id}`)})`);
      console.log(`  ${label}: the live line arrived on the stream, the feed redrew, and the alert said "${note.title}: ${note.body}"`);
      await top();
      await shot("live-feed-holder");
      notify = false;
    }
    // a phone with no wallet in its browser: the sign-in button leaves for MetaMask's app with this page
    await phone();
    walletOn = false;
    await send("Network.clearBrowserCookies");
    await open("/holders");
    await scrollTo('[aria-label="Sign in"]', 100);
    await clickText("Sign in with MetaMask");
    for (let i = 0; i < 40 && !leftFor.length; i++) await sleep(150);
    const want = `https://metamask.app.link/dapp/${new URL(BASE).host}/holders?link=holder`;
    if (leftFor[0] !== want) throw new Error(`a phone with no wallet went to ${leftFor[0] ?? "nowhere"}, not ${want}`);
    console.log(`  phone with no wallet: the button opens ${leftFor[0]}`);
  } else throw new Error("soon, pre or post");
  console.log(`  ${shots.length} screenshots`);
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
