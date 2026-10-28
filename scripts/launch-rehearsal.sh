#!/bin/zsh
# The whole $PUSHD launch, rehearsed on a local fork of Robinhood Chain. Rerunnable; nothing reaches the real chain
# and no real key is used.
#
#   scripts/launch-rehearsal.sh               the whole rehearsal, with screenshots when Chrome is installed
#   scripts/launch-rehearsal.sh --no-screens  without the browser
#
# 1. anvil forks the live chain on 127.0.0.1:8662 (FORK_PORT to change it)
# 2. contracts/token-deploy.sh deploys the burn pot and the splitter onto the fork from a throwaway deployer (a key
#    made here for the fork, typed into forge's prompt by expect), with a throwaway launch wallet and owner; the
#    shares come from contracts/split.local.json as on deploy day. Addresses land in contracts/broadcast/token.fork.env
# 3. the engine (npm run serve) and the built site (next start) start against the fork, with the addresses set
# 4. the launch page's server against the fork (web/scripts/launch-rehearsal.ts before): every refusal, and its call
#    compared byte for byte with contracts/script/LaunchToken.s.sol's dry run
# 5. the launch page in headless Chrome (web/scripts/screens.mjs pre): wrong wallet, short of ETH, ready, and the button
#    pressed on a snapshot of the fork that is rolled back
# 6. the launch: the page's server builds it, the launch wallet sends exactly that, impersonated by the fork
# 7. after: the token, the opening buy, the 3% tax on a buy and a sell, the engine's keeper (npm run keeper, with a
#    throwaway keeper key) sweeping and burning, totalSupply falling by exactly what was burned, /v1/token reading it
# 8. holders: a wallet holding $PUSHD signs in through the engine and gets the live feed; one without is refused; the
#    site's own routes: the httpOnly cookie, the live stream, the holder view, another site refused, sign-out
# 9. the pages after the launch (screens.mjs post), holder sign-in in the browser included
#
# The opening buy is $30 at Chainlink's ETH price, as token-launch.sh reckons it (PUSHD_REHEARSAL_BUY_WEI to set it).
# Screenshots go to web/shots/token/ (not in git). Every key here is made for this run and lives only in this shell.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.foundry/bin:$PATH"
LIVE=https://rpc.mainnet.chain.robinhood.com
PORT=${FORK_PORT:-8662}
FORK=http://127.0.0.1:$PORT
WEB_PORT=${WEB_PORT:-3911}
SOON_PORT=${SOON_PORT:-3912}
ENGINE_PORT=${ENGINE_PORT:-3711}
ETH_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
SCREENS=1; [ "${1:-}" = "--no-screens" ] && SCREENS=
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || SCREENS=
WORK=$(mktemp -d -t pushd-launch-rehearsal)
ANVIL_PID=; WEB_PID=; SOON_PID=; ENGINE_PID=
cleanup() {
  for p in $WEB_PID $SOON_PID $ENGINE_PID $ANVIL_PID; do kill $p 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT
die() { echo; echo "STOPPED: $1"; exit 1; }
step() { echo; echo "== $1"; }
wait_http() { for i in {1..120}; do curl -s -o /dev/null -m 30 "$1" && return 0; sleep 1; done; return 1; }
for p in $PORT $WEB_PORT $SOON_PORT $ENGINE_PORT; do lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && die "port $p is taken"; done

step "0/9 the site, built, and its screens before anything exists"
(cd "$ROOT/web" && npm run -s build > "$WORK/build.log" 2>&1) || { tail -20 "$WORK/build.log"; die "the site did not build"; }
if [ -n "$SCREENS" ]; then
  (cd "$ROOT/web" && env -u PUSHD_ENGINE_URL -u PUSHD_BURN_POT_ADDRESS -u PUSHD_TOKEN_ADDRESS node node_modules/next/dist/bin/next start -p $SOON_PORT > "$WORK/soon.log" 2>&1) &
  SOON_PID=$!
  wait_http "http://localhost:$SOON_PORT/token" || die "the site did not start"
  (cd "$ROOT/web" && BASE=http://localhost:$SOON_PORT node scripts/screens.mjs soon) || die "the screens before launch failed"
  kill $SOON_PID 2>/dev/null; SOON_PID=
fi

step "1/9 a fork of Robinhood Chain on $FORK"
anvil --fork-url $LIVE --port $PORT --block-time 2 --block-base-fee-per-gas 20000000 > "$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for i in {1..60}; do cast chain-id --rpc-url $FORK >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url $FORK 2>/dev/null)" = 4663 ] || { tail -5 "$WORK/anvil.log"; die "the fork did not start"; }
echo "  forked at block $(cast block-number --rpc-url $FORK)"

step "2/9 the burn pot and the splitter, deployed onto the fork with contracts/token-deploy.sh"
# cast prints "<address>\t<key>" when it is not talking to a terminal; the keys stay in shell variables
new_wallet() { cast wallet new 2>/dev/null | head -1; }
DEPLOYER_LINE=$(new_wallet); DEPLOYER=${DEPLOYER_LINE%%$'\t'*}; DEPLOY_KEY=${DEPLOYER_LINE#*$'\t'}
LAUNCHER=$(new_wallet | cut -f1)
OWNER=$(new_wallet | cut -f1)
KEEPER_LINE=$(new_wallet); KEEPER=${KEEPER_LINE%%$'\t'*}; FORK_KEEPER_KEY=${KEEPER_LINE#*$'\t'}
HOLDER_LINE=$(new_wallet); HOLDER=${HOLDER_LINE%%$'\t'*}; FORK_HOLDER_KEY=${HOLDER_LINE#*$'\t'}
for a in $DEPLOYER $LAUNCHER $OWNER $KEEPER $HOLDER; do [[ "$a" =~ '^0x[0-9a-fA-F]{40}$' ]] || die "could not make the throwaway wallets"; done
cast rpc anvil_setBalance $DEPLOYER 0xDE0B6B3A7640000 --rpc-url $FORK >/dev/null
cast rpc anvil_setBalance $KEEPER 0x2386F26FC10000 --rpc-url $FORK >/dev/null
echo "  throwaway deployer $DEPLOYER, launch wallet $LAUNCHER, owner $OWNER, keeper $KEEPER (0.01 ETH for gas), holder $HOLDER"
rm -f "$ROOT/contracts/broadcast/token.fork.env"
DEPLOY_KEY=$DEPLOY_KEY PUSHD_DEPLOY_RPC=$FORK \
  expect -c "
    set timeout 900
    log_user 1
    spawn $ROOT/contracts/token-deploy.sh $DEPLOYER $LAUNCHER $OWNER
    expect {
      -re {Enter private key} { log_user 0; send \"\$env(DEPLOY_KEY)\r\"; log_user 1; exp_continue }
      eof
    }
    catch wait r
    exit [lindex \$r 3]
  " > "$WORK/deploy.log" 2>&1 || { grep -v "$DEPLOY_KEY" "$WORK/deploy.log" | tail -20; die "the deploy onto the fork failed"; }
unset DEPLOY_KEY
grep -E "^ *(OK:|burn pot |splitter |deployer |launcher |owner )" "$WORK/deploy.log" | sort -u | sed 's/^ */  /'
ENV_FILE="$ROOT/contracts/broadcast/token.fork.env"
POT=$(grep "^PUSHD_BURN_POT_ADDRESS=" "$ENV_FILE" | cut -d= -f2)
SPLITTER=$(grep "^PUSHD_SPLITTER_ADDRESS=" "$ENV_FILE" | cut -d= -f2)
POT_BLOCK=$(grep "^PUSHD_BURN_POT_BLOCK=" "$ENV_FILE" | cut -d= -f2)
[[ "$POT" =~ '^0x[0-9a-fA-F]{40}$' && "$SPLITTER" =~ '^0x[0-9a-fA-F]{40}$' ]] || die "the deploy wrote no addresses"
echo "  burn pot $POT, splitter $SPLITTER, from block $POT_BLOCK"

if [ -n "${PUSHD_REHEARSAL_BUY_WEI:-}" ]; then
  BUY=$PUSHD_REHEARSAL_BUY_WEI
else
  USD=$(cast call $ETH_USD_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $FORK | sed -n 2p | cut -d' ' -f1)
  BUY=$(python3 -c "print(30 * 10**26 // int('$USD'))")
fi
echo "  opening buy for the rehearsal: $BUY wei (\$30)"

# launch.json as it will be once the domain exists: https links, a logo that answers with a picture
python3 - "$ROOT/contracts/launch.json" "$WORK/launch.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d.update(logo="https://github.githubassets.com/favicons/favicon.png", website="https://pushd.example", twitter="https://x.com/pushd_example")
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY

# The site's and the engine's own settings, pointed at the fork.
cp "$ROOT/engine/data/pushd.sqlite" "$WORK/engine.sqlite" 2>/dev/null || true
export PUSHD_TOKEN_RPC_URL=$FORK PUSHD_BURN_POT_ADDRESS=$POT PUSHD_SPLITTER_ADDRESS=$SPLITTER PUSHD_BURN_POT_BLOCK=$POT_BLOCK \
  PUSHD_LAUNCH_PAGE=on PUSHD_LAUNCH_OPENING_BUY_WEI=$BUY PUSHD_LAUNCH_FILE="$WORK/launch.json" \
  FORK_LAUNCHER=$LAUNCHER FORK_RPC=$FORK FORK_STATE="$WORK/state.json" FORK_ENGINE=http://127.0.0.1:$ENGINE_PORT FORK_ENGINE_DB="$WORK/engine.sqlite" FORK_WEB=http://localhost:$WEB_PORT

step "3/9 the engine and the site, against the fork"
(cd "$ROOT/engine" && PUSHD_DB="$WORK/engine.sqlite" PUSHD_ENGINE_PORT=$ENGINE_PORT PUSHD_KEEPER=off PUSHD_SITE_URL=http://localhost:$WEB_PORT \
  PUSHD_MEDIA_DIR="$ROOT/engine/data/media" npm run -s serve > "$WORK/engine.log" 2>&1) &
ENGINE_PID=$!
wait_http "http://127.0.0.1:$ENGINE_PORT/health" || { tail -20 "$WORK/engine.log"; die "the engine did not start"; }
(cd "$ROOT/web" && PUSHD_ENGINE_URL=http://127.0.0.1:$ENGINE_PORT node node_modules/next/dist/bin/next start -p $WEB_PORT > "$WORK/web.log" 2>&1) &
WEB_PID=$!
wait_http "http://localhost:$WEB_PORT/token/launch" || { tail -20 "$WORK/web.log"; die "the site did not start"; }
echo "  engine on $FORK_ENGINE, site on http://localhost:$WEB_PORT"

cd "$ROOT/web"
step "4/9 the launch page's server against the fork, before the launch"
npx tsx scripts/launch-rehearsal.ts before || die "a check before the launch failed"

if [ -n "$SCREENS" ]; then
  step "5/9 the launch page in a browser against the fork"
  BASE=http://localhost:$WEB_PORT node scripts/screens.mjs pre || { tail -20 "$WORK/web.log"; die "the browser run failed"; }
else
  step "5/9 the browser run is skipped (--no-screens, or no Chrome)"
fi

step "6/9 the launch"
npx tsx scripts/launch-rehearsal.ts launch || die "the launch failed"

step "7/9 after the launch: trades, the keeper, a burn"
FORK_KEEPER_KEY=$FORK_KEEPER_KEY npx tsx scripts/launch-rehearsal.ts after || die "a check after the launch failed"

step "8/9 holder sign-in"
FORK_HOLDER_KEY=$FORK_HOLDER_KEY npx tsx scripts/launch-rehearsal.ts holders || die "a holder check failed"

if [ -n "$SCREENS" ]; then
  step "9/9 the pages after the launch, in a browser"
  FORK_HOLDER_KEY=$FORK_HOLDER_KEY BASE=http://localhost:$WEB_PORT node scripts/screens.mjs post || { tail -20 "$WORK/web.log"; die "the browser run after the launch failed"; }
fi
unset FORK_KEEPER_KEY FORK_HOLDER_KEY

echo
echo "DONE. The rehearsal passed on the fork: burn pot $POT, splitter $SPLITTER."
python3 - "$WORK/state.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
u = lambda w: f"{int(w) / 10**18:,.4f}"
print(f"  token {s.get('token')}  launch tx {s.get('hash')}")
print(f"  burned {u(s.get('burnedTokens', 0))} $PUSHD for {u(s.get('burnedEth', 0))} ETH in {', '.join(s.get('burnTxs', []))}")
print(f"  supply at launch {u(s.get('supplyAtLaunch', 0))}, before the burn {u(s.get('supplyBefore', 0))}, after {u(s.get('supplyAfter', 0))}")
PY
if [ -n "$SCREENS" ]; then echo "Screenshots in web/shots/token/."; fi
