// A local demo of a signed-in holder, for screenshots of "my scout" before launch. Never for a host.
//   npx tsx scripts/holder-demo.ts [port]      (default 3702)
// It copies the store (data/pushd.sqlite) to a temporary file so the real one is never written, pretends a chain on
// which $PUSHD exists and one throwaway wallet holds 6,000,000 of it, signs that wallet in with a real signature,
// saves two scouts of its own from plain words (the template parser: no model), matches the stored lines against them,
// and serves the feed API on the port. It prints the session for the site's cookie. The token panel still says "soon"
// and paid agent tools stay closed: only holder sign-in is pretended. Ctrl-C stops it and deletes the copy.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/api.ts";
import { config, loadWatchlist } from "../src/config.ts";
import { getItemById, openDb } from "../src/db.ts";
import { Payments } from "../src/agent/payments.ts";
import { ZERO, type TokenReader } from "../src/token/chain.ts";
import { tokenConfigFromEnv, WEI } from "../src/token/config.ts";
import { Holders } from "../src/token/holders.ts";
import type { TokenServices } from "../src/token/local.ts";
import type { TokenPanels } from "../src/token/panel.ts";
import { scoutConfigFromEnv } from "../src/scouts/config.ts";
import { MyScouts } from "../src/scouts/myscouts.ts";
import { templateRule } from "../src/scouts/rules.ts";
import { Scouts } from "../src/scouts/scouts.ts";
import { GitHub } from "../src/github.ts";
import { HolderWatch, watchConfigFromEnv } from "../src/holderwatch.ts";
import { Lookup, lookupConfigFromEnv } from "../src/lookup.ts";
import { rankConfigFromEnv, denied } from "../src/rank/config.ts";
import { Ranker } from "../src/rank/ranker.ts";
import { Registry } from "../src/registry.ts";
import { Suggestions } from "../src/suggest.ts";
import { insertItem } from "../src/db.ts";
import { line } from "../test/scout-helpers.ts";

const port = Number(process.argv[2] ?? 3702);
const dir = mkdtempSync(join(tmpdir(), "pushd-holder-demo-"));
const dbPath = join(dir, "demo.sqlite");
await new Database(config.dbPath, { readonly: true }).backup(dbPath);
const db = openDb(dbPath);
const extrasDb = openDb(join(dir, "extras.sqlite"));
// the live lists from the copied ranking, as the real engine has them
const registry = new Registry(db, loadWatchlist().accounts);
const accounts = registry.known;

const DEMO_TOKEN = "0x00000000000000000000000000000000000d3e70";
const me = privateKeyToAccount(generatePrivateKey());
const reader: TokenReader = {
  chainId: async () => 4663,
  head: async () => 1,
  blockTime: async () => Date.now(),
  pot: async () => ({ token: DEMO_TOKEN, burnCount: 0, totalTokens: ZERO, totalEth: ZERO, lastBurnAt: 0, startedAt: 0, waitingEth: ZERO, waitingTokens: ZERO, nextAt: 0, ready: false }),
  supply: async () => 1_000_000_000n * WEI,
  burnLogs: async () => [],
  balances: async (_t, wallets) => wallets.map((w) => (w.toLowerCase() === me.address.toLowerCase() ? 6_000_000n * WEI : ZERO)),
};
const tc = tokenConfigFromEnv({ PUSHD_SITE_URL: "http://localhost:3710" });
const holders = new Holders({ db, config: tc, reader, tokenAddress: async () => DEMO_TOKEN, handles: () => accounts.map((a) => a.handle) });
const soon = { stage: "soon", token: null, pot: null, explorer: tc.explorer, supply: null, launchSupply: null, burned: null, ethSpent: null, count: 0, latest: [], next: null, lastBurnAt: null, startedAt: null, holderMin: tc.holder.minWhole, readAt: Date.now(), stale: false, problem: null };
const panels = { panel: async () => soon, tokenAddress: async () => null } as unknown as TokenPanels;
const token: TokenServices = { config: tc, reader, panels, holders };

