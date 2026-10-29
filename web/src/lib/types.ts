// The shapes the site reads. The watcher (engine) answers in these same shapes; until it runs, src/lib/sample.ts does.

export type GroupKey = "chain" | "wallets" | "launchpads" | "ai" | "oss";
export type Kind = "repo" | "push" | "release" | "gist";
export type Heat = "low" | "medium" | "high" | "veryHigh";

/** One thing a watched builder published on GitHub, as PUSHD shows it. */
export type FeedItem = {
  /** url-safe id, also the item's page: /feed/<id> */
  id: string;
  /** the handle as shown ("toly", "@kaiwren") */
  handle: string;
  /** the person's name, only for well-known public builders */
  name?: string;
  /** what they are known for ("Solana") */
  org?: string;
  group: GroupKey;
  kind: Kind;
  /** repo or gist name */
  repo: string;
  /** a release's tag, shown after the repo ("v2.0") */
  version?: string;
  /** the one plain line */
  summary: string;
  heat: Heat;
  /** the heat as a score out of 10 */
  score?: number;
  /** the signals that made up the score */
  signals?: { label: string; points: number }[];
  /** when it happened on GitHub (ISO 8601) */
  githubAt: string;
  /** when PUSHD showed it (ISO 8601); null while not measured yet */
  shownAt: string | null;
  /** the link on GitHub; null for sample lines with a made-up handle (they have nothing real to link to) */
  url: string | null;
  /**
   * the repo's preview picture. From the engine it is the engine's path (/v1/media/<id>); the data layer turns it into
   * this site's own address (/media/<id>, see src/app/media). null when there is none: the card draws its own picture.
   */
  mediaUrl: string | null;
  sample: boolean;
  /** seen on the watcher's first look at the account, after it happened (so shownAt says nothing about speed) */
  backfill?: boolean;
  /** the camp's scout's call on this line, once it has made one */
  call?: ScoutCall;
  /** from an account a holder added (not on the list): only that holder sees it */
  extra?: boolean;
  /** the project's token (symbol, chain, address, its DexScreener page): every watched project has one */
  token?: RankToken;
  /** shipped with a PUSHD agent: a commit, merge or release an agent made (engine/src/agents) */
  agent?: boolean;
};

// ---- the scouts: one AI agent per camp, its call on each line and its public record (engine: src/scouts) ----

export type ScoutId = "claude" | "gpt" | "grok" | "gemini" | "deepseek";
/** What a scout says a repo really is, after reading it. */
export type Verdict = "tool" | "experiment" | "fork" | "joke" | "docs" | "unclear";

/** A scout's call on one line. `source` says who wrote it: a model, or the template writer (no model used). */
export type ScoutCall = {
  scout: ScoutId;
  source: "model" | "template";
  /** the model that wrote it; null for a template call */
  model: string | null;
  line: string;
  /** why it matters, one or two sentences */
  why: string;
  /** new repos and releases: what the repo really is */
  verdict: Verdict | null;
  whatItIs: string | null;
  /** the scout's heat call, 0 to 10, and its reason */
  heat: number;
  heatReason: string;
  /** the scout read the repo (README, file tree, main files) before the call */
  deep: boolean;
  calledAt: string;
  /** made after the line was stored, when the scouts caught up: its timing says nothing about speed */
  late: boolean;
  /** plain notes: a template stood in for the model and why, text in the repo that tried to instruct AI readers */
  flags: string[];
};

/** A link to one call, for a scout's best and worst. */
export type CallRef = {
  id: string;
  handle: string;
  repo: string;
  version?: string;
  heat: number;
  /** the watcher's score for the same line */
  score: number;
  /** the line is in the catches log */
  caught: boolean;
  source: "model" | "template";
  calledAt: string;
  note: string;
};

