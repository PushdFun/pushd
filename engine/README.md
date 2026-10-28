# PUSHD engine

The watcher behind the site. It ranks crypto token projects by their public GitHub activity, watches the most active
of them (the Top list), reads public GitHub activity for them, drops the noise, scores what is
left for heat, writes one plain line about it, and serves the feed in the shapes the website reads
(`web/src/lib/types.ts`). Everything runs locally; nothing here posts, trades or buys anything.

## Run it

```sh
cd engine
npm install
npm start                              # watcher + feed API on http://127.0.0.1:3701
npm start -- --only aeyakovenko,simonw --for 10m --serve-after   # a short local check
npm run rank -- --deep                 # gather the pool again from the token listings and rank it (the daily pass)
npm run rank -- --hourly               # GH Archive's new hours, the markets, a rank (the hourly pass)
npm run rank                           # print the current Top list
npm run replay -- aeyakovenko          # what PUSHD would have shown for one account, and when
npm run keeper                         # one run of the $PUSHD keeper now (docs/token.md); off until its key and addresses are set
npm test                               # unit tests (filter, heat, summary, dedup, API, delay rule, token, keeper, holders,
                                       # scouts, own scouts, the agent API and the 402 payment checks, the ranking and its
                                       # rotation, GH Archive, the GitHub allowance plan, lookups, holders' added accounts,
                                       # suggestions, and the scouts' credit caps at ten times the volume)
npx tsx scripts/holder-demo.ts 3702    # a local signed-in holder on a pretend chain, for screenshots of "my scout" only
npm run lint                           # eslint + tsc
```

Then point the site at it: `cd ../web && PUSHD_ENGINE_URL=http://127.0.0.1:3701 npm run dev`.

`npm run watch` and `npm run serve` run the two halves on their own; they share `data/pushd.sqlite`.

## Settings (all optional)

Put them in `engine/.env` or the environment.

| Variable | What it does | Default |
|---|---|---|
| `PUSHD_GITHUB_TOKEN` | A GitHub token (no scopes needed: public data only). 5,000 requests an hour instead of 60. Locally, `~/.pushd-github-token` is read when the variable is empty. Never logged or written anywhere. | none: unauthenticated, slow schedule |
| `PUSHD_EXTRAS_DB` | The store of holders' added accounts' lines (never the public feed). | `data/extras.sqlite` |
| `PUSHD_ADMIN_KEY` | The admin key (`x-pushd-admin-key`): the suggestions inbox and `/v1/admin/status`. Set the same on the site. | none: admin routes answer 404 |
| `PUSHD_OPENROUTER_KEY` | Summaries by a cheap model via OpenRouter; every call's cost goes in the `costs` table and the log. | none: summaries from the repo's own words, no cost |
| `PUSHD_OPENROUTER_MODEL` | The model for summaries. | `google/gemini-2.5-flash-lite` |
| `PUSHD_LIVE_KEY` | A key (`x-pushd-live-key`) that gets `?delay=0` without a holder's sign-in, for tools of our own. | none |
| `PUSHD_ENGINE_PORT` / `PUSHD_ENGINE_HOST` | Where the API listens. | `3701` / `127.0.0.1` |
| `PUSHD_PUBLIC_DELAY_MINUTES` | How far the public view runs behind. | `5` |
| `PUSHD_BACKFILL_HOURS` | On the first look at an account, lines from this far back still go in the feed (marked backfill). | `48` |
| `PUSHD_DB` | The store. | `data/pushd.sqlite` |
| `PUSHD_MEDIA` | `off` stops fetching repo preview pictures (the site then draws every card). | on |
| `PUSHD_MEDIA_DIR` | Where the preview pictures are kept. | `data/media` |
| `PUSHD_MEDIA_PER_HOUR` | At most this many picture fetches an hour (429s included). | `30` |
| `PUSHD_VAPID_PUBLIC_KEY` / `PUSHD_VAPID_PRIVATE_KEY` | Web push for holders (alerts with PUSHD closed). Make a pair once with `npx web-push generate-vapid-keys`; the private key is secret. | none: push off |
| `PUSHD_VAPID_SUBJECT` | The contact the push services see (`https://` or `mailto:`). | `PUSHD_SITE_URL`, else `https://pushd.fun` |

