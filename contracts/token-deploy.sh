#!/bin/zsh
# Deploys the burn pot and the splitter of $PUSHD from the deployer wallet, then reads them back from the chain and
# checks every wire. Run it BEFORE the token exists, and give the site the two addresses before launching.
#
#   contracts/token-deploy.sh <the deployer wallet> <the launcher wallet> <the owner wallet>
#
# One thing is asked for: the deployer wallet's private key, typed or pasted at forge's own prompt (--interactive,
# nothing shows, nothing lands in the shell's history). The arguments are addresses, which are public.
#   the deployer wallet  deploys these two and pays their gas. It has no power over either contract afterwards.
#   the launcher wallet  the only wallet that can launch $PUSHD (contracts/token-launch.sh, run from it) and make the
#                        opening buy; the opening buy's tokens land in it. It has no other power. It may be the
#                        deployer wallet or another one.
#   the owner wallet     receives the owner's share of the fees. Only it can later hand that share to another
#                        address, in two steps (contracts/owner-payee.sh); nothing else in the splitter can change.
# The shares come from contracts/split.local.json (on this Mac only, never in git).
#
# Steps, each printed as it starts:
#   1/4 the chain and the wallets        3/4 the deploy (the key)
#   2/4 a dry run, with what it costs    4/4 the check, and the addresses written to contracts/broadcast/token.env
#
# PUSHD_DRY=1 stops after step 2 (nothing sent, no key asked). PUSHD_DEPLOY_RPC=<a local fork> rehearses it there.
. "$(dirname "$0")/lib.sh"
DEPLOYER=$1
export PUSHD_LAUNCHER_WALLET=$2
export PUSHD_OWNER_WALLET=$3
TMP=$(mktemp -t pushd-token-deploy); trap 'rm -f $TMP' EXIT
CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null)
RECORD="$HERE/broadcast/DeployToken.s.sol/$CHAIN/run-latest.json"

[ -z "$4" ] && is_address "$DEPLOYER" && is_address "$PUSHD_LAUNCHER_WALLET" && is_address "$PUSHD_OWNER_WALLET" \
  || die "say which wallets: contracts/token-deploy.sh <the deployer wallet> <the launcher wallet> <the owner wallet>"

step "1/4 the chain and the wallets"
chain_or_die
load_split
BAL=$(cast balance $DEPLOYER --rpc-url "$RPC") || die "could not read the deployer's balance"
has_code $PUSHD_OWNER_WALLET && die "the owner wallet $PUSHD_OWNER_WALLET has code on it: its share could be refused. Use a plain wallet."
echo "  deployer   $DEPLOYER  holds $(eth $BAL) ETH"
echo "  launcher   $PUSHD_LAUNCHER_WALLET (the only wallet that can launch \$PUSHD)"
has_code $PUSHD_LAUNCHER_WALLET && die "the launcher wallet $PUSHD_LAUNCHER_WALLET has code on it: it must be a plain wallet that signs the launch."
[ "$(low $PUSHD_LAUNCHER_WALLET)" = "$(low $PUSHD_OWNER_WALLET)" ] && echo "  note: the launcher and the owner are the same wallet"
echo "  owner      $PUSHD_OWNER_WALLET"
echo "  the shares from contracts/split.local.json add up"
OLD=$(tval PUSHD_SPLITTER_ADDRESS)
if [ -n "$OLD" ] && has_code $OLD; then
  die "the token's contracts are already deployed on this chain (splitter $OLD, in $TOKEN_OUT). A second set would split the fees."
fi