/** A scout's public track record. Model calls and template calls are counted apart. */
export type ScoutRecord = {
  id: ScoutId;
  name: string;
  camp: GroupKey;
  title: string;
  rank: number;
  calls: number;
  modelCalls: number;
  templateCalls: number;
  deepReads: number;
  /** model calls at heat 6 or more */
  hotCalls: number;
  /** of those, the lines that are in the catches log */
  hotCatches: number;
  /** hotCatches / hotCalls; null with no hot model call yet */
  hitRate: number | null;
  /** the camp's catches, and how many of them the scout called hot (any source) */
  catches: number;
  catchesCalledHot: number;
  /** median seconds from the moment on GitHub to the call, over calls made live (not catch-up, not backfill) */
  medianToCallSec: number | null;
  timedCalls: number;
  best: CallRef | null;
  worst: CallRef | null;
  verdicts: Record<Verdict, number>;
  /** calls where text in the repo tried to instruct AI readers */
  injections: number;
  lastCallAt: string | null;
  sample: boolean;
};

export type ScoutsView = {
  scouts: ScoutRecord[];
  /** how the scouts write right now: a model, the template writer, or not at all */
  mode: "model" | "template" | "off";
  model: string | null;
  deepModel: string | null;
  asOf: string;
  sample: boolean;
};

export type ScoutProfile = { record: ScoutRecord; calls: FeedItem[]; mode: ScoutsView["mode"]; model: string | null; deepModel: string | null; asOf: string };

/** Someone on the watchlist. */
export type Builder = {
  handle: string;
  name?: string;
  org?: string;
  group: GroupKey;
  sample: boolean;
  /** the project's token, when it is a watched token project */
  token?: RankToken;
};

export type WatchGroup = {
  group: GroupKey;
  /** how many accounts the group holds */
  count: number;
  /** the ones shown by name */
  members: Builder[];
};

export type Stats = {
  /** accounts on the watchlist */
  builders: number;
  groups: number;
  /** how far the public view runs behind, in minutes */
  publicDelayMinutes: number;
  /** projects in the ranking's candidate pool */
  pool?: number;
  /** the ranking's last pass */
  lastPass?: string | null;
  schedule?: SchedulePlan;
};

// ---- the insight shapes (src/insights.ts): activity, profiles, leaderboards. The engine has the same shapes (engine/src/types.ts). ----

/** One day of public activity as the watcher saw it. */
export type DayCount = { day: string; events: number; items: number };

/** A watched account with what PUSHD has seen of it. */
export type BuilderStats = {
  handle: string;
  /** the project's token, when it is a watched token project */
  token?: RankToken;
  name?: string;
  org?: string;
  group: GroupKey;
  type: "user" | "org";
  followers: number | null;
  /** the watcher has read this account at least once */
  read: boolean;
  lastReadAt: string | null;
  lastActiveAt: string | null;
  /** what the last activity was ("pushed to", "starred") and where */
  lastWhat: string | null;
  lastRepo: string | null;
  events7d: number;
  events30d: number;
  items: number;
  catches: number;
  /** activity per day, the last 14 days, oldest first */
  spark: number[];
  sample: boolean;
};

/** A repo as the account's repo list on GitHub shows it (stored, never fetched for the page). */
export type RepoCard = {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  createdAt: string;
  pushedAt: string | null;
  url: string;
  /** when PUSHD read these numbers */
  readAt: string | null;
};

export type ActivityLine = { type: string; what: string; repo: string | null; at: string; url: string | null };

export type BuilderProfile = BuilderStats & {
  /** why PUSHD is sure the account is that person or org */
  source: string | null;
  /** the last 84 days, oldest first */
  days: DayCount[];
  /** activity by hour of day (UTC), the last 30 days */
  hours: number[];
  /** the last 30 days by kind of activity */
  mix: { label: string; count: number }[];
  recent: ActivityLine[];
  lines: FeedItem[];
  hottest: FeedItem[];
  repos: RepoCard[];
  languages: { name: string; repos: number }[];
  /** the repos with the most of this account's activity in the last 30 days */
  touched: { repo: string; count: number }[];
};

