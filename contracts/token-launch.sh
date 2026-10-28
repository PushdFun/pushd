#!/bin/zsh
# Launches $PUSHD on Pons through the burn pot, from the launcher wallet, with the opening buy inside the same
# transaction.
#
#   contracts/token-launch.sh
#
# One thing is asked for: the launcher wallet's private key, at forge's own prompt (nothing shows). Everything else is
# read: the contracts and the wallets from contracts/broadcast/token.env (written by token-deploy.sh, and handed to
# the launcher), the shares from contracts/split.local.json when it is on this machine (otherwise from the splitter), the launch fee from Pons, the name, ticker, picture link,
# description and links from contracts/launch.json, and the opening buy as the dollars written there (openingBuyUsd;
# "0" for none) turned into ETH at Chainlink's ETH price at that moment. Its tokens go to the launcher wallet.
#
# Run it only once the site has the burn pot's and the splitter's addresses and the keeper's key, and /token says the
# contracts are live: fees start arriving with the first trade.
#
# Steps, each printed as it starts:
#   1/4 the deployment, the launch file and the opening buy   3/4 the launch (the key)
#   2/4 a dry run, with what it costs                         4/4 $PUSHD read back from the chain
#
# Pons' launch fee must be the launchFeeWei written in launch.json, and the hash of its launch terms that the dry run
# saw is handed to the real run and into the launch itself, so if Pons changes its terms in between, it stops.
# Nothing is sent before step 3. What is fixed for good once it runs: everything in launch.json, the creator tax and
# where the fees go (the splitter).
. "$(dirname "$0")/lib.sh"
JSON=${PUSHD_LAUNCH_FILE:-$HERE/launch.json}
TMP=$(mktemp -t pushd-launch); trap 'rm -f $TMP' EXIT

step "1/4 the deployment, the launch file and the opening buy"
chain_or_die
load_token
if [ -f "$HERE/split.local.json" ]; then
  load_split
else
  # the launcher's machine: the shares were checked at deploy; read them back so the launch checks the same wiring
  export PUSHD_SPLIT_OWNER_BPS=$(cast call $PUSHD_SPLITTER_ADDRESS "ownerBps()(uint16)" --rpc-url "$RPC" | num) \
    PUSHD_SPLIT_BURN_BPS=$(cast call $PUSHD_SPLITTER_ADDRESS "burnBps()(uint16)" --rpc-url "$RPC" | num)
  [ -n "$PUSHD_SPLIT_OWNER_BPS" ] && [ -n "$PUSHD_SPLIT_BURN_BPS" ] || die "could not read the splitter"
fi
DEPLOYER=$PUSHD_LAUNCHER_WALLET
TOKEN=$(cast call $PUSHD_BURN_POT_ADDRESS "token()(address)" --rpc-url "$RPC") || die "could not read the burn pot"
[ "$TOKEN" = "$ZERO" ] || die "\$PUSHD is already launched: $TOKEN. A second launch is not possible."
[ -f "$JSON" ] || die "contracts/launch.json is missing"
python3 - "$JSON" <<'PY' || die "contracts/launch.json is not ready. Nothing was sent."
import json, sys
d = json.load(open(sys.argv[1]))
bad = [k for k in ("name", "symbol", "logo", "description", "website", "twitter") if not isinstance(d.get(k), str) or not d[k].strip()]
if bad: print("  missing:", ", ".join(bad)); sys.exit(1)
if any("REPLACE" in str(d[k]) for k in d): print("  it still holds a REPLACE ME placeholder (the picture's link or the X link)"); sys.exit(1)
if d["symbol"] != "PUSHD": print("  the ticker is not PUSHD"); sys.exit(1)
if not d["logo"].startswith("https://"): print("  the picture's link is not https://"); sys.exit(1)
if "Robinhood" in d["name"] + d["description"]: print("  the name or description says 'Robinhood' as one word"); sys.exit(1)
if chr(8212) in d["name"] + d["description"] or chr(8211) in d["name"] + d["description"]: print("  the description has a long dash in it"); sys.exit(1)
import re
if re.search(r"\d+\s*(%|percent)", d["description"]): print("  the description gives a percentage: it never shows how the fees are shared"); sys.exit(1)
if not isinstance(d.get("openingBuyUsd"), str) or not d["openingBuyUsd"].isdigit(): print("  openingBuyUsd must be whole dollars as digits in quotes (\"0\" for none)"); sys.exit(1)
if not isinstance(d.get("launchFeeWei"), str) or not d["launchFeeWei"].isdigit(): print("  launchFeeWei must be Pons' launch fee in wei, as digits in quotes"); sys.exit(1)
PY
NAME=$(python3 -c "import json; print(json.load(open('$JSON'))['name'])")
OPENING_BUY_USD=$(python3 -c "import json; print(int(json.load(open('$JSON'))['openingBuyUsd']))")
LOGO=$(python3 -c "import json; print(json.load(open('$JSON'))['logo'])")
if [ "$RPC" = "$LIVE" ]; then
  KIND=$(curl -s -m 20 -o /dev/null -w '%{http_code} %{content_type}' "$LOGO")
  case "$KIND" in "200 image/"*) ;; *) die "the picture's link does not answer with a picture yet ($LOGO gave: $KIND). Nothing was sent." ;; esac