The agent layer's settings (scouts, holders' own scouts, the agent API and its prices) are in the table under "The
agent layer" below.

$PUSHD's settings (the burn pot, the keeper, holder sign-in) are in `docs/token.md` and `.env.example` at the repo
root. With none of them set, `/v1/token` says "soon", no keeper runs and holder sign-in says it opens at launch.

## How it works

- **Watcher** (`src/watcher.ts`). Per account, most overdue first: `GET /users/{u}/events/public` (orgs:
  `/orgs/{o}/events`) as a conditional request (ETag), the repo list (`/users/{u}/repos?sort=created`) when the events
  hint at a new or newly public repo and every few polls anyway, and public gists every few polls. Requests are spread
  so the hourly budget lasts until GitHub's reset (read from the `X-RateLimit-*` headers); it waits out a 403/429.
  The Top list is read in three tiers by rank (src/plan.ts): with a token ranks 1 to 20 every 2 minutes, 21 to 50
  every 5, 51 to 100 every 12; without one about every 1.5, 3.5 and 8.5 hours (the lower tiers in turn). Holders'
  added accounts are read only when no watched project is due, into their own store. Every line keeps `githubAt` (when GitHub says it happened), `seenAt` (when the watcher saw it)
  and `shownAt` (when it went into the live feed, which is what holders see). GitHub's own event lists run seconds to
  minutes behind, so PUSHD is never instant and never says so.
- **Filter** (`src/filter.ts`). Drops bots, tool branches (dependabot, renovate, gh-pages), side branches,
  housekeeping commits (bumps, CI, formatting, typos, merges), pushes to long-lived busy repos, an org's everyday
  pushes, forks, pre-releases and patch releases.
- **Heat** (`src/heat.ts`). Named signals with points, 0 to 10: new repo, repo made public, first new repo or first
  push after a long silence, fun or short name, words like coin, token, meme, launch, gm, retro computing, images,
  a joke README, a major or first release, and the account's size (only on something new). 0-3 low, 4-5 medium,
  6-7 high, 8-10 very high. High and up are catches.
- **Summary** (`src/summary.ts`). Only from the repo: name, description, README's first lines, topics, files. The
  model's line is refused if it brings in a number that is not in the repo; the fallback then takes the
  description or the README's first sentence, or says plainly what kind of thing it is. No dashes, under 120
  characters.
- **API** (`src/api.ts`). `/v1/feed` (`?group= &heat= &person= &limit=`), `/v1/feed/:id`, `/v1/watchlist`,
  `/v1/stats`, `/v1/catches`, `/v1/stream` (server-sent events), `/v1/media/:id`, `/health`. Everything runs the 5
  minute public delay; `?delay=0` needs the live key or a holder's session (`Authorization: Bearer`).
