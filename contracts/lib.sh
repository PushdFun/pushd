# Shared by the scripts in this folder. Sourced, never run.
#
# Everything here is public: addresses, the node's address, numbers read from the chain. The one secret a script
# needs is the deployer's key, and that is typed or pasted at forge's own prompt (--interactive), where nothing shows.
# It is never an argument, never in a file, never in the environment and never in the shell's history.
export PATH="$HOME/.foundry/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"
LIVE=https://rpc.mainnet.chain.robinhood.com
# A rehearsal points PUSHD_DEPLOY_RPC at a local fork. On the day nobody sets anything.
RPC=${PUSHD_DEPLOY_RPC:-$LIVE}
ETH_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
NODE_INTERFACE=0x00000000000000000000000000000000000000C8
[ "$RPC" = "$LIVE" ] && OUT="$HERE/broadcast/registry.env" || OUT="$HERE/broadcast/registry.fork.env"
# PUSHD_DRY=1 stops deploy.sh just before it would ask for the key: everything is read and checked, and the dry run
# is made, but nothing is sent.
DRY=${PUSHD_DRY:-}

step() { echo; echo "== $1"; }
die() { echo; echo "STOPPED: $1"; exit 1; }
num() { cut -d' ' -f1; }
low() { echo "$1" | tr A-Z a-z; }
eth() { python3 -c "w=int('$1'); print(f'{w // 10**18}.{w % 10**18:018d}'.rstrip('0').rstrip('.') or '0')"; }
is_address() { [[ "$1" =~ '^0x[0-9a-fA-F]{40}$' ]]; }
has_code() { [ "$(cast code "$1" --rpc-url "$RPC")" != "0x" ]; }

chain_or_die() {
  local chain
  chain=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "the node at $RPC did not answer"
  [ "$chain" = 4663 ] || [ "$RPC" != "$LIVE" -a "$chain" = 31337 ] || die "this is chain $chain, not Robinhood Chain (4663)"
  echo "  Robinhood Chain ($chain) at $RPC"
}

# ETH / USD with 8 decimals, from Chainlink's feed on the chain.
eth_usd() { cast call $ETH_USD_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$LIVE" 2>/dev/null | sed -n 2p | num; }

# Dollars for an amount of wei at a given ETH price (8 decimals), to a tenth of a cent.
usd() { python3 -c "m=int('$1')*int('$2')//10**23; print(f'{m // 1000}.{m % 1000:03d}')"; }

# ---------- $PUSHD (token-deploy.sh, token-launch.sh, token-cost.sh) ----------
FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
ZERO=0x0000000000000000000000000000000000000000
[ "$RPC" = "$LIVE" ] && TOKEN_OUT="$HERE/broadcast/token.env" || TOKEN_OUT="$HERE/broadcast/token.fork.env"
tval() { grep "^$1=" "$TOKEN_OUT" 2>/dev/null | tail -1 | cut -d= -f2; }

# The two shares of the fees, from contracts/split.local.json (on this Mac only, never in git), exported under the
# names the forge scripts read. Stops unless they are two whole numbers above zero that add up to 10,000.
load_split() {
  local f="$HERE/split.local.json"
  [ -f "$f" ] || die "contracts/split.local.json is missing. It holds the two shares of the fees and is never in git."
  eval "$(python3 - "$f" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
k = ("ownerBps", "burnBps")
v = [d.get(x) for x in k]
if set(d) != set(k) or not all(isinstance(x, int) and 0 < x < 10000 for x in v) or sum(v) != 10000: sys.exit(1)
print(f"export PUSHD_SPLIT_OWNER_BPS={v[0]} PUSHD_SPLIT_BURN_BPS={v[1]}")
PY
)" || die "contracts/split.local.json must hold exactly two whole numbers above zero (ownerBps, burnBps) adding up to 10000"
}

# The deployment, from the file token-deploy.sh wrote, exported under the names the forge scripts read.
load_token() {
  [ -f "$TOKEN_OUT" ] || die "no deployment found in $TOKEN_OUT. Run contracts/token-deploy.sh first."
  local name v
  for name in PUSHD_DEPLOYER PUSHD_LAUNCHER_WALLET PUSHD_OWNER_WALLET PUSHD_BURN_POT_ADDRESS PUSHD_SPLITTER_ADDRESS; do
    v=$(tval $name)
    is_address "$v" || die "$TOKEN_OUT has no $name"
    export $name=$v
  done
  has_code $PUSHD_SPLITTER_ADDRESS || die "there is no contract at the splitter's address $PUSHD_SPLITTER_ADDRESS on this chain"
}

# What a dry run printed: the gas it would use and the most ETH forge would want in the wallet for it.
read_estimate() {
  GAS=$(grep "Estimated total gas used for script" "$1" | awk '{print $NF}')
  NEED=$(grep "Estimated amount required" "$1" | awk '{print $(NF-1)}')
  [ -n "$GAS" ] && [ -n "$NEED" ] || { tail -15 "$1"; die "the dry run gave no estimate, so nothing was sent"; }
  NEED_WEI=$(cast to-wei "$NEED" ether)
}