export type Pulse = {
  /** the public view's moment: everything here is from before it */
  asOf: string;
  totals: {
    accounts: number;
    accountsRead: number;
    /** public events the watcher has seen in all */
    events: number;
    events24h: number;
    /** events that became feed lines */
    lines: number;
    lines24h: number;
    catches: number;
    catches7d: number;
    active24h: number;
    lastLineAt: string | null;
    lastReadAt: string | null;
  };
  /** the last 24 hours, oldest first, by group */
  hours: { at: string; total: number; groups: Record<GroupKey, number> }[];
  /** the last 84 days, oldest first */
  days: DayCount[];
  groups: { group: GroupKey; accounts: number; events7d: number; lines: number; active24h: number }[];
  /** the most recently active accounts */
  active: { handle: string; name?: string; group: GroupKey; at: string; what: string; repo: string | null }[];
  /** most active in the last 7 days */
  leaders: BuilderStats[];
  hottest: FeedItem[];
  busiestDays: { day: string; events: number; items: number; top: string | null }[];
  languages: { name: string; repos: number }[];
  topics: { name: string; repos: number }[];
  /** repos created in the last 14 days by watched accounts, as GitHub lists them */
  fresh: (RepoCard & { handle: string; group: GroupKey })[];
  sample: boolean;
};

export type RepoFacts = {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number | null;
  topics: string[];
  license: string | null;
  homepage: string | null;
  createdAt: string;
  pushedAt: string | null;
  archived: boolean;
  readAt: string | null;
};

export type CommitLine = { sha: string; message: string; author: string | null; at: string | null; url: string };

/** What an item's page shows beside the line itself. Each part is null when PUSHD has not stored it. */
export type ItemMore = {
  repo: RepoFacts | null;
  /** the README's first lines (or a release's notes, or a gist's text), as plain text */
  text: { kind: "readme" | "notes" | "gist"; body: string; readAt: string } | null;
  commits: CommitLine[] | null;
  /** the head commit's size, when the watcher read it */
  change: { additions: number; deletions: number; files: number } | null;
  related: FeedItem[];
  /** parts being fetched now; the page can look again in a minute */
  pending: string[];
};

export type SearchResult = { items: FeedItem[]; builders: Builder[] };

/** What a page gets from the data layer. */
// ---- the Top list (engine: src/rank): the most active crypto token projects on GitHub right now, ranked and rotated ----

/** One part of a project's activity score: the raw counts, the normalised value (0..1), its weight and its points. */
export type ScorePart = {
  key: string;
  label: string;
  /** the raw counts behind it, by window ("24h", "7d", "30d", "total") */
  raw: Record<string, number>;
  norm: number;
  weight: number;
  points: number;
};

/** A project's token: where it trades, since when, and how much. */
export type RankToken = {
  symbol: string | null;
  name: string | null;
  /** the DEX listing's chain id ("solana", "base", "robinhood", ...) */
  chain: string;
  address: string;
  /** the token's page on DexScreener */
  url: string | null;
  /** days since its oldest trading pair was created */
  pairDays: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  /** when PUSHD read these market numbers (they move all the time) */
  readAt: string | null;
};

export type Movement = "up" | "down" | "same" | "new";

/** A project (a GitHub account or org) in the ranking. */
export type RankRow = {
  rank: number;
  handle: string;
  name?: string;
  org?: string;
  group: GroupKey;
  type: "user" | "org";
  /** 0 to 100 */
  score: number;
  movement: Movement;
  /** places moved since the pass a day before (positive: up) */
  delta: number;
  inTop: boolean;
  /** when it last entered the list */
  enteredAt: string | null;
  /** polling tier inside the list (1 is checked most often); null outside it */
  tier: 1 | 2 | 3 | null;
  /** how often the watcher reads it now, in minutes; null outside the list */
  checkEveryMin: number | null;
  /** its latest public activity PUSHD knows of (the watcher's reads or the public event archive) */
  lastActiveAt: string | null;
  /** the project's token, as the DEX listing shows it */
  token: RankToken | null;
  parts: ScorePart[];
  /** its busiest repos in the window, owner/name */
  topRepos: string[];
  sample: boolean;
};

export type RankChange = { at: string; handle: string; name?: string; group: GroupKey; change: "enter" | "exit"; rank: number; reason: string };

export type ScheduleTier = { tier: 1 | 2 | 3; ranks: string; accounts: number; everyMin: number; withTokenMin: number; withoutTokenMin: number };

/** How the GitHub allowance is shared out, and how often each tier is read. */
export type SchedulePlan = {
  authenticated: boolean;
  /** GitHub's hourly limit for this server: 5,000 with a token, 60 without */
  limitPerHour: number;
  tiers: ScheduleTier[];
  /** the reserved share of each part, requests an hour */
  shares: { key: string; label: string; perHour: number }[];
  /** what was really spent in the last hour, by part */
  spentLastHour: { key: string; n: number }[];
  note: string;
};

