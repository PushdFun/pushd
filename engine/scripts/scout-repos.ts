// Makes the five scouts' own public repos (pushd-scout-claude, -gpt, -grok, -gemini, -deepseek) under the scouts'
// account, each with a README, so their daily builds have somewhere to go (src/agents/scoutbuilds.ts).
//
//   npx tsx scripts/scout-repos.ts                  under PushdFun (PUSHD_SCOUTS_ORG), asks for a token at the prompt
//   npx tsx scripts/scout-repos.ts --org PushdFun   an organization (otherwise the token's own account must be PushdFun)
//   PUSHD_DRY=1 npx tsx scripts/scout-repos.ts      says what it would make and stops before the token
//
// The token is typed at the prompt (nothing shows) and only used here: a classic token with public_repo, or a
// fine-grained one with Administration: write on the account. A repo that already exists is left as it is. Then install
// the PUSHD GitHub App on the five repos (github.com/apps/<slug>/installations/new), and the builds start the next day.
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { SCOUTS } from "../src/scouts/roster.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const org = arg("org") ?? process.env.PUSHD_SCOUTS_ORG?.trim() ?? "PushdFun";
const asOrg = arg("org") !== undefined;
const site = (process.env.PUSHD_SITE_URL ?? "https://pushd.fun").replace(/\/+$/, "");
if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new Error("Not an account name.");

const repos = SCOUTS.map((s) => ({
  name: `pushd-scout-${s.id}`,
  description: `${s.name} builds something small every day from what it watched on PUSHD.`,
  homepage: `${site}/shipped/${org}/pushd-scout-${s.id}`,
}));

for (const r of repos) console.log(`${org}/${r.name}: ${r.description}`);
if (process.env.PUSHD_DRY === "1") {
  console.log("PUSHD_DRY=1: stopped before the token. Nothing was made.");
  process.exit(0);
}

/** A line typed at the prompt with nothing shown. */
function hidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const w = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => (s.includes(q) ? w(s) : undefined);
    rl.question(q, (a) => {
      rl.close();
      stdout.write("\n");
      resolve(a.trim());
    });
  });
}

const token = await hidden("GitHub token (public_repo, or Administration: write): ");
if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error("That does not look like a GitHub token.");
const gh = (method: string, path: string, body?: unknown) =>
  fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pushd-scout-repos", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

if (!asOrg) {
  const me = (await (await gh("GET", "/user")).json()) as { login?: string };
  if (me.login?.toLowerCase() !== org.toLowerCase()) throw new Error(`The token is ${me.login ?? "nobody"}'s, not ${org}'s. Use --org for an organization.`);
}
for (const r of repos) {
  if ((await gh("GET", `/repos/${org}/${r.name}`)).status === 200) {
    console.log(`${org}/${r.name}: already there, left as it is`);
    continue;
  }
  const res = await gh("POST", asOrg ? `/orgs/${org}/repos` : "/user/repos", { ...r, private: false, auto_init: true, has_wiki: false, has_projects: false });
  console.log(`${org}/${r.name}: ${res.status === 201 ? "made" : `GitHub answered ${res.status}`}`);
}
console.log("Next: install the PUSHD GitHub App on these five repos.");