- **$PUSHD** (`src/token/`). `/v1/token`: the burn pot read from Robinhood Chain (soon, deployed or live, the burns and
  the supply), at most once a minute for everyone. Holder sign-in: `POST /v1/holders/challenge`, `POST
  /v1/holders/session` (an EIP-191 signature over the kept message, then the wallet's balance), `GET /v1/holders/me`,
  `PUT /v1/holders/prefs`, `DELETE /v1/holders/session`. The keeper sweeps the fees and calls the burn pot's `burn()`
  on the pot's own schedule. All in `docs/token.md`.
- **Preview pictures** (`src/media.ts`). Every new line about a repo (new repo, push, release) queues that repo's
  GitHub share picture (`opengraph.githubassets.com`), once per repo. The watcher works the queue beside the polls: one
  fetch at a time, at least 20 s apart, at most `PUSHD_MEDIA_PER_HOUR` an hour; a 429 pauses the whole queue
  (Retry-After when GitHub sends one, otherwise 10 minutes doubling with each 429 in a row, at most 6 hours), a 404 is
  never retried, other failures retry later and are given up after 5 tries. Pictures are checked (type, size, first
  bytes), kept in `data/media` (never committed) and served at `/v1/media/:id` with a year's cache. A line's `mediaUrl`
  points there once its picture is stored, and is null until then: the site draws its own card.
- **Alerts with PUSHD closed** (`src/push.ts`). Web push for signed-in holders: `GET /v1/holders/push/key`, `PUT
  /v1/holders/push` (a browser's subscription, with the holder's session), `DELETE /v1/holders/push`. The API process
  follows new lines as they are stored (no delay) and sends each to the holders whose own choices match (alert heat,
  only my list, muted builders: the open site's rule), only while the wallet still holds at the threshold, at most 20
  an hour each and 5 devices each; a subscription the push service calls gone (404/410) is dropped. Off, with 409s,
  until the VAPID keys are set. The site's service worker (`web/public/sw.js`) shows the alert.
- **Catches** (`catches` table). Every high or very high line, with githubAt, seenAt and shownAt, written once.
  The table refuses updates and deletes.

## The Top list (`src/rank`)

PUSHD watches crypto token projects in its own space: projects with a token on a DEX (DexScreener), a real public
GitHub, out for a while, and still updating. Not chains' foundations, big platforms or famous people. The list ranks
and rotates itself.

- **The pool** (`pool.ts`, the daily pass). Tokens from DexScreener's latest profiles, boosts and pair search,
  CoinGecko's coins in a few categories (pump.fun, Solana memes, AI agents, Base, the Robinhood ecosystem,
  launchpads) and GitHub's code search for READMEs that link their own token's page. Every token's market is read from
  DexScreener (liquidity, 24h volume, its oldest pair's age, its links); a token with no GitHub link has its website
  read once a week for one. One row per GitHub owner, with its token (chain, address, DexScreener page). The gates:
  liquidity over `PUSHD_POOL_MIN_LIQUIDITY_USD`, volume over `PUSHD_POOL_MIN_VOLUME_USD`, a pair older than
  `PUSHD_POOL_MIN_PAIR_DAYS`, market value under `PUSHD_POOL_MAX_MCAP_USD`, not on the public denylist of giants
  (`config.ts`), not a famous person's own account, and commits in the last `PUSHD_POOL_ACTIVE_DAYS` on its own repos
  (not forks, mirrors, templates, tutorials or trading-bot spam). A private list (`data/deny.private.json`, never
  committed, or `PUSHD_DENY_PRIVATE` on a host) names accounts that are never ranked, looked up, suggested or shown.
- **The camps.** The five keys stay; what they hold: `launchpads` Solana and pump.fun, `chain` Robinhood Chain,
  `wallets` Base and EVM, `ai` AI agents, `oss` tools and infra (`classify.ts`: AI first, then tools and infra, then
  the token's chain).
- **Activity** (`gharchive.ts`, `pool.ts`). GH Archive's hourly public-event files are streamed and counted for the
  pool's owners (pull requests opened and merged, issues, reviews, stars, forks, releases, tags, new repos, and the
  people behind them); nothing is kept on disk. The archive is a sample of GitHub's timeline (a few thousand events an
  hour, about 4 MB compressed, so about 100 MB a day). The daily pass reads each owner's repos and its commits of the
  last 30 days through the search API (two calls an owner), and followers for the best few (one core request each).
- **The score** (`score.ts`). Ten parts, each counted over 24 hours, 7 days and 30 days with a time decay, normalised
  against the pool (log scale, its 95th percentile is 1) and weighted (`PUSHD_RANK_W_<PART>`): commits and pushes 3,
  contributors 2, releases and tags 1.5, issues and pull requests 1.5, new repos 1, stars 1, forks 0.5, followers 0.4,
  PUSHD's own signals 1 (past catches, recent heat, holders watching, suggestions), the token 0.6 (pair age, volume
  trend). 0 to 100, every part kept with its raw counts (`GET /v1/top/:handle`).
- **The rotation** (`rotate.ts`). Hourly. A project enters after ranking in the top `PUSHD_RANK_ENTER` (90) for
  `PUSHD_RANK_ENTER_PASSES` (3) passes when a seat is free; it leaves after ranking below `PUSHD_RANK_EXIT` (130) for
  `PUSHD_RANK_EXIT_PASSES` (6) passes and `PUSHD_RANK_MIN_DWELL_HOURS` (24) in; a project that stops being eligible
  leaves at once. Each camp keeps `PUSHD_RANK_CAMP_MIN` (8) seats. Every entry and exit is logged with its reason
  (`rank_log`). `PUSHD_TOP_SIZE` (100) seats.
