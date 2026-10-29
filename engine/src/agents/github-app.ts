// The PUSHD GitHub App, from PUSHD's side: one app (owned by the PushdFun account) with contents, pull requests and
// issues to read and write, metadata to read, and nothing else: no workflows, no administration. People install it on
// the repos they pick; an agent can only ever reach those.
//
//   - The app signs a short JWT with its private key (RS256, 9 minutes) only to ask GitHub for an installation token.
//     Installation tokens live about an hour; each is asked for one repo only, kept in memory until five minutes before
//     it runs out, and never written, logged or put in an error.
//   - Sign-in with GitHub is the same app's user-to-server OAuth: the code is swapped for a user token once, used to read
//     who the person is and which of their installations and repos they can reach, then dropped. It is never stored.
//   - Webhook deliveries are checked against the webhook secret (HMAC SHA-256, constant time) before anything is read.
//
// Every write an agent makes passes assertSafeWrite(): only the few calls the jobs need, only on a branch named
// pushd/..., never the default branch, never a file under .github/ (workflows least of all), releases only as drafts,
// and a merge only in a scout's own repo with automerge switched on. GitHub enforces the app's permissions on top.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export const API = "https://api.github.com";
export const WEB = "https://github.com";

/** The permissions the app asks for when it is made and the ones each installation token is limited to. */
export const APP_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", metadata: "read" } as const;
export const APP_EVENTS = ["push", "pull_request", "issues"] as const;

/** Branches an agent writes to start with this; nothing else is ever written to. */
export const BRANCH_PREFIX = "pushd/";

