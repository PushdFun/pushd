import { agentsOn, getShipped } from "@/lib/build-server";

// The embeddable badge: "shipped with PUSHD | N pull requests", as a small SVG for a README or any site. Plain text in
// it, escaped; cached for ten minutes. A repo with nothing shipped yet gets the badge without a count.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// about 6.6 pixels a character at 11px in the badge's monospace stack
const width = (s: string) => Math.round(s.length * 6.6) + 16;

export async function GET(_req: Request, ctx: { params: Promise<{ owner: string; repo: string }> }) {
  if (!agentsOn()) return new Response(null, { status: 404 });
  const { owner, repo } = await ctx.params;
  const p = await getShipped(owner, repo);
  const left = "shipped with PUSHD";
  const right = p ? `${p.counts.pullRequests} pull request${p.counts.pullRequests === 1 ? "" : "s"}` : "agent";
  const lw = width(left);
  const rw = width(right);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(`${left}: ${right}`)}">
<title>${esc(`${left}: ${right}`)}</title>
<rect width="${lw}" height="20" rx="3" fill="#0a0c0b"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="#a6ff4d"/><rect x="${lw - 3}" width="6" height="20" fill="#a6ff4d"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" font-weight="700">
<text x="8" y="14" fill="#e6ece8">${esc(left)}</text><text x="${lw + 8}" y="14" fill="#0a0c0b">${esc(right)}</text>
</g></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" } });
}
