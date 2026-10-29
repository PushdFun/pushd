# PUSHD Agents

Anyone can build their own agent that helps them ship on GitHub. A person says in plain words what it should do ("after
every push, write release notes and a post about what shipped"); PUSHD turns that into a plan (jobs, triggers, repos,
model) the person reads and confirms. The agent works through one PUSHD GitHub App, only on the repos its owner
installed the app on, and every change it makes is a pull request on a new branch.

Off until `PUSHD_AGENTS=on` is set on both services. Off means: every `/v1/build` route on the engine is a 404, `/build`,
`/build/<agent>`, `/shipped/...` and `/api/build/*` on the site are 404s, the nav has no Build entry, nothing is followed,
scheduled or run.

Not the same as `src/agent` (PUSHD for AI agents: MCP and the paid read API). The code is in `engine/src/agents/` and
`web/src/app/build`, `web/src/app/shipped`, `web/src/app/api/build`.

## What it does

| Job | Triggers | What happens |
|---|---|---|
| Release notes | after every push, when you ask | Notes and a changelog line: a draft on PUSHD, or a pull request adding the line to CHANGELOG.md. |
| What shipped post | after every push, every week, when you ask | A post to copy. Never posted anywhere by PUSHD. |
| Key check | after every push | The push's added lines are read for credentials (patterns only, no model). The owner is warned with each key masked. Free, never counted. Never on the public page. |
| Small changes | when you ask | A fix, docs, README or tests: only files the owner named (or new test or docs files), as a pull request. |
| Pull request review | on each new pull request, when you ask | One comment with findings, only on the owner's own pull requests. |
| Issue helper | on each new issue, when you ask | Up to 3 of the repo's existing labels, and a reply drafted for the owner to approve (or posted, when switched on per agent). |
| Weekly report | every week, when you ask | What shipped this week, on the project's public page, with a post to copy. |
| Dependency watch | every day, every week, when you ask | osv.dev (known vulnerabilities) and the npm registry (two or more majors behind); optional pull request bumping package.json. No model. |
| Release maker | when you ask, every week | A draft GitHub release with notes and the next version. The owner publishes it. |
| Docs keeper | every week, when you ask | A pull request when the README no longer matches the code. |

Also: a public page per project (`/shipped/<owner>/<repo>`: what agents shipped, with links; public repos only; never key
checks, drafts or replies waiting for the owner), an embeddable badge (`/shipped/<owner>/<repo>/badge`, SVG), and a
notice when a run finishes (the inbox on `/build`, and web push to a linked holder wallet when the VAPID keys are set).

Lines in the feed that an agent shipped (a commit on an agent's branch, the merge of an agent's pull request, a release
it drafted) carry "shipped with a PUSHD agent", in the feed and on the line's page.

### Scouts that push