- **Old lines.** The old hand-made list (`data/watchlist.json`) only names the lines it made; once the ranking has a
  list, those lines leave the public view (they stay stored).

| Variable | What it does | Default |
|---|---|---|
| `PUSHD_RANK` | `off` stops the passes. | on |
| `PUSHD_TOP_SIZE` | Seats in the Top list. | `100` |
| `PUSHD_RANK_ENTER` / `_ENTER_PASSES` / `_EXIT` / `_EXIT_PASSES` / `_MIN_DWELL_HOURS` / `_CAMP_MIN` | The rotation. | `90` / `3` / `130` / `6` / `24` / `8` |
| `PUSHD_RANK_W_<PART>` | A part's weight (COMMITS, CONTRIBUTORS, RELEASES, NEWREPOS, STARS, FORKS, ISSUES, FOLLOWERS, PUSHD, TOKEN). | see above |
| `PUSHD_RANK_DECAY_DAYS` | The decay's time constant. | `7` |
| `PUSHD_RANK_EVERY_MIN` / `PUSHD_RANK_DEEP_EVERY_HOURS` | The passes. | `60` / `24` |
| `PUSHD_POOL_MIN_LIQUIDITY_USD` / `_MIN_VOLUME_USD` / `_MIN_PAIR_DAYS` / `_ACTIVE_DAYS` / `_MAX_MCAP_USD` | The gates. | `20000` / `5000` / `30` / `30` / `300000000` |
| `PUSHD_POOL_CHAINS` / `PUSHD_POOL_GECKO_CATEGORIES` / `PUSHD_POOL_DEX_SEARCH` | Where tokens are looked for. | see `config.ts` |
| `PUSHD_DEX_PER_MIN` / `PUSHD_GECKO_PER_MIN` / `PUSHD_GECKO_DETAILS_PER_DAY` / `PUSHD_POOL_WEBSITES_PER_DAY` | The outside sources' pace and caps. | `30` / `5` / `150` / `600` |
| `PUSHD_POOL_CODE_SEARCH_PAGES` / `PUSHD_RANK_SEARCH_PER_MIN` / `PUSHD_RANK_DEEP_OWNERS` | GitHub's search API for the ranking. | `3` / `18` (5 without a token) / `400` (60) |
| `PUSHD_RANK_GHARCHIVE` / `PUSHD_RANK_GHARCHIVE_BACKFILL_HOURS` | GH Archive. | on / `72` |
| `PUSHD_DENY` / `PUSHD_DENY_PRIVATE` | More accounts never in the pool / the never-shown list. | none / `data/deny.private.json` |

## The GitHub allowance (`src/plan.ts`)

