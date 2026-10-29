// A pretend GitHub for the PUSHD Agents tests: the app's token endpoint, sign-in with GitHub, and a few repos held in
// memory, answered as GitHub's REST API answers them (the shapes the jobs read). Every write is recorded as it was
// asked for, so a test can say exactly what an agent tried to do. Nothing here talks to a network.
import { createHmac, generateKeyPairSync } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb, type DB } from "../src/db.ts";
import { Payments, payMessage, type ChainTx, type PaymentChain } from "../src/agent/payments.ts";
import { buildServices, type BuildServices } from "../src/agents/index.ts";
import type { Outside } from "../src/agents/jobs.ts";
import { tokenServices } from "../src/token/local.ts";
import { FakeModel, type Script } from "./scout-helpers.ts";
import { FakeChain, POT, SPLITTER, tokens } from "./token-helpers.ts";

export const API = "https://gh.test";
export const WEB = "https://ghweb.test";
export const SECRET = "whsec_test_0123456789abcdef";
export const NOW = Date.parse("2026-10-29T13:00:00Z");
export const OWNER = { id: 4242, login: "alice" };
export const sha = (n: number) => n.toString(16).padStart(40, "a");

// one RSA key for every test: the app signs its JWT with it
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
export const APP_KEY = privateKey;

export type FakeRepo = {
  defaultBranch: string;
  private?: boolean;
  /** branch -> path -> text */
  files: Record<string, Record<string, string>>;
  heads: Record<string, string>;
  compare?: { commits: { sha: string; commit: { message: string }; author: { login: string } | null }[]; files: { filename: string; status: string; patch?: string }[] };
  commits?: { sha: string; html_url: string; commit: { message: string; author: { date: string } }; author: { login: string } | null }[];
  labels?: string[];
  issues?: Record<number, { title: string; body: string; user: { login: string } }>;
  pulls?: Record<number, { title: string; body: string; user: { id: number; login: string }; head: { ref: string }; files: { filename: string; status: string; patch?: string }[] }>;
  releases?: { tag_name: string; name: string; draft: boolean; html_url: string; created_at: string }[];
};

export type Write = { method: string; path: string; body: Record<string, unknown> };

