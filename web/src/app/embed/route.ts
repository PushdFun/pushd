import { getPublicFeed } from "@/lib/data";
import { ago } from "@/lib/format";
import { GROUPS, HEAT_CLASS, HEAT_RANK, KIND_LABEL } from "@/lib/groups";
import { SITE } from "@/lib/site";
import type { GroupKey, Heat } from "@/lib/types";

// The widget: the latest public lines as a small page made to sit in an iframe on any site. Plain HTML and CSS, no
// script. ?n= lines (3 to 20), ?group= one camp, ?heat= that heat and up, ?theme=light. Same delay as the public site.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const GROUP_SLUG: Record<string, GroupKey> = Object.fromEntries(Object.entries(GROUPS).flatMap(([k, g]) => [[k, k as GroupKey], [g.slug, k as GroupKey]]));
const HEATS: Record<string, Heat> = { low: "low", medium: "medium", high: "high", veryhigh: "veryHigh", "very-high": "veryHigh" };
const MARK = `<svg viewBox="0 0 26 26" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="4" fill="var(--acc)"/><path d="M13 5.5 19.5 12h-4.2v8.5h-4.6V12H6.5z" fill="var(--ink)"/></svg>`;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const n = Math.max(3, Math.min(20, Number(u.searchParams.get("n")) || 8));
  const group = GROUP_SLUG[u.searchParams.get("group") ?? ""];
  const heat = HEATS[(u.searchParams.get("heat") ?? "").toLowerCase()];
  const light = u.searchParams.get("theme") === "light";
  const feed = await getPublicFeed();
  const items = feed.items.filter((it) => (!group || it.group === group) && (!heat || HEAT_RANK[it.heat] >= HEAT_RANK[heat])).slice(0, n);
  const rows = items
    .map(
      (it) => `<a class="row" href="${SITE.url}/feed/${esc(it.id)}" target="_blank" rel="noopener">
<span class="top"><span class="who">${esc(it.handle)} <em>/</em> <span class="r">${esc(it.repo)}${it.version ? " " + esc(it.version) : ""}</span></span><span class="h ${HEAT_CLASS[it.heat]}"><i></i>${ago(it.githubAt, feed.asOf)}</span></span>
<span class="k">${KIND_LABEL[it.kind]}${it.sample ? " . sample" : ""}</span>
<p>${esc(it.summary)}</p></a>`,
    )
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>PUSHD</title>
<style>
:root{--bg:${light ? "#f9f8f4" : "#0a0c0b"};--bg2:${light ? "#f1f0ea" : "#0f1211"};--bg3:${light ? "#e9e7df" : "#151917"};--line:${light ? "#d6d3c8" : "#222826"};--text:${light ? "#121614" : "#e6ece8"};--muted:${light ? "#4c5751" : "#95a29b"};--dim:${light ? "#858d88" : "#5d6963"};--acc:${light ? "#2c7a0e" : "#a6ff4d"};--ink:${light ? "#fff" : "#0a0c0b"};--cy:${light ? "#0a6a93" : "#74dcff"};--low:${light ? "#67716b" : "#85928b"};--medium:${light ? "#9a6400" : "#f4c152"};--high:${light ? "#c04d06" : "#ff8f3f"};--vhigh:${light ? "#c3173d" : "#ff5473"}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-decoration:none}.hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--bg2)}
.hd a{display:inline-flex;align-items:center;gap:8px;font-weight:800;letter-spacing:.06em}.hd a b{color:var(--acc)}.hd span{color:var(--dim);font-size:11px}
.row{display:block;padding:10px 14px;border-bottom:1px dashed var(--line)}.row:hover{background:var(--bg3)}.top{display:flex;justify-content:space-between;gap:10px}
.who{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.who em{font-style:normal;color:var(--dim);font-weight:400}.r{color:var(--cy)}
.k{display:block;color:var(--cy);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;margin-top:2px}
p{margin:3px 0 0;color:var(--muted);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13.5px}
.h{display:inline-flex;align-items:center;gap:6px;color:var(--dim);white-space:nowrap;font-size:11.5px}.h i{width:8px;height:8px;border-radius:50%;background:var(--low)}
.h.medium i{background:var(--medium)}.h.high i{background:var(--high)}.h.vhigh i{background:var(--vhigh);box-shadow:0 0 8px var(--vhigh)}
.ft{margin-top:auto;padding:8px 14px;font-size:11px;color:var(--dim);border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}.ft a{color:var(--acc)}
.empty{padding:28px 14px;color:var(--muted);text-align:center}
</style></head><body>
<div class="hd"><a href="${SITE.url}/feed" target="_blank" rel="noopener">${MARK} PUSHD<b>_</b></a><span>${feed.source === "sample" ? "sample lines" : "public view, a few minutes behind"}</span></div>
${rows || `<div class="empty">No lines to show right now.</div>`}
<div class="ft"><span>public GitHub activity, one line each</span><a href="${SITE.url}" target="_blank" rel="noopener">pushd.fun</a></div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}
