// The candidate pool: crypto token projects with a public GitHub. Gathered in the deep pass (daily), from:
//   1. DexScreener's latest token profiles and boosts (new tokens and their links),
//   2. CoinGecko's coins in a few categories (pump.fun, Solana memes, AI agents, Base, Robinhood ecosystem, launchpads),
//      each coin's GitHub link and its address per chain,
//   3. GitHub's code search for READMEs that link their own token's DexScreener or pump.fun page,
// then every token's market is read from DexScreener (liquidity, volume, the oldest pair's age, its links), a token
// with no GitHub link has its website read once for one, and each GitHub owner is read through the search API (its
// repos and its commits in the last 30 days). The gates (src/rank/config.ts): real liquidity and volume, a pair older
// than N days, not a giant, not a famous person, and commits in the last 30 days on its own repos (not forks, mirrors,
// templates, tutorials or trading-bot spam). One row per GitHub owner; when several tokens point at one owner, the one
// that trades most is kept.
import type { DB } from "../db.ts";
import type { GitHub } from "../github.ts";
import type { GroupKey } from "../types.ts";
import { addressesIn, campOf, githubLinksIn, githubOwner, repoNoise } from "./classify.ts";
import { denied, deniedRepo, type RankConfig } from "./config.ts";
import { CoinGecko, DexScreener, GECKO_CHAIN, pumpfunLinks, Websites, type TokenMarket } from "./sources.ts";
import { ensureRankSchema, poolRow, type GhRead, type PoolRow } from "./store.ts";

const DAY = 86_400_000;

type Cand = {
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  github: string[];
  websites: string[];
  categories: string[];
  sources: Set<string>;
  description: string | null;
  /** README text that named the address (GitHub code search): the token's symbol must appear in it */
  evidence: string | null;
  evidenceRepo: string | null;
  market?: TokenMarket;
};

export type PoolDeps = {
  db: DB;
  config: RankConfig;
  /** search API client (its own per-minute limit) */
  search: GitHub;
  /** core API client booked to the "rank" share */
  core: GitHub;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  /** may the ranking spend one more core request now (its share of the hour)? */
  coreRoom?: () => boolean;
};

export type DeepResult = { tokens: number; withGithub: number; owners: number; eligible: number; read: number; out: Record<string, number>; ms: number };

const iso = (ms: number) => new Date(ms).toISOString();

export class Pool {
  readonly dex: DexScreener;
  readonly gecko: CoinGecko;
  readonly sites: Websites;
  private readonly searchPace: { last: number };

  constructor(private readonly d: PoolDeps) {
    ensureRankSchema(d.db);
    const sd = { db: d.db, fetchImpl: d.fetchImpl, now: d.now, sleep: d.sleep, log: d.log };
    this.dex = new DexScreener(sd, d.config.sources.dexPerMin);
    this.gecko = new CoinGecko(sd, d.config.sources.geckoPerMin, d.config.sources.geckoDetailsPerDay);
    this.sites = new Websites(sd, d.config.sources.websitesPerDay);
    this.searchPace = { last: 0 };
  }

  private now = () => (this.d.now ?? Date.now)();
  private log = (m: string) => this.d.log?.(`pool: ${m}`);