Each of the five scouts has its own public repo under `PUSHD_SCOUTS_ORG` (PushdFun): `pushd-scout-claude`, `-gpt`,
`-grok`, `-gemini`, `-deepseek`, and its own agent made with the same spec checks. After 12:00 UTC each day it builds
something small (a tool, a script or a dataset, at most 3 files) in `builds/<day>-<name>/`, inspired by what that scout
called that day, on its own model, as a pull request. With `PUSHD_SCOUT_AUTOMERGE=on` the pull request is merged (only in
that scout's own repo; anywhere else the merge call is refused). Holders vote on the three ideas each build proposes for
the next one: one vote per holder per scout per round. A merged build becomes a feed line in the scout's camp, tagged.
These builds count against the agents' daily cap and are paid by PUSHD, not by anyone's runs.

## Limits and payment

- Without a holding: `PUSHD_AGENTS_FREE_PER_DAY` runs a UTC day (5). Past them a run can be paid: `PUSHD_AGENTS_RUN_PRICE_ETH`
  (0.00003 ETH, about $0.10) to the burn pot, with the same 402 scheme and on-chain checks as the paid agent API
  (`src/agent/payments.ts`, tool `pushd_agent_run`). Every paid run feeds the burn. Before launch (no burn pot) paid runs
  are closed and the sixth run is refused with that message. A push or schedule past the free runs leaves a run that
  waits up to a day for a payment (at most 3 waiting), then lapses.
- Holders (`PUSHD_HOLDER_MIN`, the existing check; the wallet is linked by signing in as a holder in the same browser):
  no daily count, under a quiet fair-use guard (`PUSHD_AGENTS_HOLDER_PER_HOUR` 30, `PUSHD_AGENTS_HOLDER_PER_DAY` 300).
- Everyone: all agents' model spend stays under `PUSHD_AGENTS_DAILY_USD` ($5) a UTC day, on its own book (`agent_spend`),
  apart from the scouts' cap. When it is reached runs pause with "Agent runs are paused for today. They start again at
  00:00 UTC. Nothing was charged." A run the cap stops is not counted and a payment for it can be used again. The cap is
  never shown on the site.
- Agents per GitHub account follow the holding (`PUSHD_AGENTS_TIERS`, as the own-scout tiers: 1/3/5); without one: 1.
- The builder: `PUSHD_AGENTS_DRAFTS_PER_HOUR` (12) drafts per account; webhooks: `PUSHD_AGENTS_WEBHOOKS_PER_MIN` (120) per
  installation; sign-ins: 10 an hour per visitor.

## Safety

- The spec is data, checked against the whitelist on draft and again, strictly, on save: unknown jobs, triggers, fields,
  models or repos are refused. Nothing in a spec names a token, a URL to call or a permission.
- Repo text (commits, issues, pull requests, files) and the owner's request are untrusted: the scouts' injection guard
  (`src/scouts/guard.ts`) cuts instruction-like lines, the rest is fenced, keys are masked before the model sees anything,
  the answer must be JSON of a fixed shape, and every field is checked. The model never picks the repo, the branch, a file
  to read beyond what the job fetched, or anything to call.
- Every write passes `assertSafeWrite` (`src/agents/github-app.ts`): new `pushd/` branches only, never the default branch,
  nothing under `.github/`, pull requests to the default branch, comments, existing labels, releases as drafts only, a
  merge only in a scout's own repo with automerge on. The app has no workflows or administration permission either.
- Installation tokens are asked for one repo at a time, kept in memory only, never logged or stored. Sign-in uses the
  GitHub token once and drops it; only a hash of PUSHD's own session token is kept.
- Webhook signatures are checked (HMAC SHA-256, constant time) over the raw body before anything is read; a delivery id is
  handled once, and a push makes one run per agent and job however often it is delivered.
- Every run is a receipt (`agent_runs`: job, repo, model, cost, outputs) and every action it took is written once
  (`agent_actions`, no updates or deletes). Keys are masked in everything stored, shown, commented or opened.

## Settings

Set on the engine unless it says otherwise.

| Setting | Default | Meaning |
|---|---|---|
| `PUSHD_AGENTS` | empty | `on` on both the engine and the site. Anything else: off. |
| `PUSHD_GH_APP_ID`, `PUSHD_GH_APP_SLUG` | empty | The app (from the script below). |
| `PUSHD_GH_APP_PRIVATE_KEY` | empty | Secret. PEM; new lines may be written as `\n`. |
| `PUSHD_GH_APP_WEBHOOK_SECRET` | empty | Secret. |
| `PUSHD_GH_APP_CLIENT_ID`, `PUSHD_GH_APP_CLIENT_SECRET` | empty | Sign-in with GitHub. The secret is secret. |
| `PUSHD_AGENTS_FREE_PER_DAY` | 5 | Free runs a UTC day without a holding. |
| `PUSHD_AGENTS_HOLDER_PER_HOUR`, `PUSHD_AGENTS_HOLDER_PER_DAY` | 30, 300 | The holders' fair-use guard. |
| `PUSHD_AGENTS_DAILY_USD` | 5 | All agents' model spend a UTC day. |
| `PUSHD_AGENTS_CALL_MAX_USD` | 0.08 | One model call's worst-case estimate. |
| `PUSHD_AGENTS_RUN_PRICE_ETH` | 0.00003 | One paid run (about $0.10; adjust with the ETH price). |
| `PUSHD_AGENTS_TIERS` | `PUSHD_MY_SCOUT_TIERS` | Agents by holding. |
| `PUSHD_AGENTS_MODEL` | anthropic/claude-haiku-5.5 | The model that drafts a spec from plain words. Runs use the agent's own scout model. |
| `PUSHD_AGENTS_DRAFTS_PER_HOUR`, `PUSHD_AGENTS_WEBHOOKS_PER_MIN`, `PUSHD_AGENTS_SESSION_DAYS` | 12, 120, 7 | Rate limits, sign-in length. |
| `PUSHD_SCOUTS_ORG` | PushdFun | The account of the scouts' repos. |
| `PUSHD_SCOUT_BUILDS` | on | `off`: the scouts do not build. |
| `PUSHD_SCOUT_AUTOMERGE` | off | `on`: a scout's daily pull request is merged in its own repo. |

The model key is the existing `PUSHD_OPENROUTER_KEY`; the burn pot the existing `PUSHD_BURN_POT_ADDRESS`; web push the
existing VAPID keys. `PUSHD_SITE_URL` (engine) and `NEXT_PUBLIC_SITE_URL` (site) name the site the app's addresses use.

## Making the GitHub App (once)

1. Sign in on github.com as **PushdFun**.
2. On this Mac: `cd engine && npx tsx scripts/github-app.ts` (add `--org <name>` if PushdFun is an organization; `--print`
   shows the manifest only).
3. Open the address it prints (http://127.0.0.1:3709) and press **Create the app on GitHub**. GitHub shows the app: name
   "PUSHD Agents", permissions Contents, Pull requests and Issues read and write, Metadata read; events push, pull request,
   issues; webhook `https://pushd.fun/api/build/github/webhook`; sign-in callback
   `https://pushd.fun/api/build/github/callback`. Press **Create GitHub App**.
4. GitHub returns to the script, which writes the six settings to `~/.pushd-github-app.env` (readable only by you; never
   printed).
5. Put each line in the engine's secret settings on Railway (the private key as one line with `\n`), set
   `PUSHD_AGENTS=on` on the engine and the site, redeploy both, then delete `~/.pushd-github-app.env`.
6. Optional, the scouts' repos: `PUSHD_DRY=1 npx tsx scripts/scout-repos.ts` to see them, then without `PUSHD_DRY` (a token
   with public_repo, typed at the prompt). Install the app on the five repos at `https://github.com/apps/<slug>`.

It goes live dark by default: deployed with `PUSHD_AGENTS` unset, nothing of it shows and the webhook answers 404 (GitHub
lists those deliveries as failed; nothing is lost that matters, the next push triggers again).

## Switching it on, and off

On: `PUSHD_AGENTS=on` on both services and a redeploy. Off: remove it (or anything but `on`) on both; the pages and
routes are 404s at once and no run starts. Stored agents and receipts stay in the engine's store for when it comes back.
To stop the scouts building but keep the rest: `PUSHD_SCOUT_BUILDS=off`.

## Tests

`cd engine && npm test` (test/agents.test.ts: a pretend GitHub, chain and model; test/agents-site.test.ts: the site's
copy of the whitelist), `cd web && npx vitest run` (src/lib/build.test.ts), `cd web && npm run build && npm run
test:smoke` (the switch off and on, with no engine).