export type RankRules = { size: number; enterRank: number; enterPasses: number; exitRank: number; exitPasses: number; minDwellHours: number; campMin: number };

export type TopView = {
  asOf: string;
  lastPass: string | null;
  lastDeepPass: string | null;
  passes: number;
  /** projects in the candidate pool */
  pool: number;
  rows: RankRow[];
  /** the best-ranked projects outside the list, waiting to enter */
  waiting: RankRow[];
  entered: RankChange[];
  dropped: RankChange[];
  byCamp: Record<GroupKey, number>;
  weights: { key: string; label: string; weight: number }[];
  rules: RankRules;
  schedule: SchedulePlan;
  sample: boolean;
};

/** One project's place in the ranking, for its page. */
export type ProjectRank = { row: RankRow; history: { at: string; rank: number; score: number }[]; changes: RankChange[]; poolSince: string | null; rules: RankRules };

// ---- looking up anyone on GitHub (engine: src/lookup) ----

export type GhUser = {
  login: string;
  name: string | null;
  type: "user" | "org";
  bio: string | null;
  company: string | null;
  blog: string | null;
  followers: number | null;
  following: number | null;
  publicRepos: number | null;
  createdAt: string | null;
  url: string;
};

/** Any GitHub account's page, built on demand from public data and kept for a while. */
export type GhUserPage = {
  user: GhUser;
  /** the last 84 days of public events, oldest first */
  days: DayCount[];
  hours: number[];
  mix: { label: string; count: number }[];
  recent: ActivityLine[];
  /** its own repos with the most stars */
  repos: RepoCard[];
  /** its own repos pushed most recently */
  fresh: RepoCard[];
  languages: { name: string; repos: number }[];
  /** when PUSHD read it from GitHub */
  readAt: string;
  /** older than its time to live: GitHub was busy, so this is the last good read */
  stale: boolean;
  /** its place in the ranking, when it is in the pool */
  rank: RankRow | null;
  /** holders watching it */
  watchers: number;
};

export type GhRelease = { tag: string; name: string | null; at: string | null; url: string; prerelease: boolean };

/** What a deep read by a scout says about a repo (the same shape the agent API returns). */
export type ScoutRead = {
  repo: string;
  scout: ScoutId;
  source: "model";
  model: string;
  line: string;
  why: string;
  verdict: Verdict;
  whatItIs: string;
  heat: number;
  heatReason: string;
  flags: string[];
  read: { readmeChars: number; treePaths: number; files: string[]; truncated: boolean };
  facts: { description: string | null; language: string | null; stars: number; fork: boolean; archived: boolean; createdAt: string; pushedAt: string | null };
  readAt: string;
  cached: boolean;
};

/** Who may ask a scout to read a repo right now. */
export type ReadAllowance = {
  open: boolean;
  /** why not, in plain words */
  why: string | null;
  mode: ScoutsView["mode"];
  holderPerDay: number;
  /** reads left today for this holder; null when not signed in */
  holderLeft: number | null;
  publicPerDay: number;
  publicLeft: number;
};

export type GhRepoPage = {
  repo: RepoFacts & { url: string; defaultBranch: string; fork: boolean; parent: string | null; watchers: number | null };
  /** the README's first lines, as plain text */
  readme: string | null;
  commits: CommitLine[];
  releases: GhRelease[];
  readAt: string;
  stale: boolean;
  owner: { login: string; type: "user" | "org" | null; onWatchlist: boolean; inTop: boolean; group: GroupKey | null };
  /** the scout a read goes to: the owner's camp, else DeepSeek for open source */
  scout: ScoutId;
  scoutWhy: string;
  /** the latest deep read, when there is one kept */
  read: ScoutRead | null;
  allowance: ReadAllowance;
};

export type LookupUser = { login: string; type: "user" | "org" };
export type LookupRepo = { fullName: string; description: string | null; stars: number; language: string | null; pushedAt: string | null };