  /** The search API, paced to the ranking's own per-minute share of it. */
  private async searchGet<T>(path: string) {
    const gap = 60_000 / this.d.config.sources.searchPerMin;
    const wait = this.searchPace.last + gap - this.now();
    if (wait > 0) await (this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(wait);
    this.searchPace.last = this.now();
    return this.d.search.get<T>(path, { conditional: false });
  }

  // ---- 1. gather tokens ----

  private add(map: Map<string, Cand>, c: Omit<Cand, "sources"> & { source: string }) {
    const k = `${c.chain}:${c.address.toLowerCase()}`;
    const have = map.get(k);
    if (have) {
      have.github.push(...c.github.filter((g) => !have.github.includes(g)));
      have.websites.push(...c.websites.filter((g) => !have.websites.includes(g)));
      have.categories.push(...c.categories.filter((g) => !have.categories.includes(g)));
      have.sources.add(c.source);
      have.symbol ??= c.symbol;
      have.name ??= c.name;
      have.description ??= c.description;
      if (c.evidence && !have.evidence) {
        have.evidence = c.evidence;
        have.evidenceRepo = c.evidenceRepo;
      }
      return;
    }
    const { source, ...rest } = c;
    map.set(k, { ...rest, sources: new Set([source]) });
  }

  async gather(): Promise<Map<string, Cand>> {
    const c = this.d.config;
    const map = new Map<string, Cand>();
    // DexScreener: the newest profiles and boosts
    for (const p of await this.dex.discover(c.pool.chains)) {
      const urls = (p.links ?? []).map((l) => l.url).filter(Boolean);
      this.add(map, { chain: p.chainId, address: p.tokenAddress, symbol: null, name: null, github: urls.filter((u) => githubOwner(u)), websites: urls.filter((u) => !githubOwner(u)), categories: [], description: p.description ?? null, evidence: null, evidenceRepo: null, source: "dexscreener" });
    }
    // DexScreener's search: pairs for a few words of the space, with the links each token lists
    for (const q of c.sources.dexSearch) {
      for (const p of await this.dex.search(q)) {
        if (!c.pool.chains.includes(p.chainId) || !p.baseToken?.address) continue;
        const urls = [...(p.info?.websites ?? []), ...(p.info?.socials ?? [])].map((l) => l.url).filter(Boolean);
        this.add(map, { chain: p.chainId, address: p.baseToken.address, symbol: p.baseToken.symbol ?? null, name: p.baseToken.name ?? null, github: urls.filter((u) => githubOwner(u)), websites: urls.filter((u) => !githubOwner(u)), categories: [], description: null, evidence: null, evidenceRepo: null, source: "dexscreener" });
      }
    }
    this.log(`dexscreener profiles, boosts and search: ${map.size} token(s)`);
    // CoinGecko: categories by volume, then each coin's links
    const seen = new Set<string>();
    const coins: { id: string; volume: number; cats: string[] }[] = [];
    for (const cat of c.pool.geckoCategories) {
      for (const m of await this.gecko.category(cat)) {
        if ((m.total_volume ?? 0) < c.pool.minVolumeUsd || (m.market_cap ?? 0) > c.pool.maxMcapUsd) continue;
        const have = coins.find((x) => x.id === m.id);
        if (have) have.cats.push(cat);
        else coins.push({ id: m.id, volume: m.total_volume ?? 0, cats: [cat] });
      }
    }
    coins.sort((a, b) => b.volume - a.volume);
    // every coin's addresses in one call: a coin whose page is not read yet still gets its tokens in (its GitHub link
    // then comes from the DEX listing or its website)
    const platforms = await this.gecko.platforms();
    let details = 0;
    for (const coin of coins) {
      if (seen.has(coin.id)) continue;
      seen.add(coin.id);
      const g = (await this.gecko.coin(coin.id)) ?? (platforms.get(coin.id) ? { id: coin.id, symbol: platforms.get(coin.id)!.symbol, name: platforms.get(coin.id)!.name, platforms: platforms.get(coin.id)!.platforms, categories: coin.cats } : null);
      if (!g) continue;
      details++;
      const github = (g.links?.repos_url?.github ?? []).filter((u) => typeof u === "string" && githubOwner(u));
      const websites = (g.links?.homepage ?? []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
      for (const [plat, addr] of Object.entries(g.platforms ?? {})) {
        const chain = GECKO_CHAIN[plat];
        if (!chain || !addr || !c.pool.chains.includes(chain)) continue;
        this.add(map, { chain, address: addr, symbol: g.symbol?.toUpperCase() ?? null, name: g.name ?? null, github, websites, categories: [...new Set([...(g.categories ?? []), ...coin.cats])], description: g.description?.en?.slice(0, 400) ?? null, evidence: null, evidenceRepo: null, source: "coingecko" });
      }
    }
    this.log(`coingecko: ${coins.length} coin(s) over the volume floor, ${details} coin page(s) read or kept`);
    // GitHub code search: READMEs that link their token's page
    const queries: [string, string | null][] = [
      ['"dexscreener.com/solana/" filename:README.md', "solana"],
      ['"pump.fun/coin/" filename:README.md', "solana"],
      ['"dexscreener.com/base/" filename:README.md', "base"],
      ['"dexscreener.com/robinhood/" filename:README.md', "robinhood"],
      ['"birdeye.so/token/" filename:README.md', "solana"],
      ['"solscan.io/token/" filename:README.md', "solana"],
      ['"basescan.org/token/" filename:README.md', "base"],
      ['"contract address" pump filename:README.md', "solana"],
    ];
    let found = 0;
    for (const [q, chain] of queries) {
      for (let page = 1; page <= c.sources.codeSearchPages; page++) {
        const r = await this.d.search.get<{ items?: { repository: { full_name: string; fork: boolean; description: string | null; owner: { login: string } }; text_matches?: { fragment: string }[] }[] }>(
          `/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
          { conditional: false },
        );
        const items = r.data?.items ?? [];
        for (const it of items) {
          const repo = it.repository;
          if (repo.fork || repoNoise({ name: repo.full_name.split("/")[1], description: repo.description, fork: false })) continue;
          const text = (it.text_matches ?? []).map((m) => m.fragment).join("\n");
          const addrs = addressesIn(text);
          if (!addrs.length || addrs.length > 3) continue;
          for (const a of addrs) {
            const ch = a.kind === "solana" ? "solana" : (chain ?? "base");
            if (a.kind === "evm" && ch === "solana") continue;
            this.add(map, { chain: ch, address: a.address, symbol: null, name: null, github: [`https://github.com/${repo.full_name}`], websites: [], categories: [], description: repo.description, evidence: `${repo.full_name}\n${repo.description ?? ""}\n${text}`, evidenceRepo: repo.full_name, source: "github-readme" });
            found++;
          }
        }
        if (items.length < 100) break;
      }
    }
    this.log(`github code search: ${found} token link(s) in READMEs`);
    return map;
  }

  // ---- 2. markets, links, owners ----

  private tokenGate(m: TokenMarket): string | null {
    const p = this.d.config.pool;
    if (m.liquidityUsd < p.minLiquidityUsd) return `liquidity under $${p.minLiquidityUsd.toLocaleString("en-US")}`;
    if (m.volumeUsd < p.minVolumeUsd) return `daily volume under $${p.minVolumeUsd.toLocaleString("en-US")}`;
    if (!m.pairCreatedAt || this.now() - m.pairCreatedAt < p.minPairDays * DAY) return `trading for less than ${p.minPairDays} days`;
    if (m.mcapUsd != null && m.mcapUsd > p.maxMcapUsd) return "too big: a large platform's token";
    return null;
  }

  private symbolSeen(c: Cand): boolean {
    if (!c.evidence) return true;
    const sym = (c.market?.symbol ?? "").toLowerCase().replace(/^\$/, "");
    const name = (c.market?.name ?? "").toLowerCase();
    const text = c.evidence.toLowerCase();
    return (sym.length >= 2 && new RegExp(`(^|[^a-z0-9])\\$?${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text)) || (name.length >= 3 && text.includes(name));
  }

  async resolve(map: Map<string, Cand>): Promise<{ withGithub: number; owners: Map<string, { cand: Cand; owner: string; repo: string | null; via: string }> }> {
    const byChain = new Map<string, Cand[]>();
    for (const c of map.values()) byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);
    for (const [chain, list] of byChain) {
      const m = await this.dex.markets(chain, list.map((c) => c.address));
      for (const c of list) c.market = m.get(c.address.toLowerCase());
    }
    const owners = new Map<string, { cand: Cand; owner: string; repo: string | null; via: string }>();
    let withGithub = 0;
    const live = [...map.values()].filter((c) => c.market).sort((a, b) => (b.market?.volumeUsd ?? 0) - (a.market?.volumeUsd ?? 0));
    for (const c of live) {
      if (!this.symbolSeen(c)) continue;
      // a tokenized stock or fund is a wrapper of something else, not a project's own token
      if (c.categories.some((x) => /tokeni[sz]ed|stocks?\b|xstocks|real world assets/i.test(x)) || /on$/.test(c.market?.symbol ?? "") && /stock/i.test(c.market?.name ?? "")) continue;
      let links = [...c.github, ...(c.market?.links ?? []).filter((u) => githubOwner(u))];
      let via = c.sources.has("coingecko") && c.github.length ? "CoinGecko" : c.sources.has("github-readme") ? "its README" : "DexScreener";
      if (!links.length && !this.tokenGate(c.market!)) {
        // no GitHub in the listings: the token's own website, once a week, within the day's cap
        for (const site of [...c.websites, ...(c.market?.links ?? []).filter((u) => !/x\.com|twitter\.com|t\.me|discord/i.test(u))].slice(0, 2)) {
          const html = await this.sites.page(site);
          if (html) links = githubLinksIn(html);
          if (links.length) {
            via = "its website";
            break;
          }
        }
        if (!links.length && this.d.config.sources.pumpfun && c.chain === "solana" && /pump$/.test(c.address)) {
          for (const site of await pumpfunLinks({ db: this.d.db, fetchImpl: this.d.fetchImpl, now: this.d.now, sleep: this.d.sleep }, c.address)) {
            const html = await this.sites.page(site);
            if (html) links = githubLinksIn(html);
            if (links.length) {
              via = "its pump.fun page";
              break;
            }
          }
        }
      }
      const gh = links.map(githubOwner).find((g) => g);
      if (!gh) continue;
      withGithub++;
      if (denied(this.d.config, gh.owner) || (gh.repo && deniedRepo(this.d.config, gh.repo))) continue;
      const k = gh.owner.toLowerCase();
      const have = owners.get(k);
      // one token per owner: the one with the deepest market (its home chain)
      if (!have || (have.cand.market?.liquidityUsd ?? 0) < (c.market?.liquidityUsd ?? 0)) owners.set(k, { cand: { ...c, categories: [...new Set([...c.categories, ...(have?.cand.categories ?? [])])] }, owner: gh.owner, repo: gh.repo, via });
    }
    return { withGithub, owners };
  }

  /** Writes a token's market onto its pool row. */
  private saveMarket(login: string, m: TokenMarket) {
    this.d.db
      .prepare("UPDATE pool SET symbol = coalesce(?, symbol), name = coalesce(name, ?), chain = ?, address = ?, dex_url = ?, pair_created_at = ?, liquidity_usd = ?, volume_usd = ?, volume_h6 = ?, mcap_usd = ?, token_at = ? WHERE login = ?")
      .run(m.symbol, m.name, m.chain, m.address, m.url, m.pairCreatedAt, m.liquidityUsd, m.volumeUsd, m.volumeH6, m.mcapUsd, this.now(), login);
    this.d.db.prepare("INSERT INTO token_vol (login, day, volume) VALUES (?, ?, ?) ON CONFLICT(login, day) DO UPDATE SET volume = excluded.volume").run(login, iso(this.now()).slice(0, 10), m.volumeUsd);
  }

  upsert(owner: string, repo: string | null, c: Cand, via: string) {
    const k = owner.toLowerCase();
    const now = this.now();
    const have = poolRow(this.d.db, k);
    const camp: GroupKey = campOf({ chain: c.chain, categories: c.categories, text: `${c.name ?? ""} ${c.description ?? ""}` });
    const sources = JSON.stringify([...new Set([...(have ? (JSON.parse(have.sources) as string[]) : []), ...c.sources, `github via ${via}`])].slice(0, 8));
    if (!have)
      this.d.db
        .prepare("INSERT INTO pool (login, display, name, repo, camp, categories, description, sources, status, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)")
        .run(k, owner, c.name ?? c.market?.name ?? null, repo, camp, JSON.stringify(c.categories.slice(0, 12)), c.description, sources, now);
    else
      this.d.db
        .prepare("UPDATE pool SET repo = coalesce(?, repo), categories = ?, description = coalesce(?, description), sources = ?, name = coalesce(?, name, ?) WHERE login = ?")
        .run(repo, JSON.stringify([...new Set([...(JSON.parse(have.categories) as string[]), ...c.categories])].slice(0, 12)), c.description, sources, c.name, c.market?.name ?? null, k);
    if (c.market) this.saveMarket(k, c.market);
  }

  // ---- 3. the GitHub side, through the search API ----

  /** An owner's repos and its commits in the last 30 days: two search calls. Null when GitHub did not answer. */
  async readGitHub(login: string): Promise<GhRead | null> {
    const since = iso(this.now() - 30 * DAY).slice(0, 10);
    type SRepo = { name: string; owner: { login: string; type: string }; stargazers_count: number; forks_count: number; created_at: string; pushed_at: string | null; fork: boolean; archived: boolean; size: number; description: string | null; topics?: string[]; language: string | null; is_template?: boolean };
    const r = await this.searchGet<{ total_count: number; items: SRepo[] }>(`/search/repositories?q=${encodeURIComponent(`user:${login} fork:true`)}&sort=updated&order=desc&per_page=50`);
    if (!r.data) return null;
    const items = r.data.items ?? [];
    const c = await this.searchGet<{ total_count: number; items: { commit: { committer?: { date?: string }; author?: { date?: string; email?: string } }; author?: { login?: string } | null }[] }>(
      `/search/commits?q=${encodeURIComponent(`user:${login} committer-date:>${since}`)}&sort=committer-date&order=desc&per_page=100`,
    );
    const commits = c.data?.items ?? [];
    const at = (x: (typeof commits)[number]) => Date.parse(x.commit.committer?.date ?? x.commit.author?.date ?? "") || 0;
    const now = this.now();
    const authors = (days: number) => new Set(commits.filter((x) => now - at(x) <= days * DAY).map((x) => (x.author?.login ?? x.commit.author?.email ?? "?").toLowerCase())).size;
    const total30 = c.data?.total_count ?? 0;
    const d1 = commits.filter((x) => now - at(x) <= DAY).length;
    const d7 = commits.filter((x) => now - at(x) <= 7 * DAY).length;
    const repos = items.map((x) => ({
      name: x.name,
      stars: x.stargazers_count ?? 0,
      forks: x.forks_count ?? 0,
      createdAt: x.created_at,
      pushedAt: x.pushed_at,
      fork: !!x.fork,
      archived: !!x.archived,
      size: x.size ?? 0,
      description: x.description,
      topics: x.topics ?? [],
      language: x.language,
      template: !!x.is_template,
    }));
    const own = repos.filter((x) => !repoNoise(x));
    return {
      type: items[0]?.owner.type === "User" ? "user" : "org",
      display: items[0]?.owner.login ?? login,
      repos: repos.slice(0, 30),
      // when the first 100 commits all fall in the week, the week has at least as many as the share of the month
      commits: { d1, d7: commits.length === 100 && d7 === 100 ? Math.max(d7, Math.round(total30 / 4)) : d7, d30: total30, authors7: authors(7), authors30: authors(30), total30 },
      pushedAt: own.reduce<string | null>((m, x) => (x.pushedAt && (!m || x.pushedAt > m) ? x.pushedAt : m), null),
      readAt: now,
    };
  }

  /** Is the owner still updating its own work? The reason when not. */
  ghGate(g: GhRead): string | null {
    const own = g.repos.filter((x) => !repoNoise(x));
    if (!g.repos.length) return "no public repos";
    if (!own.length) return "only forks, mirrors, templates or tutorials";
    if (!g.pushedAt || this.now() - Date.parse(g.pushedAt) > this.d.config.pool.activeDays * DAY) return `no push to its own repos in ${this.d.config.pool.activeDays} days`;
    if (g.commits.total30 === 0) return `no commits in ${this.d.config.pool.activeDays} days`;
    return null;
  }

  private setStatus(login: string, status: PoolRow["status"], why: string | null) {
    this.d.db.prepare("UPDATE pool SET status = ?, why = ?, checked_at = ? WHERE login = ?").run(status, why, this.now(), login);
  }

  /** Followers and kind of account (one core request), for the best few each day, within the ranking's share. */
  async readFollowers(rows: PoolRow[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (r.followers_at && this.now() - r.followers_at < 7 * DAY) continue;
      if (this.d.coreRoom && !this.d.coreRoom()) break;
      const u = await this.d.core.get<{ login: string; type: string; followers: number; name: string | null }>(`/users/${r.display}`, { wait: false });
      if (!u.data) {
        if (u.status === 404) this.setStatus(r.login, "out", "the GitHub account is gone");
        if (u.status === 429 || u.status === 403) break;
        continue;
      }
      n++;
      this.d.db.prepare("UPDATE pool SET followers = ?, followers_at = ?, type = ?, display = ? WHERE login = ?").run(u.data.followers, this.now(), u.data.type === "User" ? "user" : "org", u.data.login, r.login);
      if (u.data.type === "User" && u.data.followers > this.d.config.pool.famousFollowers) this.setStatus(r.login, "out", "a famous person's own account, not a project");
    }
    return n;
  }

  /** The whole deep pass. */
  async deepPass(): Promise<DeepResult> {
    const t0 = this.now();
    const map = await this.gather();
    const { withGithub, owners } = await this.resolve(map);
    for (const o of owners.values()) this.upsert(o.owner, o.repo, o.cand, o.via);
    this.log(`${map.size} token(s), ${withGithub} with a GitHub link, ${owners.size} owner(s)`);
    // token gates first (no GitHub request for a token that fails them)
    const rows = this.d.db.prepare("SELECT * FROM pool ORDER BY coalesce(volume_usd, 0) DESC").all() as PoolRow[];
    const gate = new Map<string, string | null>();
    for (const r of rows) {
      if (denied(this.d.config, r.display) || (r.repo && deniedRepo(this.d.config, r.repo))) {
        this.d.db.prepare("DELETE FROM pool WHERE login = ?").run(r.login);
        continue;
      }
      const m: TokenMarket | null = r.liquidity_usd == null ? null : { chain: r.chain ?? "", address: r.address ?? "", symbol: r.symbol, name: r.name, url: r.dex_url, liquidityUsd: r.liquidity_usd ?? 0, volumeUsd: r.volume_usd ?? 0, volumeH6: r.volume_h6 ?? 0, mcapUsd: r.mcap_usd, pairCreatedAt: r.pair_created_at, links: [] };
      const why = m ? this.tokenGate(m) : "no market found";
      gate.set(r.login, why);
      if (why) this.setStatus(r.login, "out", why);
    }
    // then GitHub, the best-trading first, within the pass's cap; a read younger than 20 hours is kept
    let read = 0;
    for (const r of rows) {
      if (gate.get(r.login) !== null) continue;
      if (read >= this.d.config.sources.deepOwners) break;
      let g = r.gh && r.gh_at && this.now() - r.gh_at < 20 * 3_600_000 ? (JSON.parse(r.gh) as GhRead) : null;
      if (!g) {
        g = await this.readGitHub(r.display);
        read++;
        if (!g) continue;
        this.d.db.prepare("UPDATE pool SET gh = ?, gh_at = ?, type = coalesce(type, ?), display = ? WHERE login = ?").run(JSON.stringify(g), this.now(), g.type, g.display, r.login);
      }
      const why = this.ghGate(g);
      // the token's own words and its repos' topics (a repo's description mentions too much to sort by)
      const text = [r.name ?? "", r.description ?? "", ...g.repos.filter((x) => !repoNoise(x)).slice(0, 8).flatMap((x) => x.topics)].join(" ");
      const camp = campOf({ chain: r.chain, categories: JSON.parse(r.categories) as string[], text });
      this.d.db.prepare("UPDATE pool SET camp = ? WHERE login = ?").run(camp, r.login);
      this.setStatus(r.login, why ? "out" : "ok", why);
    }
    const ok = this.d.db.prepare("SELECT * FROM pool WHERE status = 'ok' ORDER BY coalesce(volume_usd, 0) DESC LIMIT 200").all() as PoolRow[];
    await this.readFollowers(ok);
    const counts = this.d.db.prepare("SELECT status, why, count(*) AS n FROM pool GROUP BY status, why").all() as { status: string; why: string | null; n: number }[];
    const out: Record<string, number> = {};
    for (const c of counts) if (c.status === "out") out[c.why ?? "?"] = (out[c.why ?? "?"] ?? 0) + c.n;
    const eligible = counts.filter((c) => c.status === "ok").reduce((s, c) => s + c.n, 0);
    return { tokens: map.size, withGithub, owners: owners.size, eligible, read, out, ms: this.now() - t0 };
  }

  /** The hourly refresh of the markets of the pool's projects in play (DexScreener only). */
  async refreshMarkets(): Promise<number> {
    const rows = this.d.db.prepare("SELECT login, chain, address, liquidity_usd FROM pool WHERE status = 'ok' AND chain IS NOT NULL AND address IS NOT NULL").all() as { login: string; chain: string; address: string; liquidity_usd: number | null }[];
    const byChain = new Map<string, typeof rows>();
    for (const r of rows) byChain.set(r.chain, [...(byChain.get(r.chain) ?? []), r]);
    let n = 0;
    for (const [chain, list] of byChain) {
      const m = await this.dex.markets(chain, list.map((r) => r.address));
      for (const r of list) {
        const mk = m.get(r.address.toLowerCase());
        if (!mk) continue;
        this.saveMarket(r.login, mk);
        n++;
        // a project already in play leaves only when its market really fades (half the entry floor), so a quiet day does not churn the list
        if (mk.liquidityUsd < this.d.config.pool.minLiquidityUsd / 2) this.setStatus(r.login, "out", "liquidity fell under half the floor");
      }
    }
    return n;
  }
}
