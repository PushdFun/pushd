# $PUSHD

$PUSHD is the token of PUSHD, on Robinhood Chain (chain id 4663), launched on Pons through PUSHD's own burn pot.
A 3% tax on every buy and sell; part of the fees buys $PUSHD on the market and burns it with the token's own
`burn()`, so the total supply really drops. Holding it opens the live feed on the site.

What the site says about it: Robinhood Chain, Pons, the 3% tax, the burn. Never how the fees are shared, never a
share or a percentage of the fees, never who gets what. The shares live only in `contracts/split.local.json` on the
deploying machine (not in git) and in the splitter itself.

## The pieces

| Where | What |
|---|---|
| `contracts/` | `PushdBurnPot` launches $PUSHD on Pons (once, by the launch wallet only) and burns; `PushdSplitter` is the address the fees are paid to; it passes the burn pot its part. `token-deploy.sh`, `token-launch.sh`, `owner-payee.sh`, `launch.json`. Foundry tests: `cd contracts && forge test`. |
| `engine/src/token/` | Reading the chain (`chain.ts`), the `/v1/token` panel (`panel.ts`), the keeper (`keeper.ts`, `keeper-chain.ts`), holder sign-in (`holders.ts`), all started from `local.ts`. |
| `web/src/lib/token/` | The launch page's checks and transaction (`launch.ts`, `launch-plan.ts`, `launch-chain.ts`, `launch-server.ts`), the site's settings (`config.ts`), words for amounts (`words.ts`). |
| `web/src/app/token/` | `/token` (reads the engine's panel) and `/token/launch` (the launch page). |
| `web/src/app/holders/`, `web/src/app/api/holder/` | Holder sign-in with MetaMask, the holder's own watchlist and alerts. |

## On the day, in order

Every command asks for at most one key, at forge's own prompt, where nothing shows. Arguments are public addresses.
`PUSHD_DRY=1` stops each script before the key, with what it would cost.

1. **Deploy the two contracts** (the launch wallet does not need to be online for this):

   ```
   contracts/token-deploy.sh <deployer wallet> <launch wallet> <owner wallet>
   ```

   It checks the chain and the wallets, dry-runs the deploy, asks for the deployer's key, deploys, reads both
   contracts back and writes `contracts/broadcast/token.env` (the two addresses and the deploy block).

2. **Set the addresses** on both services and the keeper's key on the engine, then redeploy both:

   | Setting | Engine | Site |
   |---|---|---|
   | `PUSHD_BURN_POT_ADDRESS`, `PUSHD_SPLITTER_ADDRESS` | yes | yes |
   | `PUSHD_BURN_POT_BLOCK` | yes | |
   | `PUSHD_TOKEN_RPC_URL` (a paid Robinhood Chain node) | yes | yes |
   | `PUSHD_KEEPER_KEY` (a fresh wallet with a little ETH for gas, secret) | yes | |
   | `PUSHD_ENGINE_URL` | | yes |

   `/token` now says "contracts live, launch soon" and shows the burn pot. Holder sign-in still says it opens at
   launch.

3. **Switch the launch page on** (site only): `PUSHD_LAUNCH_PAGE=on` and `PUSHD_LAUNCH_OPENING_BUY_WEI` = the opening
   buy in whole wei (about $30: `30 x 10^26 / <Chainlink ETH/USD with 8 decimals>`). `contracts/launch.json` must have
   the real picture link, website and X account (no REPLACE ME left); the site reads it from
   `PUSHD_LAUNCH_FILE` or `../contracts/launch.json`. Redeploy.

4. **Launch** from the launch wallet's own MetaMask at `/token/launch` (on a phone the button opens the page inside
   the MetaMask app). The page checks everything against the chain on load and again right before it hands the
   transaction to the wallet: the node is Robinhood Chain; the burn pot and the splitter are wired to each other and
   to Pons; the tax is 300 basis points; Pons' launch fee is the one in `launch.json`; `launch.json` passes every check
   `token-launch.sh` makes; the connected wallet is the burn pot's launch wallet (any other is refused, with both
   addresses shown); it holds the value plus gas; and the exact launch runs once on the node from it (nothing sent)
   and returns the token's address. Then one press, one transaction: Pons' fee plus the opening buy, whose tokens
   land in the launch wallet in the same transaction.

   `contracts/token-launch.sh` does the same from a terminal with the launch wallet's key, if the page is not used.

5. **Switch the launch page off**: remove `PUSHD_LAUNCH_PAGE` (anything but `on` is a 404). Set
   `PUSHD_TOKEN_ADDRESS` on both services (the engine reads it from the burn pot anyway). From now on: `/token` shows
   the address and the burns, "Buy $PUSHD" leads to the token's Pons page (or `PUSHD_BUY_URL`), holder sign-in opens.

6. Later, only if a payee address ever has to change: `contracts/owner-payee.sh` (read its header first).

## The keeper (engine)

Started by `npm start` and `npm run serve` when `PUSHD_KEEPER_KEY` and both addresses are set and `PUSHD_KEEPER` is
not `off`; `npm run keeper` runs it once by hand. Every `PUSHD_KEEPER_EVERY_MINUTES` (15) it sends at most two
calls, both with no value: `sweep()` on the splitter when at least `PUSHD_KEEPER_MIN_SWEEP_ETH` waits, and `burn(0)`
on the burn pot when the pot's own `preview()` says a burn would go through. The pot spaces burns out and caps each
by the market's depth. The keeper refuses another chain, a gas price over `PUSHD_KEEPER_MAX_GWEI`, a wallet under
`PUSHD_KEEPER_MIN_GAS_ETH` and more than `PUSHD_KEEPER_DAILY_GAS` gas a day; it writes each transaction down before
it is broadcast and never sends while one is out. Its numbers are in the engine's store (`meta`, key `keeper`).
The key is read in `keeper-chain.ts` only, never logged or shown; every message is scrubbed of node addresses and
anything key-like.