/** Search: the watched first, then anything on GitHub (labelled as not on the watchlist). */
export type LookupResult = {
  q: string;
  /** a username or owner/name typed in full: its page, straight away */
  direct: { kind: "user" | "repo"; href: string; label: string } | null;
  watch: SearchResult;
  github: { users: LookupUser[]; repos: LookupRepo[]; busy: boolean; retryInSec: number | null };
};

// ---- holders watching any account (engine: src/holderwatch.ts) ----

export type HolderWatch = { login: string; type: "user" | "org"; name: string | null; addedAt: number; lastReadAt: string | null; lines: number };
export type HolderWatchView = {
  accounts: HolderWatch[];
  /** how many the holding allows */
  allowed: number;
  tiers: { minWhole: string; accounts: number }[];
  /** room left on the server-wide cap of extra accounts */
  globalLeft: number;
  /** how often an added account is read, in minutes */
  everyMin: number;
};

// ---- suggestions (engine: src/suggest.ts) ----

export type Suggestion = {
  id: number;
  login: string;
  camp: GroupKey;
  why: string;
  at: string;
  status: "new" | "approved" | "declined";
  /** how many times it was suggested */
  count: number;
  inTop: boolean;
  /** its rank in the pool, when it is in it */
  rank: number | null;
};

export type Feed = {
  items: FeedItem[];
  /** the moment "how long ago" is counted from */
  asOf: string;
  /** "sample" when nothing is connected, "engine" when the watcher answered, "offline" when it did not */
  source: "sample" | "engine" | "offline";
  /** true when a signed-in holder sees it live, with no public delay */
  live?: boolean;
};

/** $PUSHD as the engine's GET /v1/token reads it from the chain. Amounts are decimal strings in the smallest unit. */
export type TokenPanel = {
  stage: "soon" | "deployed" | "live";
  token: string | null;
  pot: string | null;
  explorer: string;
  supply: string | null;
  launchSupply: string | null;
  burned: string | null;
  ethSpent: string | null;
  count: number;
  latest: { n: number; tx: string; block: number; at: number; tokens: string; eth: string }[];
  next: { eth: string; tokens: string; at: number | null; ready: boolean } | null;
  lastBurnAt: number | null;
  startedAt: number | null;
  /** whole $PUSHD a wallet needs for the live feed */
  holderMin: string;
  readAt: number;
  stale: boolean;
  problem: string | null;
};

export type AlertHeat = "off" | "veryHigh" | "high" | "medium" | "low";

/** A signed-in holder, as the engine's GET /v1/holders/me answers. */
export type HolderView = {
  status: { address: string; balanceWei: string | null; minWhole: string; holder: boolean; checkedAt: number | null };
  prefs: { follow: string[]; mute: string[]; alertHeat: AlertHeat; alertMine: boolean; scouts?: ScoutId[] };
  expiresAt: number;
};

// ---- a holder's own scouts (engine: src/scouts/rules.ts, myscouts.ts) ----

export type Rule = { builders: string[]; camps: GroupKey[]; kinds: Kind[]; keywords: string[]; heatFloor: number };
export type MyScout = { id: string; name: string; text: string; rule: Rule; readable: string; createdAt: number; updatedAt: number; hits: number };
export type MyHit = { n: number; scoutId: string; scoutName: string; item: FeedItem; why: string; modelWhy: string | null; at: number };
export type MyScoutsView = { scouts: MyScout[]; allowed: number; tiers: { minWhole: string; scouts: number }[]; mode: ScoutsView["mode"] };
export type RuleDraft = { rule: Rule; readable: string; source: "model" | "template"; notes: string[] };

// ---- PUSHD for agents (engine: src/agent) ----

export type AgentStats = {
  calls: number;
  calls24h: number;
  paidCalls: number;
  mcpCalls: number;
  clients30d: number;
  byTool: { tool: string; n: number }[];
  burn: { payments: number; wei: string; eth: string; wallets: number; last: number | null };
  paid: {
    open: boolean;
    payTo: string | null;
    chainId: number;
    asset: string;
    tools: { tool: string; rest: string; priceWei: string; priceEth: string }[];
    limits: { freePerMinute: number; keyPerMinute: number; paidPerHourPerWallet: number; paymentMaxAgeMinutes: number };
    note: string;
  };
  asOf: string;
};
