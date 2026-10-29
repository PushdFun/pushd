// Makes the PUSHD GitHub App from its manifest, so the owner clicks once on GitHub and nothing is typed by hand.
//
//   npx tsx scripts/github-app.ts                    the app on the signed-in GitHub account (sign in as PushdFun first)
//   npx tsx scripts/github-app.ts --org PushdFun     the app on an organization instead
//   npx tsx scripts/github-app.ts --print            only print the manifest
//
// It opens a page on this Mac (127.0.0.1) with one button. The button sends the manifest to GitHub; GitHub shows the
// app's name, permissions (contents, pull requests and issues to read and write, metadata to read; no workflows, no
// administration) and events, and asks to create it. GitHub then sends the browser back here with a one-time code, which
// this script swaps for the app's settings. They are written to ~/.pushd-github-app.env (only you can read it) and never
// printed: put each line in the engine's secret settings on the host, then delete the file.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { appManifest } from "../src/agents/github-app.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const site = (process.env.PUSHD_SITE_URL ?? "https://pushd.fun").replace(/\/+$/, "");
const org = arg("org");
const port = Number(process.env.PORT ?? 3709);
const out = join(homedir(), ".pushd-github-app.env");
const state = randomBytes(16).toString("hex");
const manifest = appManifest({ siteUrl: site, redirectUrl: `http://127.0.0.1:${port}/done` });

if (process.argv.includes("--print")) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}
if (org !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new Error("--org takes an organization's name");
if (existsSync(out)) throw new Error(`${out} already exists. Move it away first, so a second app's settings never overwrite the first's.`);

const target = org ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = `<!doctype html><meta charset="utf-8"><title>Make the PUSHD GitHub App</title>
<body style="font:15px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1>Make the PUSHD GitHub App</h1>
<p>Signed in on GitHub as ${org ? `an owner of <b>${esc(org)}</b>` : "<b>PushdFun</b>"}? Press the button. GitHub shows the app and asks you to create it.</p>
<pre style="background:#f4f4f4;padding:12px;overflow:auto">${esc(JSON.stringify(manifest, null, 2))}</pre>
<form action="${esc(target)}" method="post"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button style="font-size:16px;padding:10px 18px">Create the app on GitHub</button></form>
</body>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  if (u.pathname !== "/done") {
    res.writeHead(404);
    return res.end();
  }
  const code = u.searchParams.get("code") ?? "";
  if (u.searchParams.get("state") !== state || !/^[A-Za-z0-9_-]{8,100}$/.test(code)) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("That answer is not from this run. Start the script again.");
  }
  const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "pushd-agents" } });
  const j = (await r.json().catch(() => null)) as { id?: number; slug?: string; pem?: string; webhook_secret?: string; client_id?: string; client_secret?: string } | null;
  if (r.status !== 201 || !j?.id || !j.pem || !j.webhook_secret || !j.client_id || !j.client_secret || !j.slug) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`GitHub answered ${r.status}. The app may exist anyway: check https://github.com/settings/apps. Nothing was written.`);
    console.log(`GitHub answered ${r.status}; nothing written.`);
    return void server.close();
  }
  const lines = [
    "# The PUSHD GitHub App's settings for the engine. Secret: put each in the host's secret settings, then delete this file.",
    `PUSHD_GH_APP_ID=${j.id}`,
    `PUSHD_GH_APP_SLUG=${j.slug}`,
    `PUSHD_GH_APP_PRIVATE_KEY="${j.pem.trim().replace(/\n/g, "\\n")}"`,
    `PUSHD_GH_APP_WEBHOOK_SECRET=${j.webhook_secret}`,
    `PUSHD_GH_APP_CLIENT_ID=${j.client_id}`,
    `PUSHD_GH_APP_CLIENT_SECRET=${j.client_secret}`,
    "",
  ];
  writeFileSync(out, lines.join("\n"), { mode: 0o600 });
  chmodSync(out, 0o600);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<body style="font:15px/1.5 system-ui;max-width:640px;margin:48px auto"><h1>Done.</h1><p>The app <b>${esc(j.slug)}</b> exists. Its settings are in ${esc(out)}. You can close this tab.</p></body>`);
  console.log(`The app ${j.slug} (id ${j.id}) was made. Its six settings are in ${out} (only you can read it).`);
  console.log("Set them on the engine, set PUSHD_AGENTS=on on the engine and the site, redeploy, then delete the file.");
  server.close();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://127.0.0.1:${port} and press the button (signed in on GitHub as ${org ? `an owner of ${org}` : "PushdFun"}).`);
});