## Holders

A holder signs one message in MetaMask: a Sign-In With Ethereum text (EIP-4361, signed as EIP-191 `personal_sign`)
that names the site, the wallet, Robinhood Chain, a single-use nonce and an expiry ten minutes out. The engine keeps
the message, recovers the signer from it, refuses a used, expired or unknown nonce and any other signer, then reads
the wallet's $PUSHD with `balanceOf`. From `PUSHD_HOLDER_MIN` (1,000,000 whole $PUSHD by default) a session starts:
a random token in an httpOnly cookie on the site, only its hash in the engine. Under it there is no session.

Every live request checks the session and the balance again, read from the chain at most every
`PUSHD_HOLDER_CACHE_MINUTES` (10) per wallet; when the node is silent the last reading counts for up to six times
that, then not at all. A holder gets the feed with no public delay (`?delay=0` with `Authorization: Bearer`), their
own watchlist (follow and mute, from the shared list) and browser alerts for lines at their heat while PUSHD is open
in a tab. On a phone the sign-in button opens the page in MetaMask's own browser, where it starts by itself.
Before launch (no token) sign-in answers that it opens at launch.

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `PUSHD_BURN_POT_ADDRESS`, `PUSHD_SPLITTER_ADDRESS` | both | empty | The two contracts. Empty: "launching soon", no keeper, no sign-in. |
| `PUSHD_BURN_POT_BLOCK` | engine | empty | Where the burn logs are read from. |
| `PUSHD_TOKEN_ADDRESS` | both | empty | $PUSHD; read from the burn pot when empty. |
| `PUSHD_TOKEN_RPC_URL` | both | the public node | Robinhood Chain RPC. |
| `PUSHD_EXPLORER_URL` | both | Robinhood Chain's Blockscout | Where addresses and transactions link. |
| `PUSHD_HOLDER_MIN` | engine | 1000000 | Whole $PUSHD for the live feed. |
| `PUSHD_HOLDER_CACHE_MINUTES` | engine | 10 | How long a balance reading stands. |
| `PUSHD_HOLDER_SESSION_DAYS` | engine | 7 | How long a sign-in lasts. |
| `PUSHD_SITE_URL` | engine | https://pushd.fun | The site the sign-in message names. |
| `PUSHD_KEEPER` | engine | empty | `off` stops the keeper. |
| `PUSHD_KEEPER_KEY` | engine | empty | The keeper wallet's key. Secret. |
| `PUSHD_KEEPER_RPC_URL` | engine | the read RPC | A node for sending. |
| `PUSHD_KEEPER_EVERY_MINUTES` | engine | 15 | How often it looks. |
| `PUSHD_KEEPER_MIN_GAS_ETH` | engine | 0.0005 | The gas floor. |
| `PUSHD_KEEPER_MAX_GWEI` | engine | 0.5 | The gas price cap. |
| `PUSHD_KEEPER_DAILY_GAS` | engine | 8000000 | Gas a UTC day may use. |
| `PUSHD_KEEPER_MIN_SWEEP_ETH` | engine | 0.0002 | The least a sweep must move. |
| `PUSHD_ENGINE_URL` | site | empty | The engine. |
| `PUSHD_BUY_URL` | site | the token's Pons page | Where "Buy $PUSHD" leads after launch (https only). |
| `PUSHD_LAUNCH_PAGE` | site | empty | `on`: `/token/launch` exists. |
| `PUSHD_LAUNCH_OPENING_BUY_WEI` | site | empty | The opening buy, whole wei, digits only. Empty: "not ready", no button. |
| `PUSHD_LAUNCH_FILE` | site | `../contracts/launch.json` | The launch file the page reads on every request. |

## Tests

```
cd engine && npm test          # config, the /v1/token panel, the keeper, holder sign-in, the API (pretend chain)
cd web && npm test             # the launch page: calldata against contracts/out, every check and refusal
cd web && npm run build && npm run test:smoke
cd contracts && forge test     # the contracts, with a fork test against the real Pons
```

## The rehearsal on a fork

```
scripts/launch-rehearsal.sh               # the whole day on a fork of Robinhood Chain, with screenshots
scripts/launch-rehearsal.sh --no-screens  # the chain part only
```

It forks the live chain with anvil (127.0.0.1:8662), deploys with `contracts/token-deploy.sh` from a throwaway
deployer (its key typed into forge's prompt by `expect`), starts the engine and the built site against the fork, and
then: every refusal of the launch page and its calldata compared byte for byte with `LaunchToken.s.sol`'s dry run;
the page in headless Chrome with an injected wallet (wrong wallet, short of ETH, ready, the button pressed on a
snapshot that is rolled back); the launch as the page builds it, sent from the impersonated launch wallet; a buy
and a sell paying exactly 3%; the engine's keeper (`npm run keeper`, a throwaway key) sweeping and burning, with
`totalSupply` falling by exactly what was burned and `/v1/token` reading it; a wallet holding $PUSHD signing in and
getting the live feed, one without refused; and the pages after the launch, holder sign-in in the browser included.
Every key is made for the run and stays in the shell. Addresses land in `contracts/broadcast/token.fork.env`, never
`token.env`. Screenshots go to `web/shots/token/`.
