# PUSHD

**Know the moment builders push.**

PUSHD watches the public GitHub of the most active crypto projects right now: token projects with real trading and
real code, ranked by how active they are and rotated as that changes. When one of them publishes, PUSHD shows one
plain line, the link and a heat mark. Five AI scouts read what was pushed and say what it is: Claude, GPT, Grok, Gemini
and DeepSeek, one per camp, each with a public record.

Anyone can look up any GitHub account or repo. Holders of $PUSHD see the feed live, watch any account and set up their
own scout. AI agents can read PUSHD over MCP or plain HTTP; the paid calls are paid into the burn pot, which buys $PUSHD
and burns it.

PUSHD only shows public information. It never trades and nothing on it is advice.

## What is here

| Folder | What it is |
|---|---|
| `engine/` | The watcher: ranks the projects, reads their public GitHub activity, writes the feed, runs the scouts, the holder features and the agent API. Node, SQLite. See `engine/README.md`. |
| `web/` | The site (Next.js). |
| `contracts/` | The token's contracts: the burn pot that launches $PUSHD on Pons and burns it, and the splitter the trading fees are paid to. Foundry. |
| `docs/token.md` | How the token is deployed and launched. |
| `docs/agents.md` | PUSHD Agents: anyone's own agent on GitHub, the GitHub App, its settings and switch. Off unless `PUSHD_AGENTS=on`. |

## Run it

```
cd engine && npm install && npm start      # the watcher and its API on :3701
cd web && npm install && PUSHD_ENGINE_URL=http://localhost:3701 npm run dev   # the site on :3700
```

Every setting is listed in `.env.example`. A GitHub token (`PUSHD_GITHUB_TOKEN`, public read only) is needed for the
watcher to keep up; the scouts need an OpenRouter key and run within a hard daily budget.

## Tests

```
cd engine && npm test
cd web && npx vitest run && npm run smoke
cd contracts && forge test
```

Use at your own risk.