export class GhAppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The app's JWT: RS256, issued a minute back (clock drift), good for 9 minutes. */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** A webhook delivery's signature (X-Hub-Signature-256) against the raw body. Constant time; false on anything odd. */
export function verifyWebhook(secret: string | null, raw: Buffer, header: string | null | undefined): boolean {
  if (!secret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** owner/name, checked. */
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const isRepo = (v: unknown): v is string => typeof v === "string" && REPO_RE.test(v) && !v.includes("..");

/** A path inside a repo an agent may write: relative, no "..", no .github/ at all, no hidden git internals. */
export function safePath(p: unknown): string {
  if (typeof p !== "string") throw new GhAppError(400, "A file path is not text.");
  const s = p.trim().replace(/^\.\/+/, "");
  if (!s || s.length > 200 || /[\0\r\n\\]/.test(s) || s.startsWith("/") || s.split("/").some((x) => x === ".." || x === "." || x === "")) throw new GhAppError(400, `The path ${s.slice(0, 60)} is not allowed.`);
  if (/^\.github(\/|$)/i.test(s)) throw new GhAppError(403, "Agents never touch .github/ (workflows least of all).");
  if (/^\.git(\/|$)/i.test(s)) throw new GhAppError(403, "Agents never touch .git/.");
  return s;
}

/** A branch an agent may write to: pushd/... and never the default branch. */
export function safeBranch(name: unknown, defaultBranch: string): string {
  if (typeof name !== "string" || !name.startsWith(BRANCH_PREFIX) || !/^pushd\/[A-Za-z0-9._/-]{1,80}$/.test(name) || name.includes("..") || name.endsWith("/")) throw new GhAppError(403, "Agents write only to new pushd/ branches.");
  if (name === defaultBranch || name === `refs/heads/${defaultBranch}`) throw new GhAppError(403, "Agents never push to the default branch.");
  return name;
}

/**
 * The one gate every write goes through. `path` is the API path after /repos/<owner>/<name>. Throws on anything that
 * is not one of the calls the jobs make, with the arguments they may have.
 */
export function assertSafeWrite(method: string, path: string, body: Record<string, unknown> | null, o: { defaultBranch: string; allowMerge: boolean }): void {
  const refuse = (why: string) => {
    throw new GhAppError(403, why);
  };
  if (method === "POST" && path === "/git/refs") {
    const ref = String(body?.ref ?? "");
    if (!ref.startsWith("refs/heads/")) refuse("Only branches are made.");
    safeBranch(ref.slice("refs/heads/".length), o.defaultBranch);
    return;
  }
  const contents = /^\/contents\/(.+)$/.exec(path);
  if (method === "PUT" && contents) {
    safePath(decodeURIComponent(contents[1]));
    safeBranch(body?.branch, o.defaultBranch);
    return;
  }
  if (method === "POST" && path === "/pulls") {
    safeBranch(body?.head, o.defaultBranch);
    if (body?.base !== o.defaultBranch) refuse("A pull request goes to the default branch only.");
    return;
  }
  if (method === "POST" && /^\/issues\/\d{1,9}\/comments$/.test(path)) return;
  if (method === "POST" && /^\/issues\/\d{1,9}\/labels$/.test(path)) {
    if (!Array.isArray(body?.labels) || (body!.labels as unknown[]).length > 5) refuse("At most five labels.");
    return;
  }
  if (method === "POST" && path === "/releases") {
    if (body?.draft !== true) refuse("Releases are made as drafts only; the owner publishes them.");
    return;
  }
  if (method === "PUT" && /^\/pulls\/\d{1,9}\/merge$/.test(path)) {
    if (!o.allowMerge) refuse("Agents never merge.");
    return;
  }
  refuse(`${method} ${path.replace(/\d+/g, "n").slice(0, 60)} is not something an agent may do.`);
}

export type FetchLike = typeof fetch;

export type InstallationInfo = { id: number; account: string; accountId: number; repos: string[] };
export type SignedInUser = { id: number; login: string; installations: InstallationInfo[] };

export type AppDeps = {
  appId: string;
  privateKey: string;
  clientId: string | null;
  clientSecret: string | null;
  slug: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** GitHub's addresses; the tests point them at a pretend GitHub */
  api?: string;
  web?: string;
};

const errText = (status: number) => (status === 404 ? "GitHub answered 404 (not found, or the app cannot see it)" : status === 401 || status === 403 ? `GitHub refused (${status})` : `GitHub answered ${status}`);

export class GitHubApp {
  private readonly tokens = new Map<string, { token: string; until: number }>();
  private readonly f: FetchLike;
  private readonly api: string;
  private readonly web: string;

  constructor(private readonly d: AppDeps) {
    this.f = d.fetchImpl ?? fetch;
    this.api = d.api ?? API;
    this.web = d.web ?? WEB;
  }

  private now = () => (this.d.now ?? Date.now)();

  get installUrl(): string | null {
    return this.d.slug ? `${this.web}/apps/${this.d.slug}/installations/new` : null;
  }

  /** Where "Sign in with GitHub" sends the browser. */
  authorizeUrl(state: string, redirectUri: string): string | null {
    if (!this.d.clientId) return null;
    const u = new URL(`${this.web}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.d.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "true");
    return u.toString();
  }

  private async call<T>(method: string, url: string, auth: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers: { authorization: auth, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "pushd-agents", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GhAppError(503, "GitHub did not answer.");
    }
    const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
    return { status: res.status, data };
  }

  /** A token for one installation, limited to one repo and the app's permissions. Cached in memory only. */
  async installationToken(installationId: number, repoName: string): Promise<string> {
    const k = `${installationId}:${repoName.toLowerCase()}`;
    const c = this.tokens.get(k);
    if (c && c.until > this.now() + 5 * 60_000) return c.token;
    const r = await this.call<{ token?: string; expires_at?: string }>("POST", `${this.api}/app/installations/${installationId}/access_tokens`, `Bearer ${appJwt(this.d.appId, this.d.privateKey, this.now())}`, {
      repositories: [repoName],
      permissions: APP_PERMISSIONS,
    });
    if (r.status !== 201 || typeof r.data?.token !== "string") throw new GhAppError(r.status === 404 ? 404 : 502, `No installation token: ${errText(r.status)}.`);
    const until = Date.parse(r.data.expires_at ?? "") || this.now() + 50 * 60_000;
    this.tokens.set(k, { token: r.data.token, until });
    return r.data.token;
  }

  forget(installationId: number) {
    for (const k of [...this.tokens.keys()]) if (k.startsWith(`${installationId}:`)) this.tokens.delete(k);
  }

  /** The app's view of one installation's repos (for a webhook that only says "added"). */
  async installationRepos(installationId: number): Promise<string[]> {
    const r = await this.call<{ repositories?: { full_name: string }[] }>("GET", `${this.api}/app/installations/${installationId}`, `Bearer ${appJwt(this.d.appId, this.d.privateKey, this.now())}`);
    if (r.status !== 200) throw new GhAppError(502, errText(r.status));
    return (r.data?.repositories ?? []).map((x) => x.full_name);
  }

  /**
   * Sign-in: the OAuth code to a user token, used here and dropped. Answers who signed in and which of the app's
   * installations (and repos in them) that person can reach.
   */
  async signIn(code: string, redirectUri: string): Promise<SignedInUser> {
    if (!this.d.clientId || !this.d.clientSecret) throw new GhAppError(409, "Sign-in with GitHub is not set up yet.");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(code)) throw new GhAppError(400, "That sign-in code is not valid. Start again.");
    let res: Response;
    try {
      res = await this.f(`${this.web}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "pushd-agents" },
        body: JSON.stringify({ client_id: this.d.clientId, client_secret: this.d.clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GhAppError(503, "GitHub did not answer.");
    }
    const j = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
    const token = j?.access_token;
    if (!res.ok || typeof token !== "string") throw new GhAppError(401, "GitHub did not accept the sign-in. Start again.");
    const auth = `Bearer ${token}`;
    const me = await this.call<{ id?: number; login?: string }>("GET", `${this.api}/user`, auth);
    if (me.status !== 200 || typeof me.data?.id !== "number" || typeof me.data.login !== "string") throw new GhAppError(502, "GitHub did not say who signed in.");
    const inst = await this.call<{ installations?: { id: number; account?: { login?: string; id?: number } }[] }>("GET", `${this.api}/user/installations?per_page=100`, auth);
    const installations: InstallationInfo[] = [];
    for (const i of (inst.data?.installations ?? []).slice(0, 20)) {
      const repos: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const r = await this.call<{ repositories?: { full_name: string }[] }>("GET", `${this.api}/user/installations/${i.id}/repositories?per_page=100&page=${page}`, auth);
        const list = r.data?.repositories ?? [];
        repos.push(...list.map((x) => x.full_name).filter(isRepo));
        if (list.length < 100) break;
      }
      installations.push({ id: i.id, account: i.account?.login ?? "", accountId: i.account?.id ?? 0, repos });
    }
    return { id: me.data.id, login: me.data.login, installations };
  }

  /** A client for one repo of one installation. */
  repo(installationId: number, fullName: string, o: { allowMerge?: boolean } = {}): RepoClient {
    if (!isRepo(fullName)) throw new GhAppError(400, "That is not a repo.");
    return new RepoClient(fullName, (method, path, body) => this.repoCall(installationId, fullName, method, path, body), o.allowMerge ?? false);
  }

  private async repoCall(installationId: number, fullName: string, method: string, path: string, body?: unknown) {
    const token = await this.installationToken(installationId, fullName.split("/")[1]);
    return this.call<unknown>(method, `${this.api}/repos/${fullName}${path}`, `token ${token}`, body);
  }
}

/** The manifest the owner's one click on GitHub makes the app from (engine/scripts/github-app.ts). */
export function appManifest(o: { siteUrl: string; redirectUrl: string; name?: string }) {
  const site = o.siteUrl.replace(/\/+$/, "");
  return {
    name: o.name ?? "PUSHD Agents",
    url: `${site}/build`,
    description: "Your own agent that helps you ship: release notes, a post about what shipped, a key check on each push, pull requests on request. It works only on the repos you pick, and only through pull requests.",
    hook_attributes: { url: `${site}/api/build/github/webhook`, active: true },
    redirect_url: o.redirectUrl,
    callback_urls: [`${site}/api/build/github/callback`],
    setup_url: `${site}/build?installed=1`,
    setup_on_update: true,
    public: true,
    request_oauth_on_install: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [...APP_EVENTS],
  };
}

export type RepoFile = { path: string; text: string; sha: string; size: number };

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

/**
 * One repo, through one installation token. Reads return plain shapes and stay within size limits; writes go through
 * assertSafeWrite. Nothing here takes a URL, a token or a permission from a model: the jobs pass paths they built.
 */
export class RepoClient {
  private info: { defaultBranch: string; private: boolean } | null = null;

  constructor(
    readonly fullName: string,
    private readonly call: Call,
    private readonly allowMerge: boolean,
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    const r = await this.call("GET", path);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new GhAppError(502, errText(r.status));
    return r.data as T;
  }

  private async write<T>(method: string, path: string, body: Record<string, unknown>): Promise<T> {
    assertSafeWrite(method, path, body, { defaultBranch: await this.defaultBranch(), allowMerge: this.allowMerge });
    const r = await this.call(method, path, body);
    if (r.status < 200 || r.status > 299) throw new GhAppError(r.status === 422 ? 422 : 502, `${errText(r.status)} to ${method} ${path.replace(/\/contents\/.*/, "/contents").replace(/\d+/g, "n")}`);
    return r.data as T;
  }

  async meta(): Promise<{ defaultBranch: string; private: boolean }> {
    if (this.info) return this.info;
    const r = await this.get<{ default_branch?: string; private?: boolean }>("");
    if (!r || typeof r.default_branch !== "string") throw new GhAppError(404, "The repo is not reachable through the app.");
    this.info = { defaultBranch: r.default_branch, private: !!r.private };
    return this.info;
  }

  async defaultBranch(): Promise<string> {
    return (await this.meta()).defaultBranch;
  }

  async headSha(branch?: string): Promise<string> {
    const b = branch ?? (await this.defaultBranch());
    const r = await this.get<{ object?: { sha?: string } }>(`/git/ref/heads/${encodeURIComponent(b)}`);
    if (!r?.object?.sha) throw new GhAppError(404, "No such branch.");
    return r.object.sha;
  }

  /** A text file, at most `max` bytes; null when it is not there, too big or not text. */
  async file(path: string, o: { ref?: string; max?: number } = {}): Promise<RepoFile | null> {
    const p = path.replace(/^\/+/, "");
    const r = await this.get<{ type?: string; content?: string; encoding?: string; sha?: string; size?: number }>(`/contents/${p.split("/").map(encodeURIComponent).join("/")}${o.ref ? `?ref=${encodeURIComponent(o.ref)}` : ""}`);
    if (!r || r.type !== "file" || r.encoding !== "base64" || typeof r.content !== "string" || (r.size ?? 0) > (o.max ?? 60_000)) return null;
    const text = Buffer.from(r.content, "base64").toString("utf8");
    if (text.includes("\0")) return null;
    return { path: p, text, sha: r.sha ?? "", size: r.size ?? text.length };
  }

  async readme(): Promise<string | null> {
    const r = await this.get<{ content?: string; encoding?: string; size?: number }>("/readme");
    if (!r || r.encoding !== "base64" || typeof r.content !== "string" || (r.size ?? 0) > 120_000) return null;
    return Buffer.from(r.content, "base64").toString("utf8");
  }

  /** The default branch's file paths (blobs), at most `max`. */
  async tree(max = 800): Promise<string[]> {
    const sha = await this.headSha();
    const r = await this.get<{ tree?: { path: string; type: string }[] }>(`/git/trees/${sha}?recursive=1`);
    return (r?.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path).slice(0, max);
  }

  /** What changed between two commits: the commits and the files with their patches. */
  async compare(base: string, head: string): Promise<{ commits: { sha: string; message: string; author: string | null }[]; files: { filename: string; status: string; patch: string | null }[] }> {
    // commits or tags, never anything with ".." in it
    const ok = (x: string) => /^[A-Za-z0-9._/-]{1,100}$/.test(x) && !x.includes("..");
    if (!ok(base) || !ok(head)) throw new GhAppError(400, "Not commits.");
    const r = await this.get<{ commits?: { sha: string; commit?: { message?: string }; author?: { login?: string } | null }[]; files?: { filename: string; status: string; patch?: string }[] }>(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return {
      commits: (r?.commits ?? []).slice(-50).map((c) => ({ sha: c.sha, message: c.commit?.message ?? "", author: c.author?.login ?? null })),
      files: (r?.files ?? []).slice(0, 100).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch ? f.patch.slice(0, 20_000) : null })),
    };
  }

  /** One commit's files (a push of a single new commit, or a first push). */
  async commit(sha: string): Promise<{ message: string; files: { filename: string; status: string; patch: string | null }[] } | null> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new GhAppError(400, "Not a commit.");
    const r = await this.get<{ commit?: { message?: string }; files?: { filename: string; status: string; patch?: string }[] }>(`/commits/${sha}`);
    if (!r) return null;
    return { message: r.commit?.message ?? "", files: (r.files ?? []).slice(0, 100).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch ? f.patch.slice(0, 20_000) : null })) };
  }

  async commitsSince(sinceIso: string, max = 60): Promise<{ sha: string; message: string; author: string | null; at: string; url: string }[]> {
    const r = await this.get<{ sha: string; html_url: string; commit?: { message?: string; author?: { date?: string } }; author?: { login?: string } | null }[]>(`/commits?since=${encodeURIComponent(sinceIso)}&per_page=${Math.min(100, max)}`);
    return (r ?? []).slice(0, max).map((c) => ({ sha: c.sha, message: c.commit?.message ?? "", author: c.author?.login ?? null, at: c.commit?.author?.date ?? "", url: c.html_url }));
  }

  async mergedPullsSince(sinceIso: string): Promise<{ number: number; title: string; url: string; mergedAt: string }[]> {
    const r = await this.get<{ number: number; title: string; html_url: string; merged_at: string | null }[]>("/pulls?state=closed&sort=updated&direction=desc&per_page=50");
    return (r ?? []).filter((p) => p.merged_at && p.merged_at >= sinceIso).map((p) => ({ number: p.number, title: p.title, url: p.html_url, mergedAt: p.merged_at! }));
  }

  async releases(): Promise<{ tag: string; name: string; draft: boolean; url: string; at: string }[]> {
    const r = await this.get<{ tag_name: string; name: string | null; draft: boolean; html_url: string; created_at: string }[]>("/releases?per_page=20");
    return (r ?? []).map((x) => ({ tag: x.tag_name, name: x.name ?? x.tag_name, draft: x.draft, url: x.html_url, at: x.created_at }));
  }

  async labels(): Promise<string[]> {
    const r = await this.get<{ name: string }[]>("/labels?per_page=100");
    return (r ?? []).map((l) => l.name).slice(0, 100);
  }

  async pull(n: number): Promise<{ number: number; title: string; body: string; authorId: number | null; author: string | null; url: string; headRef: string; state: string } | null> {
    const r = await this.get<{ number: number; title: string; body: string | null; user?: { id?: number; login?: string }; html_url: string; head?: { ref?: string }; state: string }>(`/pulls/${n}`);
    return r ? { number: r.number, title: r.title, body: r.body ?? "", authorId: r.user?.id ?? null, author: r.user?.login ?? null, url: r.html_url, headRef: r.head?.ref ?? "", state: r.state } : null;
  }

  async pullFiles(n: number): Promise<{ filename: string; status: string; patch: string | null }[]> {
    const r = await this.get<{ filename: string; status: string; patch?: string }[]>(`/pulls/${n}/files?per_page=60`);
    return (r ?? []).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch ? f.patch.slice(0, 12_000) : null }));
  }

  async issue(n: number): Promise<{ number: number; title: string; body: string; author: string | null; url: string; isPull: boolean } | null> {
    const r = await this.get<{ number: number; title: string; body: string | null; user?: { login?: string }; html_url: string; pull_request?: unknown }>(`/issues/${n}`);
    return r ? { number: r.number, title: r.title, body: r.body ?? "", author: r.user?.login ?? null, url: r.html_url, isPull: !!r.pull_request } : null;
  }

  // ---- writes: every one through assertSafeWrite ----

  async createBranch(name: string): Promise<{ branch: string; sha: string }> {
    const sha = await this.headSha();
    await this.write("POST", "/git/refs", { ref: `refs/heads/${name}`, sha });
    return { branch: name, sha };
  }

  /** Writes one file on an agent's branch; answers the new commit's sha and link. */
  async putFile(branch: string, path: string, text: string, message: string): Promise<{ sha: string; url: string }> {
    const p = safePath(path);
    const old = await this.file(p, { ref: branch, max: 1_000_000 }).catch(() => null);
    const r = await this.write<{ commit?: { sha?: string; html_url?: string } }>("PUT", `/contents/${p.split("/").map(encodeURIComponent).join("/")}`, {
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch,
      ...(old?.sha ? { sha: old.sha } : {}),
    });
    return { sha: r.commit?.sha ?? "", url: r.commit?.html_url ?? "" };
  }

  async openPull(branch: string, title: string, body: string): Promise<{ number: number; url: string }> {
    const r = await this.write<{ number: number; html_url: string }>("POST", "/pulls", { title, body, head: branch, base: await this.defaultBranch(), maintainer_can_modify: true });
    return { number: r.number, url: r.html_url };
  }

  async comment(issueOrPull: number, body: string): Promise<{ url: string }> {
    const r = await this.write<{ html_url: string }>("POST", `/issues/${issueOrPull}/comments`, { body });
    return { url: r.html_url };
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    await this.write("POST", `/issues/${issue}/labels`, { labels });
  }

  async draftRelease(tag: string, name: string, body: string): Promise<{ url: string; id: number }> {
    const r = await this.write<{ html_url: string; id: number }>("POST", "/releases", { tag_name: tag, name, body, draft: true, target_commitish: await this.defaultBranch() });
    return { url: r.html_url, id: r.id };
  }

  async merge(n: number, title: string): Promise<{ sha: string }> {
    const r = await this.write<{ sha?: string }>("PUT", `/pulls/${n}/merge`, { merge_method: "squash", commit_title: title });
    return { sha: r.sha ?? "" };
  }
}