export class FakeGitHub {
  repos: Record<string, FakeRepo> = {};
  writes: Write[] = [];
  tokensIssued = 0;
  /** what /user/installations answers at sign-in */
  installations: { id: number; account: { login: string; id: number }; repos: string[] }[] = [];
  user = OWNER;
  private n = 100;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const ok = (status: number, data: unknown) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url.origin === WEB && url.pathname === "/login/oauth/access_token") return ok(200, body.code === "good-code-123" ? { access_token: "ghu_user_token_never_stored" } : { error: "bad_verification_code" });
    if (url.origin !== API) return ok(404, { message: "Not Found" });
    const p = url.pathname;
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
      this.tokensIssued++;
      return ok(201, { token: `ghs_installation_token_${this.tokensIssued}`, expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    if (p === "/user") return ok(200, this.user);
    if (p === "/user/installations") return ok(200, { installations: this.installations.map((i) => ({ id: i.id, account: i.account })) });
    const ui = /^\/user\/installations\/(\d+)\/repositories$/.exec(p);
    if (ui) return ok(200, { repositories: (this.installations.find((i) => i.id === Number(ui[1]))?.repos ?? []).map((full_name) => ({ full_name })) });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return ok(404, { message: "Not Found" });
    const r = this.repos[m[1]];
    if (!r) return ok(404, { message: "Not Found" });
    const rest = m[2] ?? "";
    if (method !== "GET") {
      this.writes.push({ method, path: rest, body });
      return this.write(m[1], r, method, rest, body);
    }
    if (rest === "") return ok(200, { default_branch: r.defaultBranch, private: !!r.private });
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref) return r.heads[decodeURIComponent(ref[1])] ? ok(200, { object: { sha: r.heads[decodeURIComponent(ref[1])] } }) : ok(404, {});
    const ct = /^\/contents\/(.+)$/.exec(rest);
    if (ct) {
      const path = ct[1].split("/").map(decodeURIComponent).join("/");
      const b = url.searchParams.get("ref") ?? r.defaultBranch;
      const text = r.files[b]?.[path];
      return text == null ? ok(404, {}) : ok(200, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: `blob-${path}`, size: text.length });
    }
    if (rest === "/readme") {
      const text = r.files[r.defaultBranch]?.["README.md"];
      return text == null ? ok(404, {}) : ok(200, { encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length });
    }
    if (/^\/git\/trees\//.test(rest)) return ok(200, { tree: Object.keys(r.files[r.defaultBranch] ?? {}).map((path) => ({ path, type: "blob" })) });
    if (/^\/compare\//.test(rest)) return ok(200, r.compare ?? { commits: [], files: [] });
    const one = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (one) return ok(200, { commit: { message: r.compare?.commits.at(-1)?.commit.message ?? "a commit" }, files: r.compare?.files ?? [] });
    if (rest === "/commits") return ok(200, r.commits ?? []);
    if (rest === "/pulls") return ok(200, []);
    if (rest === "/releases") return ok(200, r.releases ?? []);
    if (rest === "/labels") return ok(200, (r.labels ?? []).map((name) => ({ name })));
    const pull = /^\/pulls\/(\d+)(\/files)?$/.exec(rest);
    if (pull) {
      const x = r.pulls?.[Number(pull[1])];
      if (!x) return ok(404, {});
      return pull[2] ? ok(200, x.files) : ok(200, { number: Number(pull[1]), title: x.title, body: x.body, user: x.user, html_url: `https://github.com/${m[1]}/pull/${pull[1]}`, head: x.head, state: "open" });
    }
    const iss = /^\/issues\/(\d+)$/.exec(rest);
    if (iss) {
      const x = r.issues?.[Number(iss[1])];
      return x ? ok(200, { number: Number(iss[1]), title: x.title, body: x.body, user: x.user, html_url: `https://github.com/${m[1]}/issues/${iss[1]}` }) : ok(404, {});
    }
    return ok(404, { message: "Not Found" });
  }) as typeof fetch;

  private write(full: string, r: FakeRepo, method: string, rest: string, body: Record<string, unknown>) {
    const ok = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && rest === "/git/refs") {
      r.heads[String(body.ref).replace("refs/heads/", "")] = String(body.sha);
      r.files[String(body.ref).replace("refs/heads/", "")] = { ...(r.files[r.defaultBranch] ?? {}) };
      return ok(201, { ref: body.ref });
    }
    const ct = /^\/contents\/(.+)$/.exec(rest);
    if (method === "PUT" && ct) {
      const b = String(body.branch);
      (r.files[b] ??= {})[decodeURIComponent(ct[1])] = Buffer.from(String(body.content), "base64").toString("utf8");
      const c = sha(++this.n);
      r.heads[b] = c;
      return ok(200, { commit: { sha: c, html_url: `https://github.com/${full}/commit/${c}` } });
    }
    if (method === "POST" && rest === "/pulls") return ok(201, { number: ++this.n, html_url: `https://github.com/${full}/pull/${this.n}` });
    if (method === "POST" && /\/comments$/.test(rest)) return ok(201, { html_url: `https://github.com/${full}/issues/1#issuecomment-${++this.n}` });
    if (method === "POST" && /\/labels$/.test(rest)) return ok(200, []);
    if (method === "POST" && rest === "/releases") return ok(201, { id: ++this.n, html_url: `https://github.com/${full}/releases/tag/${body.tag_name}` });
    if (method === "PUT" && /\/merge$/.test(rest)) return ok(200, { sha: sha(++this.n), merged: true });
    return ok(404, {});
  }

  /** One repo with a default branch, a README and a package.json. */
  addRepo(full: string, p: Partial<FakeRepo> = {}) {
    this.repos[full] = { defaultBranch: "main", heads: { main: sha(1) }, files: { main: { "README.md": "# Thing\n\nRun `npm start`.\n", "package.json": '{"name":"thing","scripts":{"start":"node ."}}', "src/index.js": "console.log(1)\n" } }, ...p };
    return this.repos[full];
  }
}

/** A pretend chain for payments: transactions put in by the test. */
export class PayChain implements PaymentChain {
  txs = new Map<string, ChainTx>();
  async tx(h: string) {
    return this.txs.get(h.toLowerCase()) ?? null;
  }
}