const c = await holders.challenge(me.address);
const s = await holders.signIn(me.address, c.nonce, await me.signMessage({ message: c.message }));

const sc = scoutConfigFromEnv({ ...process.env, PUSHD_OPENROUTER_KEY: "" }, { key: null });
const scouts = new Scouts({ db, accounts, config: sc, provider: null, gh: null });
scouts.catchUp();
let mine: MyScouts | null = null;
const auth = !!config.githubToken;
const rc = rankConfigFromEnv(process.env, auth);
const ranker = new Ranker({ db, config: rc, pool: null, authenticated: auth });
const lookup = new Lookup({ db, gh: new GitHub({ db, token: config.githubToken, part: "lookup", wait: false }), registry, ranker, scouts, rank: rc, searchWatch: () => ({ items: [], builders: [] }), config: lookupConfigFromEnv(process.env, auth) });
const holderWatch = new HolderWatch({ db, config: watchConfigFromEnv(), authenticated: auth, inTop: (l) => registry.inTop(l), account: (l, v) => lookup.account(l, v) });
const suggestions = new Suggestions({ db, inTop: (l) => registry.inTop(l), rankOf: (l) => ranker.rowOf(l)?.rank ?? null, hidden: (l) => denied(rc, l, { privateOnly: true }) });
const server = createApi({
  db,
  accounts,
  top: registry.top,
  ranker,
  lookup,
  holderWatch,
  suggestions,
  adminKey: config.adminKey,
  authenticated: auth,
  publicDelayMinutes: config.publicDelayMinutes,
  liveKey: null,
  mediaDir: config.mediaDir,
  token,
  scouts,
  myScouts: (toItem) => (mine = new MyScouts({ db, accounts, config: sc, provider: null, budget: scouts.budget, toItem, push: null, isHolder: async (a) => (await holders.status(a)).holder, extras: { db: extrasDb, watchers: (l) => holderWatch.watchers(l), accountsOf: (a) => holderWatch.accountsOf(a) } })),
  agent: { payments: new Payments({ db, chain: { tx: async () => null }, payTo: null, switchOn: false, maxAgeMs: 1 }), config: sc.agent, siteUrl: "http://localhost:3710" },
});
const my = mine as unknown as MyScouts;
for (const [name, text] of [
  ["Solana founders", "new repos from Solana founders"],
  ["Paradigm agents", "anything from Paradigm about agents or swift"],
]) {
  const rule = templateRule(text, accounts).rule;
  my.save(me.address, 6_000_000n * WEI, { name, text, rule });
}
for (const r of db.prepare("SELECT id FROM items ORDER BY seq").all() as { id: string }[]) {
  const it = getItemById(db, r.id);
  if (it) await my.matchItem(it);
}
// the demo holder watches two accounts by hand (any account works: they are read from GitHub through the lookup),
// and one of them has a line in the extras store, so the inbox shows a watched account's hit
for (const login of (process.env.PUSHD_DEMO_WATCH ?? "gakonst,karpathy").split(",")) {
  try {
    await holderWatch.add(me.address, 6_000_000n * WEI, login, "demo");
  } catch (e) {
    console.log(`demo watch ${login}: ${(e as Error).message}`);
  }
}
const first = holderWatch.distinct()[0];
if (first) {
  const now = Date.now();
  insertItem(extrasDb, line(now, { id: "demo-watched-line", handle: first.login, group: "oss", kind: "repo", repo: "nanocode-swift", score: 6, heat: "high", summary: "A new repo from an account you watch (demo line).", url: `https://github.com/${first.login}`, githubAt: new Date(now - 20 * 60_000).toISOString(), shownAt: new Date(now - 19 * 60_000).toISOString(), seenAt: new Date(now - 19 * 60_000).toISOString() }));
  my.from(1e12, 0);
  await my.tick();
}
server.listen(port, "127.0.0.1", () => {
  console.log(`holder demo: feed API on http://127.0.0.1:${port}, wallet ${me.address} (pretend chain, 6,000,000 $PUSHD)`);
  console.log(`SESSION=${s.session}`);
});
const stop = () => {
  server.close();
  db.close();
  extrasDb.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