step "2/4 a dry run: the whole deploy against the chain as it is now, nothing sent"
forge script script/DeployToken.s.sol --rpc-url "$RPC" --sender $DEPLOYER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
POT=$(grep "PUSHD_BURN_POT_ADDRESS=" $TMP | tail -1 | sed 's/.*=//')
SPLIT=$(grep "PUSHD_SPLITTER_ADDRESS=" $TMP | tail -1 | sed 's/.*=//')
is_address "$POT" && is_address "$SPLIT" || { tail -15 $TMP; die "the dry run did not say where the contracts would be"; }
echo "  two contracts, about $GAS gas; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI $(eth_usd)))"
echo "  burn pot  $POT"
echo "  splitter  $SPLIT (the address the token's fees will be paid to)"
if [ -n "$DRY" ]; then
  python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || echo "  note: the deployer holds $(eth $BAL) ETH; the deploy needs up to $NEED ETH"
  echo; echo "DRY RUN ONLY (PUSHD_DRY is set). Nothing was sent and no key was asked for."; exit 0
fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || die "the deployer holds $(eth $BAL) ETH and the deploy needs up to $NEED ETH. Nothing was sent."

step "3/4 the deploy: forge now asks for the deployer wallet's private key (nothing shows as it is typed or pasted)"
BLOCK=$(cast block-number --rpc-url "$RPC")
forge script script/DeployToken.s.sol --rpc-url "$RPC" --broadcast --interactive --sender $DEPLOYER \
  || die "the deploy did not go through. Read the lines above. If one of the two was sent and not the other, do not launch: say so first."

step "4/4 the check: the addresses forge recorded, read back from the chain"
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] || die "forge's record of the deploy ($RECORD) is missing. The contracts may be on the chain: do NOT deploy again; look at the deployer's transactions."
SENT=$(python3 - "$RECORD" "$DEPLOYER" <<'PY'
import json, sys
want = {"PushdBurnPot": "PUSHD_BURN_POT_ADDRESS", "PushdSplitter": "PUSHD_SPLITTER_ADDRESS"}
try: txs = json.load(open(sys.argv[1]))["transactions"]
except Exception: sys.exit(1)
if len(txs) != 2 or sorted(str(t.get("contractName")) for t in txs) != sorted(want): sys.exit(1)
for t in txs:
    if t.get("transactionType") != "CREATE" or str((t.get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
    print(f'{want[t["contractName"]]}={t.get("contractAddress")}')
PY
) || die "forge's record is not the two contracts from the deployer. Do NOT deploy again; look at the deployer's transactions."
eval "$(echo "$SENT" | sed 's/^/export /')"
export PUSHD_BURN_POT_ADDRESS=$(cast to-check-sum-address $PUSHD_BURN_POT_ADDRESS) PUSHD_SPLITTER_ADDRESS=$(cast to-check-sum-address $PUSHD_SPLITTER_ADDRESS)
forge script script/DeployToken.s.sol --sig "check(address)" $PUSHD_LAUNCHER_WALLET --rpc-url "$RPC" > $TMP 2>&1 || { tail -15 $TMP; die "the contracts are deployed but do not read back as meant. Do not launch."; }
grep -E "OK:|burn pot|splitter|owner|launcher" $TMP | sed 's/^ */  /'
mkdir -p "$HERE/broadcast"
{
  echo "PUSHD_DEPLOYER=$DEPLOYER"
  echo "PUSHD_LAUNCHER_WALLET=$PUSHD_LAUNCHER_WALLET"
  echo "PUSHD_OWNER_WALLET=$PUSHD_OWNER_WALLET"
  echo "PUSHD_BURN_POT_ADDRESS=$PUSHD_BURN_POT_ADDRESS"
  echo "PUSHD_SPLITTER_ADDRESS=$PUSHD_SPLITTER_ADDRESS"
  echo "PUSHD_BURN_POT_BLOCK=$BLOCK"
} > "$TOKEN_OUT"
echo "  written to $TOKEN_OUT"
echo
echo "DONE. Next, BEFORE the launch: set PUSHD_BURN_POT_ADDRESS, PUSHD_SPLITTER_ADDRESS and PUSHD_BURN_POT_BLOCK on the"
echo "site with the keeper's key, redeploy it and see /token say the contracts are live (docs/token.md). Then the launcher wallet runs token-launch.sh."
