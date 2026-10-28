/**
 * Screen-sized screenshots of any pages, in headless Chrome: each page at 1440x900 and 390x844, dark and light, at the
 * top and (optionally) scrolled to a few positions or to an element. Each shot is checked for sideways scroll and for
 * long dashes in the page's text; problems are printed and counted in the exit code.
 *
 *   node scripts/shots.mjs <out-dir> <name>=<path>[@<scroll>,<scroll>...] ...
 *     <scroll> is a number of pixels, or #id / .class to scroll that element to the top
 *   BASE (default http://localhost:3700), SIZES (default "1440x900,390x844"), THEMES (default "dark,light"),
 *   WAIT (ms after load, default 1800), ACTION (JS to run after load, before the shots, e.g. to open a menu),
 *   COOKIE ("name=value; name2=value2": cookies set for BASE before the first page, e.g. a demo holder's session)
 *
 *   node scripts/shots.mjs shots/v2 home=/@0,900,1800 feed=/feed builder=/builders/aeyakovenko@#activity
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:3700";
const SIZES = (process.env.SIZES ?? "1440x900,390x844").split(",").map((s) => s.split("x").map(Number));
const THEMES = (process.env.THEMES ?? "dark,light").split(",");
const WAIT = Number(process.env.WAIT ?? 1800);
const ACTION = process.env.ACTION ?? "";
const [out, ...pages] = process.argv.slice(2);
if (!out || !pages.length) {
  console.error("usage: node scripts/shots.mjs <out-dir> name=/path[@scroll,...] ...");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), `pushd-shots-${process.pid}`);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--lang=en-US", "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

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
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method) listeners.forEach((fn) => fn(msg));
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  for (let i = 0; i < 4; i++) {
    try {
      return (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
    } catch {
      await sleep(1500);
    }
  }
  return undefined;
};
await send("Page.enable");
await send("Runtime.enable");
if (process.env.COOKIE) {
  await send("Network.enable");
  for (const part of process.env.COOKIE.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) await send("Network.setCookie", { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), url: BASE });
  }
}

let problems = 0;
for (const spec of pages) {
  const name = spec.slice(0, spec.indexOf("="));
  const rest = spec.slice(spec.indexOf("=") + 1);
  const at = rest.lastIndexOf("@");
  const [path, scrollList] = at > 0 ? [rest.slice(0, at), rest.slice(at + 1)] : [rest, ""];
  const scrolls = scrollList ? scrollList.split(",") : ["0"];
  for (const [w, h] of SIZES) {
    const phone = w < 800;
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await send("Emulation.setTouchEmulationEnabled", { enabled: phone });
    for (const theme of THEMES) {
      await send("Page.navigate", { url: "about:blank" });
      await sleep(100);
      const loaded = new Promise((r) => {
        const fn = (msg) => msg.method === "Page.loadEventFired" && (listeners.splice(listeners.indexOf(fn), 1), r());
        listeners.push(fn);
      });
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("pushd-theme",${JSON.stringify(theme)})}catch(e){}` });
      await send("Page.navigate", { url: BASE + path });
      await Promise.race([loaded, sleep(20000)]);
      await sleep(WAIT);
      if (ACTION) {
        // the dev server may reload the page while others edit files: start the action again until it ran on one page
        for (let k = 0; k < 4; k++) {
          await evaluate(`window.__mark=1`);
          await evaluate(`(async()=>{${ACTION}})()`);
          if (await evaluate(`window.__mark===1`)) break;
          await sleep(WAIT);
        }
      }
      for (const [i, s] of scrolls.entries()) {
        const sel = /^[#.]/.test(s) ? s : null;
        await evaluate(sel ? `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e){window.scrollTo(0,e.getBoundingClientRect().top+scrollY-(innerWidth<1080?64:72))}})()` : `window.scrollTo(0,${Number(s)})`);
        await sleep(700);
        const check = await evaluate(`(()=>{const over=document.documentElement.scrollWidth-innerWidth;const t=document.body.innerText;return {over,dash:/[\\u2013\\u2014]/.test(t)}})()`);
        const file = join(out, `${name}-${phone ? "phone" : "desktop"}-${theme}${scrolls.length > 1 ? `-${i + 1}` : ""}.png`);
        const shot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        const notes = [check?.over > 0 ? `sideways scroll ${check.over}px` : null, check?.dash ? "long dash in text" : null].filter(Boolean);
        if (notes.length) problems++;
        console.log(`${file}${notes.length ? "  !! " + notes.join(", ") : ""}`);
      }
    }
  }
}
ws.close();
chrome.kill("SIGTERM");
await sleep(300);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* Chrome may hold it a moment longer */
}
process.exit(problems ? 1 : 0);
