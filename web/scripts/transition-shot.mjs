/**
 * A screenshot in the middle of a page transition, in headless Chrome: opens a page, lets the next page's link
 * prefetch, clicks it, waits for the view transition's animations to start and shoots. Chrome's animation playback
 * rate can be slowed (RATE, default 1) to hold the transition still for the shot.
 *
 *   node scripts/transition-shot.mjs <out.png> <from-path> <to-path>
 *   BASE (default http://localhost:3700), SIZE (default 1440x900), THEME (dark or light), RATE (default 1), AT (ms into the transition at rate 1, default 150)
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:3700";
const [w, h] = (process.env.SIZE ?? "1440x900").split("x").map(Number);
const THEME = process.env.THEME ?? "dark";
const RATE = Number(process.env.RATE ?? 1);
const AT = Number(process.env.AT ?? 150);
const [out, from, to] = process.argv.slice(2);
if (!out || !from || !to) {
  console.error("usage: node scripts/transition-shot.mjs <out.png> <from-path> <to-path>");
  process.exit(2);
}
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), `pushd-tshot-${process.pid}`);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--lang=en-US", "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 60; i++) {
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
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Animation.enable");
const phone = w < 800;
await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try{localStorage.setItem("pushd-theme",${JSON.stringify(THEME)})}catch(e){}
  // count the live streams the page opens, to see one survive the navigation
  (()=>{const O=window.EventSource;if(!O)return;window.__es=[];const W=function(u,i){const e=new O(u,i);window.__es.push({e,at:performance.now()});return e};W.prototype=O.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSED=2;window.EventSource=W})()`,
});
await send("Page.navigate", { url: BASE + from });
await sleep(4000);
// let the link prefetch (the dev server prefetches on hover)
await evaluate(`(()=>{const a=document.querySelector('a[href="${to}"]');if(!a)return "no link";a.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));a.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true}));return "ok"})()`);
await sleep(2500);
await send("Animation.setPlaybackRate", { playbackRate: RATE });
const t0 = Date.now();
await evaluate(`(()=>{window.__clickAt=performance.now();const a=document.querySelector('a[href="${to}"]');a.click();return 1})()`);
// wait for the transition's animations to run
let started = 0;
for (let i = 0; i < 200; i++) {
  const n = await evaluate(`document.getAnimations().filter(a=>a.effect&&a.effect.pseudoElement&&a.effect.pseudoElement.startsWith("::view-transition")).length`);
  if (n > 0) {
    started = Date.now();
    break;
  }
  await sleep(10);
}
if (started) await sleep(Math.max(0, AT / RATE - (Date.now() - started)));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
const after = await evaluate(`({path:location.pathname,running:document.getAnimations().filter(a=>a.effect&&a.effect.pseudoElement&&a.effect.pseudoElement.startsWith("::view-transition")).map(a=>a.effect.pseudoElement)})`);
console.log(`${out}  transition ${started ? `started ${started - t0}ms after the click` : "not seen"}; now at ${after?.path}; running: ${after?.running?.join(", ") || "none"}`);
// the live stream must survive the navigation: the one connection opened on the first page, still open (readyState 1)
await sleep(1500);
const streams = await evaluate(`(window.__es||[]).map(({e,at})=>e.url.replace(location.origin,"")+" state "+e.readyState+" opened "+(at<window.__clickAt?"before":"after")+" the click").join(", ")`);
console.log(`live streams: ${streams || "none"} (the open one should be from before the click: it stayed open through the navigation)`);
ws.close();
chrome.kill("SIGTERM");
await sleep(300);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* Chrome may hold it a moment longer */
}
