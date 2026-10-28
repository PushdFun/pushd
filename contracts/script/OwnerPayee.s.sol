// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PushdSplitter} from "../src/PushdSplitter.sol";

/// Hands the owner share of $PUSHD's fees to another address, in the splitter's two steps:
///
///   propose(next)  sent by the current owner wallet: names the new address. Nothing changes yet.
///   accept()       sent by the new address: from this transaction on, the owner share of every split goes to it.
///   cancel()       sent by the current owner wallet: withdraws a proposal not yet accepted.
///   status()       reads who is paid now and what is proposed. No key.
///
/// Only the owner wallet's own address can change; the shares and the burn pot stay as they are. What was split before
/// the acceptance stays the old wallet's.
///
/// contracts/owner-payee.sh runs this with the splitter's address from contracts/broadcast/token.env and the key at
/// forge's own prompt. Without --broadcast it is a dry run.
contract OwnerPayee is Script {
    function propose(address next) external {
        PushdSplitter s = _splitter();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == s.owner(), "this key is not the current owner wallet's");
        s.proposeOwnerPayee(payable(next));
        vm.stopBroadcast();
        require(s.proposedOwner() == next, "the proposal does not read back");
        require(s.owner() == sender, "the owner wallet changed on a proposal");
        console.log("Proposed: %s", next);
        console.log("Still paid now: %s (until the new address accepts)", sender);
    }

    function accept() external {
        PushdSplitter s = _splitter();
        address previous = s.owner();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(s.proposedOwner() != address(0), "nothing is proposed");
        require(sender == s.proposedOwner(), "this key is not the proposed address's");
        s.acceptOwnerPayee();
        vm.stopBroadcast();
        require(s.owner() == sender && s.proposedOwner() == address(0), "the change does not read back");
        console.log("Changed: the owner share now goes to %s", sender);
        console.log("Before:  %s (keeps everything split before this)", previous);
        console.log("PUSHD_OWNER_WALLET=%s", sender);
    }

    function cancel() external {
        PushdSplitter s = _splitter();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == s.owner(), "this key is not the current owner wallet's");
        s.cancelOwnerPayee();
        vm.stopBroadcast();
        require(s.proposedOwner() == address(0), "the proposal is still there");
        console.log("Cancelled. Still paid: %s", sender);
    }

    function status() external view {
        PushdSplitter s = _splitter();
        console.log("owner wallet  %s", s.owner());
        console.log("proposed      %s", s.proposedOwner());
        console.log("pending (all) %s wei", s.ownerPending());
    }

    function _splitter() internal view returns (PushdSplitter s) {
        require(block.chainid == 4663, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
        s = PushdSplitter(payable(vm.envAddress("PUSHD_SPLITTER_ADDRESS")));
        require(address(s).code.length > 0, "no contract at PUSHD_SPLITTER_ADDRESS");
    }
}
