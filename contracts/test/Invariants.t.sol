// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TokenTest} from "./TokenTest.sol";
import {PushdBurnPot} from "../src/PushdBurnPot.sol";
import {PushdSplitter} from "../src/PushdSplitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Rejecter} from "./mocks/Actors.sol";
import {MockCurve, MockPushdToken} from "./mocks/MockPons.sol";

/// Everything anyone can do to the pot and the splitter, in any order: trades that leave fees on the curve, ETH sent
/// straight in, sweeps, claims, distributes, retries, $PUSHD paid in for credits, burns, time passing, owner
/// wallets refusing their ETH and taking it again, the owner wallet handing its share to one of three wallets and back (proposing, cancelling, accepting), and everyone else trying to do any of that. The fuzzer calls
/// these with random arguments; the invariants below must hold after every call.
contract PotSplitterHandler is Test {
    PushdBurnPot internal immutable pot;
    PushdSplitter internal immutable splitter;
    MockPushdToken internal immutable token;
    MockCurve internal immutable curve;
    address internal immutable trader = makeAddr("invariant trader");
    address internal immutable stranger = makeAddr("invariant stranger");
    /// The wallets the owner share can be paid to: the first is the one deployed with. Each has its own other wallet
    /// to collect a refused share into.
    Rejecter[3] internal payees;
    address[3] internal payeeSinks;

    /// Who the owner wallet should be, and what should be proposed, by the calls that were allowed to go through.
    address public ghostOwner;
    address public ghostProposed;
    /// The owner share split while each wallet was the owner: the line every payee's money must match.
    mapping(address => uint256) public ghostAccrued;
    /// Changes that went through.
    uint256 public ghostChanges;
    /// Calls to propose, cancel or accept whose outcome was not what the rules say (one by the wrong wallet that went
    /// through, or one by the right wallet that failed).
    uint256 public ghostWrongOutcome;

    /// ETH sent straight to the splitter, outside Pons.
    uint256 public ghostDirect;
    /// Burns that went through; ones that came sooner than half an hour after the last; ones that spent more than the
    /// market's depth cap allowed at that moment; ones where the pot kept $PUSHD afterwards.
    uint256 public ghostBurns;
    uint256 public ghostTooSoon;
    uint256 public ghostOverCap;
    uint256 public ghostTokensLeft;
    /// Splits that moved something: each rounds down by less than a wei per destination.
    uint256 public ghostSplits;

    constructor(
        PushdBurnPot pot_,
        PushdSplitter splitter_,
        MockPushdToken token_,
        MockCurve curve_,
        Rejecter[3] memory payees_
    ) {
        pot = pot_;
        splitter = splitter_;
        token = token_;
        curve = curve_;
        for (uint256 i = 0; i < 3; ++i) {
            payees[i] = payees_[i];
            payeeSinks[i] = makeAddr(string.concat("payee's other wallet ", vm.toString(i)));
        }
        ghostOwner = address(payees_[0]);
    }

    function trade(uint256 eth) external {
        eth = bound(eth, 0.0001 ether, 2 ether);
        vm.deal(trader, eth);
        vm.prank(trader);
        curve.buy{value: eth}(eth, 0, trader);
    }

    function sendStraight(uint256 eth) external {
        eth = bound(eth, 1, 1 ether);
        vm.deal(address(this), eth);
        (bool ok,) = address(splitter).call{value: eth}("");
        require(ok);
        ghostDirect += eth;
    }

    function sweep() external {
        _counted(splitter.sweep);
    }

    function claim() external {
        _counted(splitter.claim);
    }

    function distribute() external {
        _counted(splitter.distribute);
    }

    function retry() external {
        _noSplit(splitter.retry);
    }

    function payTokens(uint256 amount) external {
        uint256 held = token.balanceOf(trader);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(trader);
        token.transfer(address(pot), amount);
    }

    function burn(uint256 floor) external {
        uint256 last = pot.lastBurnAt() == 0 ? pot.startedAt() : pot.lastBurnAt();
        (,, uint256 cap) = pot.market();
        try pot.burn(bound(floor, 0, 1)) returns (uint256 ethIn, uint256) {
            ghostBurns++;
            if (block.timestamp < last + pot.MIN_INTERVAL()) ghostTooSoon++;
            if (ethIn > cap) ghostOverCap++;
            if (token.balanceOf(address(pot)) != 0) ghostTokensLeft++;
        } catch {}
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function payeeRefuses(uint256 i, bool refuse) external {
        payees[i % 3].setAccept(!refuse);
    }

    /// Any wallet that is or was the owner collects its own refused share.
    function payeeCollects(uint256 i) external {
        i %= 3;
        if (splitter.ownerPendingOf(address(payees[i])) == 0) return;
        vm.prank(address(payees[i]));
        splitter.withdrawOwner(payable(payeeSinks[i]));
    }

    /// The owner wallet proposes one of the others.
    function propose(uint256 i) external {
        address next = address(payees[i % 3]);
        if (next == ghostOwner) return;
        vm.prank(ghostOwner);
        splitter.proposeOwnerPayee(payable(next));
        ghostProposed = next;
    }

    function cancel() external {
        if (ghostProposed == address(0)) return;
        vm.prank(ghostOwner);
        splitter.cancelOwnerPayee();
        ghostProposed = address(0);
    }

    function accept() external {
        if (ghostProposed == address(0)) return;
        vm.prank(ghostProposed);
        splitter.acceptOwnerPayee();
        (ghostOwner, ghostProposed) = (ghostProposed, address(0));
        ghostChanges++;
    }

    /// Anyone (a payee, the pot, a stranger) tries to propose, cancel or accept. It must go through
    /// exactly when the rules allow it: propose and cancel by the owner wallet, accept by the proposed address.
    function meddle(uint256 who, uint256 what, uint256 target) external {
        address[5] memory actors = [address(payees[0]), address(payees[1]), address(payees[2]), address(pot), stranger];
        address actor = actors[who % 5];
        // a proposal names one of the payees, or the pot (always refused); a stranger is never a payee here, so every
        // owner wallet stays counted
        address next = actors[target % 4];
        what %= 3;
        bool allowed;
        bytes memory data;
        if (what == 0) {
            data = abi.encodeCall(PushdSplitter.proposeOwnerPayee, (payable(next)));
            allowed = actor == ghostOwner && next != ghostOwner && next != address(pot);
        } else if (what == 1) {
            data = abi.encodeCall(PushdSplitter.cancelOwnerPayee, ());
            allowed = actor == ghostOwner && ghostProposed != address(0);
        } else {
            data = abi.encodeCall(PushdSplitter.acceptOwnerPayee, ());
            allowed = ghostProposed != address(0) && actor == ghostProposed;
        }
        vm.prank(actor);
        (bool ok,) = address(splitter).call(data);
        if (ok != allowed) ghostWrongOutcome++;
        if (!ok) return;
        if (what == 0) {
            ghostProposed = next;
        } else if (what == 1) {
            ghostProposed = address(0);
        } else {
            (ghostOwner, ghostProposed) = (ghostProposed, address(0));
            ghostChanges++;
        }
    }

    function payeeCount() external pure returns (uint256) {
        return 3;
    }

    function payee(uint256 i) external view returns (address wallet, address sink) {
        return (address(payees[i]), payeeSinks[i]);
    }

    /// Runs a call and writes down the owner share it split for whoever was the owner wallet when it ran.
    function _counted(function() external returns (uint256) f) internal {
        uint256 before = splitter.totalSplit();
        uint256 toOwner = splitter.totalToOwner();
        address o = splitter.owner();
        f();
        if (splitter.totalSplit() > before) ghostSplits++;
        ghostAccrued[o] += splitter.totalToOwner() - toOwner;
    }

    function _noSplit(function() external f) internal {
        uint256 toOwner = splitter.totalToOwner();
        f();
        require(splitter.totalToOwner() == toOwner, "retry split something");
    }

    receive() external payable {}
}

contract PotSplitterInvariants is TokenTest {
    PotSplitterHandler internal handler;
    Rejecter[3] internal payees;
    uint256 internal supplyAtLaunch;

    function setUp() public override {
        super.setUp();
        // owner wallets that can refuse ETH, to exercise the pending path
        for (uint256 i = 0; i < 3; ++i) {
            payees[i] = new Rejecter();
            payees[i].setAccept(true);
        }
        Token memory t = _deployToken(
            address(this),
            Wiring(launcher, address(payees[0]), OWNER_BPS, BURN_BPS),
            IPonsV2LaunchFactory(address(factory))
        );
        burnPot = t.burnPot;
        splitter = t.splitter;
        _launch(0.01 ether);
        supplyAtLaunch = token.totalSupply();
        vm.warp(block.timestamp + 10);
        handler = new PotSplitterHandler(burnPot, splitter, token, curve, payees);
        targetContract(address(handler));
    }

    /// The two parts always add up to exactly what was split.
    function invariant_theSplitAddsUp() public view {
        assertEq(splitter.totalToOwner() + splitter.totalToBurn(), splitter.totalSplit());
    }

    /// The owner never gets more than its share, and less only by the rounding of each split; the burn takes that
    /// dust. The owner share counts every wallet that has been the owner.
    function invariant_theSharesHold() public view {
        uint256 total = splitter.totalSplit();
        uint256 n = handler.ghostSplits();
        assertLe(splitter.totalToOwner(), (total * OWNER_BPS) / 10_000);
        assertGe(splitter.totalToOwner() + n, (total * OWNER_BPS) / 10_000);
        assertGe(splitter.totalToBurn(), (total * BURN_BPS) / 10_000);
    }

    /// No ETH is lost or stuck: every wei split is either where it was sent or waiting as pending for its own wallet,
    /// and the splitter always holds at least the pending shares (unsplit() never underflows). Across owner changes,
    /// each wallet has exactly the owner share split while it was the owner: no more, no less.
    function invariant_noEthIsLostOrStuck() public view {
        uint256 owners;
        uint256 pendingOf;
        for (uint256 i = 0; i < handler.payeeCount(); ++i) {
            (address w, address sink) = handler.payee(i);
            uint256 has = w.balance + sink.balance + splitter.ownerPendingOf(w);
            assertEq(has, handler.ghostAccrued(w), "a wallet has what was split while it was the owner");
            owners += has;
            pendingOf += splitter.ownerPendingOf(w);
        }
        assertEq(owners, splitter.totalToOwner(), "owner");
        assertEq(pendingOf, splitter.ownerPending(), "the owner's pending, by wallet");
        assertGe(address(splitter).balance, splitter.ownerPending() + splitter.burnPending());
        splitter.unsplit();
        // the pot's ETH is only ever burn budget: what arrived for it, less what it spent buying $PUSHD (the opening
        // buy is the launcher's own ETH and never part of it)
        assertEq(
            address(burnPot).balance + burnPot.totalEthBurned(), splitter.totalToBurn() - splitter.burnPending(), "pot"
        );
    }

    /// Burns really lower the supply: the supply is what it was at the launch less every $PUSHD burned.
    function invariant_theSupplyFallsByExactlyWhatWasBurned() public view {
        assertEq(token.totalSupply() + burnPot.totalTokensBurned(), supplyAtLaunch);
        assertEq(burnPot.burnCount(), handler.ghostBurns());
    }

    /// Every burn kept the schedule and the depth cap, and left no $PUSHD behind.
    function invariant_everyBurnKeptItsLimits() public view {
        assertEq(handler.ghostTooSoon(), 0, "a burn inside the half hour");
        assertEq(handler.ghostOverCap(), 0, "a burn over the depth cap");
        assertEq(handler.ghostTokensLeft(), 0, "a burn that left tokens in the pot");
    }

    /// Nothing about where the fees go can change after deployment, except the owner wallet, and that only by the
    /// owner wallet's proposal and the proposed address's acceptance.
    function invariant_theWiringNeverChanges() public view {
        assertEq(splitter.owner(), handler.ghostOwner(), "the owner wallet is the one the allowed calls made it");
        assertEq(splitter.proposedOwner(), handler.ghostProposed());
        assertEq(handler.ghostWrongOutcome(), 0, "a propose, cancel or accept went against the rules");
        assertEq(splitter.burnPot(), address(burnPot));
        assertEq(splitter.ownerBps(), OWNER_BPS);
        assertEq(splitter.burnBps(), BURN_BPS);
        assertEq(burnPot.splitter(), address(splitter));
        assertEq(address(burnPot.token()), address(token));
    }
}
