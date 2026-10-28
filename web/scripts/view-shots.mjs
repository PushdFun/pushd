/**
 * Screen-sized screenshots of any pages, in headless Chrome over the DevTools protocol: 1440x900 and 390x844 (a real
 * phone viewport, which plain `--screenshot` cannot do), dark and light. Each shot is checked for sideways scroll and
 * long dashes; problems are printed and the exit code is 1.
 *
 *   node scripts/view-shots.mjs plan.json
 *
 * plan.json: { "base": "http://localhost:3700", "out": "shots/lookup", "cookies": [{ "name": "...", "value": "..." }],
 *   "shots": [{ "name": "top", "path": "/watchlist", "scroll": "#rank", "click": "details.top-row summary",
 *               "waitFor": "some text", "sizes": ["d", "m"], "themes": ["dark", "light"] }] }
 * Cookies (a holder's session for a local demo) are set on the base's host before each page; never a real secret.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = plan.base ?? "http://localhost:3700";
const OUT = resolve(plan.out ?? "shots/lookup");
const PORT = 9300 + (process.pid % 500);
const SIZES = { d: [1440, 900, false], m: [390, 844, true] };
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), `pushd-view-${process.pid}`);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--lang=en-US", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
  } catch {
    /* not up yet */
  }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error("Chrome did not start");
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } else if (msg.method) listeners.forEach((fn) => fn(msg));
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
const host = new URL(BASE).hostname;

const problems = [];
const made = [];
for (const s of plan.shots) {
  for (const size of s.sizes ?? ["d", "m"]) {
    for (const theme of s.themes ?? ["dark", "light"]) {
      const [w, h, mobile] = SIZES[size];
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
      await send("Emulation.setUserAgentOverride", {
        userAgent: mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      for (const c of plan.cookies ?? []) await send("Network.setCookie", { name: c.name, value: c.value, domain: host, path: "/" });
      // the theme before the first paint, as the site's own script reads it
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("pushd-theme", ${JSON.stringify(theme)}); } catch {}` });
      const loaded = new Promise((r) => {
        const fn = (msg) => msg.method === "Page.loadEventFired" && (listeners.splice(listeners.indexOf(fn), 1), r());
        listeners.push(fn);
      });
      await send("Page.navigate", { url: BASE + s.path });
      await loaded;
      await evaluate(`(async () => { document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}); await document.fonts.ready; return true; })()`);
      if (s.waitFor) {
        const t0 = Date.now();
        while (Date.now() - t0 < 30000 && !(await evaluate(`document.body.innerText.includes(${JSON.stringify(s.waitFor)})`))) await sleep(250);
      }
      await sleep(s.settleMs ?? 700);
      if (s.click) await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(s.click)}); if (el) el.click(); return !!el; })()`);
      if (s.type) await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(s.type[0])}); if (!el) return false; el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(s.type[1])}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      if (s.key) await evaluate(`(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(s.key)}, ctrlKey: true, bubbles: true })); return true; })()`);
      if (s.click || s.type || s.key) await sleep(s.afterMs ?? 900);
      if (s.scroll) await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(s.scroll)}); if (!el) return false; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - ${mobile ? 70 : 90}, behavior: "instant" }); return true; })()`);
      await sleep(400);
      const check = await evaluate(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dash: /[\\u2013\\u2014]/.test(document.body.innerText), title: document.title })`);
      const name = `${s.name}-${size === "d" ? "1440" : "390"}-${theme}.png`;
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, name), Buffer.from(shot.data, "base64"));
      made.push(join(OUT, name));
      if (check.sw > check.iw) problems.push(`${name}: sideways scroll (${check.sw} > ${check.iw})`);
      if (check.dash) problems.push(`${name}: a long dash on the page`);
    }
  }
}
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
for (const m of made) console.log(m);
if (problems.length) {
  console.log("\nproblems:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`\n${made.length} shots, no sideways scroll, no long dashes`);