Every request is booked to the part that made it (`gh_spend`; 304 answers are free on GitHub's side and booked as
free), and each part has a reserved share of the hour: with a token watch 2,400, lookups 600, holders' added accounts
400, a line's page 300, the ranking 150 (3,850 of 5,000); without one 40, 8, 3, 4 and 2 (57 of 60). A part over its
share waits; lookups also stop while GitHub's own count is under a reserve (500 with a token, 15 without), so the
watched projects always come first. `PUSHD_GH_SHARE_<PART>` changes a share. `GET /v1/stats` carries the plan (tiers
now, with a token and without, the shares and the last hour's spend); `GET /v1/admin/status` the measured spend per
hour and per day, the outside sources' calls, and the scouts' spend.

## Look up anyone, watch any account, suggest a project

- **Lookups** (`src/lookup.ts`). `GET /v1/lookup?q=` (a username, owner/name, a GitHub link or words: the watched
  first, then GitHub's users and repos), `GET /v1/gh/users/:login` and `GET /v1/gh/repos/:owner/:name` (pages built on
  demand: 3 requests each, kept 30 minutes with a token and 6 hours without; a 404 a day), `POST
  /v1/gh/repos/:owner/:name/read` (a scout's deep read: the owner's camp's scout, else DeepSeek). Each visitor gets
  `PUSHD_LOOKUP_PER_MIN` (8) fresh builds a minute and `PUSHD_LOOKUP_PER_HOUR` (60) an hour; searches use
  `PUSHD_LOOKUP_SEARCH_PER_MIN` (10 with a token, 3 without) of GitHub's search allowance. Out of room: a kept page is
  served as stale, otherwise 503 with `busy` and `retryInSec`. Reads: `PUSHD_LOOKUP_HOLDER_READS` (3) a day per holder,
  `PUSHD_LOOKUP_PUBLIC_READS` (10) a day for everyone else (`PUSHD_LOOKUP_VISITOR_READS`, 2, each), all under the
  scouts' caps.
- **Holders watch any account** (`src/holderwatch.ts`). `GET|POST /v1/holders/watch`, `DELETE
  /v1/holders/watch/:login`. By holding (`PUSHD_HOLDER_WATCH_TIERS`, `1000000:3,5000000:10,20000000:25`), at most
  `PUSHD_EXTRA_ACCOUNTS_MAX` (100) different accounts on the server, `PUSHD_HOLDER_WATCH_ADDS_PER_HOUR` (20). Read at a
  lower priority into `data/extras.sqlite`; their lines go to the holder's inbox (`scoutId` "watch") and push alerts,
  and the holder's own scout rules may name them.
- **Suggestions** (`src/suggest.ts`). `POST /v1/suggestions { login, camp, why }`: 3 an hour and 10 a day per visitor,
  500 a day in all, a second suggestion of the same login counts as a vote. `GET /v1/admin/suggestions` and `POST
  /v1/admin/suggestions/:id { status }` with the admin key. Nothing is ever added by itself.

## The agent layer

Three parts, all in the API process (`npm run serve` or `npm start`):

- **The scouts** (`src/scouts/`). Five AI agents, one per camp: Nonce (chain), Sig (wallets), Fuse (launchpads), Vec (AI
  labs), Patch (open source). Each new line gets one call from its camp's scout: the line, why it matters, what the repo
  really is (new repos and releases: tool, experiment, fork, joke, docs, unclear) and a heat call 0 to 10 with a reason.
  With `PUSHD_OPENROUTER_KEY` set: one model call per line through a queue; new repos and releases get a deep read
  (`deepread.ts`: README, file tree, a few main files, all within size limits) and the stronger model. Repo text is
  untrusted (`guard.ts`): lines that read like instructions to an AI are cut before the model sees them, the rest is
  fenced, the answer must be strict JSON and every field is checked (length, no links, no price or trading talk, never
  speaking for a person, no number that is not in the repo). A refused answer, a silent model, or a call over a cap
  gets a template call with the reason in its flags. Without a key every call is a template call (`template.ts`),
  labelled as one; no model output is ever pretended. Calls are written once (`scout_calls` refuses updates and
  deletes). The record (`GET /v1/scouts`, `/v1/scouts/:id`): calls made, model and template calls, hot model calls
  that became catches, the camp's catches called hot, median seconds from GitHub to the call (live calls only), best
  and worst calls. Every model call's cost goes in `scout_spend` and the shared `costs` table.
- **Holders' own scouts** (`rules.ts`, `myscouts.ts`). A holder's plain words become a rule (builders or camps, kinds,
  keywords, a heat floor): drafted by the cheap model when there is a key and room in the cap, by the template parser
  otherwise. The holder edits and saves it. New lines are matched with no model call; a hit goes to the inbox
  (`GET /v1/holders/scouts/hits`), to the open tab and to web push when the VAPID keys are set, with a short model note
  when the cap allows. How many scouts a holder keeps follows the holding (`PUSHD_MY_SCOUT_TIERS`).
- **PUSHD for agents** (`src/agent/`). The same seven tools over MCP (Streamable HTTP, `POST /mcp`) and REST
  (`GET /v1/agent/<tool>`, OpenAPI at `/v1/agent/openapi.json`); the site serves them at `/mcp` and `/api/agent/*`.
  Free: `feed`, `search`, `builder`, `item`, `scouts` (behind the public delay). Paid per call: `live` and `deep-read`,
  with PUSHD's own 402 scheme (`payments.ts`): the 402 names the price in ETH, the burn pot as pay-to and chain id
  4663; the caller sends ETH to the burn pot and retries with the tx hash and the paying wallet's personal_sign over
  `PUSHD payment <tx hash in lower case>`; the engine checks on the chain (to the pot, from the signer, value >= price,
  recent, never used) before serving, so every paid call feeds the burn. Closed ("open at launch") until
  `PUSHD_BURN_POT_ADDRESS` is set. Counters: `GET /v1/agent/stats`.

| Variable | What it does | Default |
|---|---|---|
| `PUSHD_OPENROUTER_KEY` | The model key (also the watcher's summaries). Locally, `~/.pushd-openrouter-key` is read for the scouts when the variable is empty. | none: template calls |
| `PUSHD_SCOUTS` | `off` stops all scout calls. | on |
| `PUSHD_SCOUT_MODEL` / `PUSHD_SCOUT_DEEP_MODEL` | The cheap model for every call / the stronger one for deep reads. | `google/gemini-2.5-flash-lite` / `google/gemini-2.5-flash` |
| `PUSHD_SCOUT_MODEL_PRICE` / `PUSHD_SCOUT_DEEP_MODEL_PRICE` | `in,out` USD per million tokens, for the estimate before a call. | `0.10,0.40` / `0.30,2.50` |
| `PUSHD_SCOUT_DAILY_USD` | Hard cap on model spend a UTC day (scouts, drafts, notes, deep reads together). | `2` |
| `PUSHD_SCOUT_CALL_MAX_USD` | A call whose worst-case estimate is over this is not made. | `0.03` |
| `PUSHD_SCOUT_GAP_MS` | Pause between two queued model calls. | `1500` |
| `PUSHD_SCOUT_README_BYTES`, `PUSHD_SCOUT_FILES`, `PUSHD_SCOUT_FILE_BYTES`, `PUSHD_SCOUT_TREE` | Deep read limits. | `12000`, `3`, `6000`, `300` |
| `PUSHD_SCOUT_CATCHUP` | Stored lines without a call that get a model call on start (the rest: templates). | `20` |
| `PUSHD_SCOUT_HOURLY_USD` | Hard cap on model spend in any 60 minutes. | `0.4` |
| `PUSHD_SCOUT_MODEL_CALLS_PER_DAY` | Calls to any one model a UTC day. | `150` |
| `PUSHD_SCOUT_MIN_HEAT` | The quality gate: a line under this watcher score gets a template call, no model. Dependency bumps, CI and tidying never reach a model, and near-identical pushes to one repo make one call. | `4` |
| `PUSHD_SCOUT_DEEP_MIN_HEAT` | Deep reads only for new repos and releases at this score or more. | `6` |
| `PUSHD_SCOUT_DEDUPE_HOURS` | No second model call on the same repo within this many hours. | `12` |
| `PUSHD_MY_SCOUT_TIERS` | Own scouts by holding, `min whole $PUSHD:scouts,...`. | `1000000:1,5000000:3,20000000:5` |
| `PUSHD_MY_SCOUT_DRAFTS_PER_HOUR` / `PUSHD_MY_SCOUT_SAVES_PER_HOUR` | Rate limits per holder. | `12` / `30` |
| `PUSHD_AGENT_PAID` | `off` keeps paid tools closed even with the burn pot set. | on |
| `PUSHD_AGENT_PRICE_LIVE_ETH` / `PUSHD_AGENT_PRICE_DEEP_READ_ETH` | Prices per call. | `0.00002` / `0.0003` |
| `PUSHD_AGENT_PAY_MAX_AGE_MIN` | How old a payment may be. | `30` |
| `PUSHD_AGENT_FREE_PER_MIN` / `PUSHD_AGENT_KEY_PER_MIN` / `PUSHD_AGENT_PAID_PER_HOUR` | Rate limits: per address, per API key, per paying wallet. | `30` / `120` / `600` |
| `PUSHD_AGENT_TRUST_PROXY` | `1`: trust `X-Forwarded-For` from any peer. Set it when the site's proxy reaches the engine over a private network (loopback peers are always trusted), so limits apply per caller, not to the site as a whole. | off |