fi
FEE=$(cast call $FACTORY "launchFee()(uint256)" --rpc-url "$RPC" | num) || die "could not read the launch fee"
ROUND=$(cast call $ETH_USD_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC") || die "could not read the ETH price from Chainlink"
USD=$(echo "$ROUND" | sed -n 2p | num)
python3 -c "import sys; sys.exit(0 if 10000000000 < int('$USD') < 100000000000000 else 1)" || die "the ETH price read from Chainlink does not look right ($USD)"
# whole numbers only: dollars times 10^26, over the price with its 8 decimals, is wei
OPENING_BUY=$(python3 -c "print($OPENING_BUY_USD * 10**26 // int('$USD'))")
BAL=$(cast balance $DEPLOYER --rpc-url "$RPC")
echo "  burn pot $PUSHD_BURN_POT_ADDRESS, splitter $PUSHD_SPLITTER_ADDRESS"
echo "  launcher wallet $DEPLOYER holds $(eth $BAL) ETH"
echo "  $NAME (\$PUSHD)  $LOGO"
echo "  launch fee $(eth $FEE) ETH; opening buy \$$OPENING_BUY_USD = $(eth $OPENING_BUY) ETH"

step "2/4 a dry run: the whole launch against the chain as it is now, nothing sent"
export PUSHD_OPENING_BUY_WEI=$OPENING_BUY PUSHD_LAUNCH_JSON="$(cat $JSON)"
forge script script/LaunchToken.s.sol --rpc-url "$RPC" --sender $DEPLOYER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
ECON=$(grep "PUSHD_EXPECTED_ECONOMICS=" $TMP | tail -1 | sed 's/.*PUSHD_EXPECTED_ECONOMICS=//')
[[ "$ECON" =~ '^0x[0-9a-fA-F]{64}$' ]] || { tail -15 $TMP; die "the dry run did not say what Pons' launch terms are, so nothing was sent"; }
export PUSHD_EXPECTED_ECONOMICS=$ECON
ALL=$(python3 -c "print(int('$FEE') + int('$OPENING_BUY') + int('$NEED_WEI'))")
grep -E "Opening buy:" $TMP | sed 's/^ */  /'
echo "  one transaction, about $GAS gas; in all the wallet needs $(eth $ALL) ETH (fee + opening buy + up to $NEED ETH of gas, about \$$(usd $ALL $USD))"
if [ -n "$DRY" ]; then
  python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$ALL') else 1)" || echo "  note: the deployer holds $(eth $BAL) ETH; the launch needs $(eth $ALL) ETH"
  echo; echo "DRY RUN ONLY (PUSHD_DRY is set). Nothing was sent and no key was asked for."; exit 0
fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$ALL') else 1)" || die "the deployer holds $(eth $BAL) ETH and the launch needs $(eth $ALL) ETH. Nothing was sent."

step "3/4 the launch: forge now asks for the launcher wallet's private key (nothing shows as it is typed or pasted)"
forge script script/LaunchToken.s.sol --rpc-url "$RPC" --broadcast --interactive --sender $DEPLOYER \
  || die "the launch did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 \$PUSHD, read back from the chain"
TOKEN=$(cast call $PUSHD_BURN_POT_ADDRESS "token()(address)" --rpc-url "$RPC")
[ "$TOKEN" != "$ZERO" ] || die "the burn pot has no token: the launch transaction did not go through"
forge script script/LaunchToken.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 || { tail -15 $TMP; die "\$PUSHD is launched ($TOKEN) but it does not read back as meant"; }
grep -E "OK:|opening buy" $TMP | sed 's/^ */  /'
grep -v "^PUSHD_TOKEN_ADDRESS=" "$TOKEN_OUT" > $TMP; echo "PUSHD_TOKEN_ADDRESS=$TOKEN" >> $TMP; cp $TMP "$TOKEN_OUT"
echo "  written to $TOKEN_OUT"
echo
echo "DONE. \$PUSHD is live: $TOKEN. Last: set PUSHD_TOKEN_ADDRESS=$TOKEN on the site and the engine (it drives the burn"
echo "panel's supply, the holder check and the Buy button; nothing in the burn path waits on it)."
