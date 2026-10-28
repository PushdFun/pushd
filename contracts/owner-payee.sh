#!/bin/zsh
# Hands the owner share of $PUSHD's fees to another address, in the splitter's two steps, or shows who is paid now.
#
#   contracts/owner-payee.sh status                       who is paid now and what is proposed (no key)
#   contracts/owner-payee.sh propose <the new address>    step 1, with the CURRENT owner wallet's key
#   contracts/owner-payee.sh accept                       step 2, with the NEW address's key
#   contracts/owner-payee.sh cancel                       withdraws a proposal not yet accepted (current owner's key)
#
# The key is typed or pasted at forge's own prompt (--interactive): nothing shows, nothing lands in the shell's history,
# no file, no env var. The only argument is an address, which is public. Each wallet that signs needs a little ETH for
# gas (well under a cent).
#
# Nothing changes until the new address accepts, so a mistyped address changes nothing: cancel it, or propose again.
# From the acceptance on, the owner share of every split goes to the new address; everything split before stays the
# old wallet's. The shares and the burn pot never change. The new address must be a plain wallet whose key you hold.
#
# Steps, each printed as it starts: 1/3 a dry run with its cost, 2/3 the transaction (the key), 3/3 read back.
# PUSHD_DRY=1 stops after step 1. PUSHD_DEPLOY_RPC=<a local fork> rehearses it there.
. "$(dirname "$0")/lib.sh"
CMD=$1
TMP=$(mktemp -t pushd-owner-payee); trap 'rm -f $TMP' EXIT
USAGE="contracts/owner-payee.sh status | propose <the new address> | accept | cancel"

chain_or_die
load_token
S=$PUSHD_SPLITTER_ADDRESS
OWNER=$(cast call $S "owner()(address)" --rpc-url "$RPC") || die "could not read the splitter"
PROPOSED=$(cast call $S "proposedOwner()(address)" --rpc-url "$RPC") || die "could not read the splitter"
echo "  splitter        $S"
echo "  paid now        $OWNER"
[ "$PROPOSED" = "$ZERO" ] && echo "  proposed        nothing" || echo "  proposed        $PROPOSED (not yet accepted)"

case "$CMD" in
  status)
    [ -z "$2" ] || die "status takes nothing more. $USAGE"
    exit 0 ;;
  propose)
    NEXT=$2
    is_address "$NEXT" && [ -z "$3" ] || die "say the new address: contracts/owner-payee.sh propose <the new address>"
    [ "$(low $NEXT)" != "$(low $ZERO)" ] || die "the zero address cannot be paid"
    [ "$(low $NEXT)" != "$(low $OWNER)" ] || die "$NEXT is already the owner wallet"
    for x in $PUSHD_BURN_POT_ADDRESS $S; do [ "$(low $NEXT)" != "$(low $x)" ] || die "$NEXT is one of the token's own contracts"; done
    has_code $NEXT && die "$NEXT has code on it: use a plain wallet whose key you hold (it must sign the acceptance)"
    SENDER=$OWNER; WHO="the CURRENT owner wallet ($OWNER)"; SIG=("propose(address)" $NEXT) ;;
  accept)
    [ -z "$2" ] || die "accept takes nothing more: the key decides. $USAGE"
    [ "$PROPOSED" != "$ZERO" ] || die "nothing is proposed. First: contracts/owner-payee.sh propose <the new address>"
    SENDER=$PROPOSED; WHO="the NEW address ($PROPOSED)"; SIG=("accept()") ;;
  cancel)
    [ -z "$2" ] || die "cancel takes nothing more. $USAGE"
    [ "$PROPOSED" != "$ZERO" ] || die "nothing is proposed, so there is nothing to cancel"
    SENDER=$OWNER; WHO="the current owner wallet ($OWNER)"; SIG=("cancel()") ;;
  *) die "say what to do: $USAGE" ;;
esac

BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read $SENDER's balance"
step "1/3 a dry run from $WHO: nothing sent"
forge script script/OwnerPayee.s.sol --sig "${SIG[@]}" --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
echo "  one transaction, about $GAS gas; forge wants up to $NEED ETH in $SENDER (about \$$(usd $NEED_WEI $(eth_usd))); it holds $(eth $BAL) ETH"
if [ -n "$DRY" ]; then echo; echo "DRY RUN ONLY (PUSHD_DRY is set). Nothing was sent and no key was asked for."; exit 0; fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || die "$SENDER holds $(eth $BAL) ETH and needs up to $NEED ETH for gas. Nothing was sent."

step "2/3 forge now asks for the private key of $WHO (nothing shows as it is typed or pasted)"
forge script script/OwnerPayee.s.sol --sig "${SIG[@]}" --rpc-url "$RPC" --broadcast --interactive --sender $SENDER \
  || die "it did not go through. Read the lines above; run status to see where things stand."

step "3/3 read back from the chain"
NOW=$(cast call $S "owner()(address)" --rpc-url "$RPC")
NOW_PROPOSED=$(cast call $S "proposedOwner()(address)" --rpc-url "$RPC")
echo "  paid now        $NOW"
echo "  proposed        $([ "$NOW_PROPOSED" = "$ZERO" ] && echo nothing || echo $NOW_PROPOSED)"
case "$CMD" in
  propose)
    [ "$(low $NOW_PROPOSED)" = "$(low $NEXT)" ] || die "the proposal does not read back"
    echo; echo "DONE, step 1 of 2. Nothing has changed yet. Next, with the NEW address's key: contracts/owner-payee.sh accept" ;;
  accept)
    [ "$(low $NOW)" = "$(low $SENDER)" ] || die "the change does not read back"
    grep -v "^PUSHD_OWNER_WALLET=" "$TOKEN_OUT" > $TMP; echo "PUSHD_OWNER_WALLET=$NOW" >> $TMP; cp $TMP "$TOKEN_OUT"
    echo "  $TOKEN_OUT now says PUSHD_OWNER_WALLET=$NOW"
    echo; echo "DONE. From this transaction on, the owner share goes to $NOW. Everything split before stays with $OWNER." ;;
  cancel)
    [ "$NOW_PROPOSED" = "$ZERO" ] || die "the proposal is still there"
    echo; echo "DONE. Cancelled; nothing changed." ;;
esac