export const signDelivery = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export const APP_ENV: Record<string, string> = {
  PUSHD_AGENTS: "on",
  PUSHD_GH_APP_ID: "123456",
  PUSHD_GH_APP_SLUG: "pushd-agents",
  PUSHD_GH_APP_PRIVATE_KEY: APP_KEY.replace(/\n/g, "\\n"),
  PUSHD_GH_APP_WEBHOOK_SECRET: SECRET,
  PUSHD_GH_APP_CLIENT_ID: "Iv1.0123456789abcdef",
  PUSHD_GH_APP_CLIENT_SECRET: "client_secret_0123456789abcdef",
};

export type World = {
  db: DB;
  gh: FakeGitHub;
  chain: FakeChain;
  pay: PayChain;
  model: FakeModel;
  build: BuildServices;
  clock: { t: number };
  outside: Outside & { calls: string[] };
  /** a signed-in owner with the app installed on alice/thing */
  owner: () => Promise<string>;
};

/** Everything wired as the engine wires it, on pretend GitHub, chain and model. `launched`: $PUSHD exists. */
export function world(o: { env?: Record<string, string>; script?: Script; launched?: boolean; payTo?: string | null } = {}): World {
  const db = openDb(":memory:");
  const gh = new FakeGitHub();
  gh.addRepo("alice/thing");
  gh.installations = [{ id: 77, account: { login: "alice", id: OWNER.id }, repos: ["alice/thing"] }];
  const chain = new FakeChain();
  if (o.launched) chain.launch();
  const clock = { t: NOW };
  const token = tokenServices({ db, handles: [], env: { PUSHD_BURN_POT_ADDRESS: POT, PUSHD_SPLITTER_ADDRESS: SPLITTER, PUSHD_BURN_POT_BLOCK: "1000" }, reader: chain, now: () => clock.t });
  const pay = new PayChain();
  const payments = new Payments({ db, chain: pay, payTo: o.payTo === undefined ? POT : o.payTo, switchOn: true, maxAgeMs: 30 * 60_000, now: () => clock.t });
  const model = new FakeModel(o.script ?? (() => JSON.stringify({ notes: "- Added a thing", changelog_line: "Added a thing", post: "Shipped a thing in thing.", injection: false })));
  const calls: string[] = [];
  const outside = {
    calls,
    async vulns(q: { name: string }[]) {
      calls.push("osv");
      return q.map((x) => (x.name === "lodash" ? ["GHSA-test-0001"] : []));
    },
    async npmLatest(name: string) {
      calls.push(`npm:${name}`);
      return name === "lodash" ? "4.17.21" : name === "left-pad" ? "9.0.0" : null;
    },
  };
  const build = buildServices({ db, token, payments, provider: model, push: null, trustProxy: false, env: { ...APP_ENV, ...(o.env ?? {}) }, fetchImpl: gh.fetch, outside, ghApi: API, ghWeb: WEB, now: () => clock.t, start: false })!;
  const owner = async () => (await build.agents.signIn("good-code-123", "https://pushd.fun/api/build/github/callback", "test")).session;
  return { db, gh, chain, pay, model, build, clock, outside, owner };
}

/** A wallet holding `whole` $PUSHD with a holder session on the token side, linked to the owner's GitHub account. */
export async function holderWallet(w: World, whole: number): Promise<string> {
  const acct = privateKeyToAccount(generatePrivateKey());
  w.chain.bal.set(acct.address.toLowerCase(), tokens(whole));
  w.db.prepare("UPDATE gh_users SET wallet = ? WHERE id = ?").run(acct.address.toLowerCase(), OWNER.id);
  return acct.address.toLowerCase();
}

/** A payer: a fresh key, its transfer to `to` on the pretend chain, and the signed proof. */
export async function payment(w: World, value: bigint, to = POT, n = 1) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const tx = `0x${n.toString(16).padStart(64, "b")}`;
  w.pay.txs.set(tx, { hash: tx, from: acct.address, to, value, chainId: 4663, blockNumber: 10, status: "success", timestamp: w.clock.t - 60_000 });
  return { tx, signature: await acct.signMessage({ message: payMessage(tx) }) };
}
