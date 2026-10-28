// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenTest} from "./TokenTest.sol";
import {PushdBurnPot} from "../src/PushdBurnPot.sol";
import {PushdSplitter} from "../src/PushdSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Bouncer, GasEater, Reenterer, Rejecter, TogglePot} from "./mocks/Actors.sol";
import {MockFactory} from "./mocks/MockPons.sol";

contract SplitterTest is TokenTest {
    event Split(uint256 amount, uint256 toOwner, uint256 toBurn, bool ownerPushed, bool burnPushed);
    event PendingDelivered(address indexed to, uint256 amount);
    event TokensSentToBurn(uint256 amount);
    event OwnerPayeeProposed(address indexed current, address indexed proposed);
    event OwnerPayeeProposalCancelled(address indexed current, address indexed proposed);
    event OwnerPayeeChanged(address indexed previous, address indexed current);

    address payable internal company = payable(makeAddr("company wallet"));

    // ---------- what it is ----------

    function test_theWiringIsWhatWasDeployed() public view {
        assertEq(splitter.owner(), ownerWallet);
        assertEq(splitter.proposedOwner(), address(0));
        assertEq(splitter.burnPot(), address(burnPot));
        assertEq(address(splitter.escrow()), address(escrow));
        assertEq(splitter.ownerBps(), OWNER_BPS);
        assertEq(splitter.burnBps(), BURN_BPS);
    }

    /// Apart from the owner wallet's own two-step hand-over (tested below), nothing about the splitter can be changed by
    /// anybody: every function that could plausibly do so is absent.
    function test_nothingCanBeSet() public {
        string[9] memory sigs = [
            "setOwner(address)",
            "setBurnPot(address)",
            "setEscrow(address)",
            "setShares(uint16,uint16)",
            "setShares(uint16,uint16,uint16)",
            "transferOwnership(address)",
            "withdraw(address,uint256)",
            "setToken(address)",
            "initialize(address,address,address)"
        ];
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.prank(ownerWallet);
            (bool ok,) = address(splitter).call(abi.encodeWithSignature(sigs[i], ownerWallet, ownerWallet, ownerWallet));
            assertFalse(ok, sigs[i]);
        }
    }

    // ---------- the split ----------

    function test_aRoundAmountSplitsExactly() public {
        vm.deal(address(splitter), 1 ether);
        vm.expectEmit(address(splitter));
        emit Split(1 ether, 0.6 ether, 0.4 ether, true, true);
        vm.prank(stranger);
        assertEq(splitter.distribute(), 1 ether);
        assertEq(ownerWallet.balance, 0.6 ether);
        assertEq(address(burnPot).balance, 0.4 ether);
        assertEq(address(splitter).balance, 0);
        assertEq(splitter.totalSplit(), 1 ether);
        assertEq(splitter.totalToOwner() + splitter.totalToBurn(), 1 ether);
    }

    function test_theRoundingDustIsBurned() public {
        vm.deal(address(splitter), 7);
        splitter.distribute();
        // 7 * 0.6 = 4.2 -> 4, the rest burns
        assertEq(ownerWallet.balance, 4);
        assertEq(address(burnPot).balance, 3);
    }

    function test_nothingToSplitIsANoOp() public {
        assertEq(splitter.distribute(), 0);
        assertEq(splitter.totalSplit(), 0);
    }

    /// Whatever the shares chosen at deployment and whatever arrives, the two parts are exactly what came in, the
    /// owner never gets more than its share, and the burn gets at most one wei of dust on top.
    function testFuzz_anySharesSplitExactly(uint16 ownerBps, uint96 amount) public {
        ownerBps = uint16(bound(ownerBps, 1, 9999));
        uint16 burnBps = 10_000 - ownerBps;
        address o = makeAddr("fuzz owner");
        Token memory t =
            _deployToken(address(this), Wiring(launcher, o, ownerBps, burnBps), IPonsV2LaunchFactory(address(factory)));
        uint256 a = bound(amount, 0, 1e30);
        vm.deal(address(t.splitter), a);
        t.splitter.distribute();
        assertEq(o.balance + address(t.burnPot).balance, a);
        assertEq(o.balance, (a * ownerBps) / 10_000);
        assertLe(address(t.burnPot).balance - (a * burnBps) / 10_000, 1);
        assertEq(address(t.splitter).balance, 0);
    }

    function test_ethSentStraightHereWaitsForDistribute() public {
        (bool ok,) = address(splitter).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(splitter.unsplit(), 1 ether);
        assertEq(ownerWallet.balance, 0);
        splitter.distribute();
        assertEq(ownerWallet.balance, 0.6 ether);
    }

    // ---------- fees from Pons ----------

    function test_beforeTheLaunchThereIsNoCurve() public view {
        assertEq(splitter.curve(), address(0));
    }

    function test_sweepReleasesTheCurveClaimsTheEscrowAndSplits() public {
        _launch(0);
        assertEq(splitter.curve(), address(curve));
        _trade(1 ether);
        assertEq(curve.pendingFees(), 0.04 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0, "still on the curve");
        vm.prank(stranger);
        uint256 amount = splitter.sweep();
        assertEq(amount, 0.037 ether, "the creator's part of the stand-in's fees");
        assertEq(ownerWallet.balance, 0.0222 ether);
        assertEq(address(burnPot).balance, 0.0148 ether);
        assertEq(curve.pendingFees(), 0);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    function test_onlyTheSplitterOrPonsCanReleaseTheCurve() public {
        _launch(0);
        _trade(1 ether);
        vm.prank(stranger);
        vm.expectRevert("NotFeeSweepOperator");
        curve.sweepFees(0);
    }

    function test_sweepWithNothingOnTheCurveStillClaimsAndNeverReverts() public {
        _launch(0);
        escrow.credit{value: 0.5 ether}(address(splitter));
        assertEq(splitter.sweep(), 0.5 ether);
        assertEq(ownerWallet.balance, 0.3 ether);
        assertEq(splitter.sweep(), 0, "and again with nothing anywhere");
    }

    function test_claimTakesTheEscrowAlone() public {
        _launch(0);
        _trade(1 ether);
        vm.prank(factory.operator());
        curve.sweepFees(0); // Pons' keeper released it
        assertEq(splitter.claim(), 0.037 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    function test_afterGraduationThereIsNoCurveAndLateFeesStillSplit() public {
        _launch(0);
        _graduate(2 ** 96, 1e24);
        assertEq(splitter.curve(), address(0));
        assertEq(splitter.sweep(), 0, "nothing yet");
        escrow.credit{value: 0.2 ether}(address(splitter)); // an hourly release lands
        assertEq(splitter.sweep(), 0.2 ether);
        assertEq(ownerWallet.balance, 0.12 ether);
    }

    function test_curveIsZeroIfTheFactoryCannotBeRead() public {
        _launch(0);
        vm.mockCallRevert(address(factory), abi.encodeWithSelector(MockFactory.getLaunchedToken.selector), "down");
        assertEq(splitter.curve(), address(0));
        vm.deal(address(splitter), 1 ether);
        assertEq(splitter.sweep(), 1 ether, "and a sweep still splits what is here");
    }

    // ---------- $PUSHD credited by Pons ----------

    function test_aTokenCreditGoesWholeToTheBurnPotAndIsBurned() public {
        _launch(0);
        _trade(1 ether);
        vm.startPrank(trader);
        token.approve(address(escrow), 5000e18);
        escrow.creditToken(address(splitter), address(token), 5000e18);
        vm.stopPrank();
        vm.expectEmit(address(splitter));
        emit TokensSentToBurn(5000e18);
        vm.prank(stranger);
        assertEq(splitter.claimToken(), 5000e18);
        assertEq(token.balanceOf(address(splitter)), 0);
        assertEq(token.balanceOf(address(burnPot)), 5000e18);
        assertEq(token.balanceOf(ownerWallet), 0, "none of it is split");
        vm.warp(START + 1 hours);
        uint256 supply = token.totalSupply();
        (, uint256 burned) = burnPot.burn(0);
        assertEq(burned, 5000e18);
        assertEq(supply - token.totalSupply(), 5000e18);
    }

    function test_claimTokenWithNothingDoesNothing() public {
        assertEq(splitter.claimToken(), 0, "before the launch");
        _launch(0);
        assertEq(splitter.claimToken(), 0, "after it, with nothing owed");
    }

    // ---------- wallets that refuse, eat gas or call back ----------

    function _splitterFor(address o) internal returns (PushdSplitter s, PushdBurnPot b) {
        Token memory t = _deployToken(
            address(this), Wiring(launcher, o, OWNER_BPS, BURN_BPS), IPonsV2LaunchFactory(address(factory))
        );
        return (t.splitter, t.burnPot);
    }

    function test_anOwnerWalletThatRefusesStopsNobodyAndCollectsLater() public {
        Rejecter r = new Rejecter();
        (PushdSplitter s, PushdBurnPot b) = _splitterFor(address(r));
        vm.deal(address(s), 1 ether);
        vm.expectEmit(address(s));
        emit Split(1 ether, 0.6 ether, 0.4 ether, false, true);
        s.distribute();
        assertEq(address(b).balance, 0.4 ether, "the burn share went");
        assertEq(s.ownerPending(), 0.6 ether, "the owner's waits");
        assertEq(s.ownerPendingOf(address(r)), 0.6 ether, "under the owner wallet's name");
        assertEq(s.distribute(), 0, "and is not split a second time");
        s.retry();
        assertEq(s.ownerPending(), 0.6 ether, "still refused, still waiting");

        vm.prank(stranger);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        s.withdrawOwner(payable(stranger));
        vm.prank(address(r));
        vm.expectRevert(PushdSplitter.ZeroAddress.selector);
        s.withdrawOwner(payable(address(0)));
        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(r));
        s.withdrawOwner(safe);
        assertEq(safe.balance, 0.6 ether, "exactly the owner's share");
        vm.prank(address(r));
        vm.expectRevert(PushdSplitter.NothingPending.selector);
        s.withdrawOwner(safe);
    }

    function test_anOwnerWalletThatRefusesThenAcceptsIsPaidByRetry() public {
        Rejecter r = new Rejecter();
        (PushdSplitter s,) = _splitterFor(address(r));
        vm.deal(address(s), 1 ether);
        s.distribute();
        r.setAccept(true);
        vm.expectEmit(address(s));
        emit PendingDelivered(address(r), 0.6 ether);
        vm.prank(stranger);
        s.retry();
        assertEq(address(r).balance, 0.6 ether);
        assertEq(s.ownerPending(), 0);
        assertEq(address(s).balance, 0);
    }

    function test_aWalletThatEatsGasDoesNotStopTheSplit() public {
        GasEater g = new GasEater();
        (PushdSplitter s, PushdBurnPot b) = _splitterFor(address(g));
        vm.deal(address(s), 1 ether);
        uint256 before = gasleft();
        s.distribute{gas: 600_000}();
        assertLt(before - gasleft(), 600_000);
        assertEq(address(b).balance, 0.4 ether);
        assertEq(s.ownerPending(), 0.6 ether);
    }

    function test_aPotThatRefusesDoesNotStopTheOwner() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        TogglePot pot = new TogglePot(at, address(factory));
        PushdSplitter s = new PushdSplitter(
            payable(ownerWallet), payable(address(pot)), IPonsV2FeeEscrow(address(escrow)), OWNER_BPS, BURN_BPS
        );
        pot.setReject(true);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(ownerWallet.balance, 0.6 ether);
        assertEq(s.burnPending(), 0.4 ether);
        pot.setReject(false);
        s.retry();
        assertEq(address(pot).balance, 0.4 ether, "the share reaches the pot it was split for");
        assertEq(address(s).balance, 0);
    }

    function test_aWalletCannotReenterTheSplit() public {
        bytes[9] memory calls = [
            abi.encodeCall(PushdSplitter.distribute, ()),
            abi.encodeCall(PushdSplitter.sweep, ()),
            abi.encodeCall(PushdSplitter.claim, ()),
            abi.encodeCall(PushdSplitter.claimToken, ()),
            abi.encodeCall(PushdSplitter.retry, ()),
            abi.encodeCall(PushdSplitter.withdrawOwner, (payable(stranger))),
            abi.encodeCall(PushdSplitter.proposeOwnerPayee, (payable(stranger))),
            abi.encodeCall(PushdSplitter.cancelOwnerPayee, ()),
            abi.encodeCall(PushdSplitter.acceptOwnerPayee, ())
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            Reenterer r = new Reenterer();
            (PushdSplitter s, PushdBurnPot b) = _splitterFor(address(r));
            r.arm(calls[i]);
            vm.deal(address(s), 1 ether);
            s.distribute();
            assertFalse(r.reentrySucceeded(), "the call back in was refused");
            assertEq(address(b).balance, 0.4 ether);
            assertEq(address(r).balance + s.ownerPending(), 0.6 ether, "paid once, or waiting once");
            assertEq(s.owner(), address(r), "and the owner wallet is unchanged");
            assertEq(s.proposedOwner(), address(0));
        }
    }

    function test_ethThatComesBackDuringAPushWaitsForTheNextSplit() public {
        Bouncer bouncer = new Bouncer();
        (PushdSplitter s,) = _splitterFor(address(bouncer));
        bouncer.setBack(1000);
        vm.deal(address(s), 1 ether);
        s.distribute{gas: 2_000_000}();
        assertEq(address(bouncer).balance, 0.6 ether - 1000);
        assertEq(s.unsplit(), 1000, "not counted as anybody's share");
        bouncer.setBack(0);
        assertEq(s.distribute(), 1000);
    }

    // ---------- the owner wallet hands its share to another address ----------

    function _handOver(PushdSplitter s, address from, address to) internal {
        vm.prank(from);
        s.proposeOwnerPayee(payable(to));
        vm.prank(to);
        s.acceptOwnerPayee();
    }

    function test_onlyTheOwnerWalletCanPropose() public {
        address[4] memory others = [stranger, address(burnPot), launcher, address(company)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(PushdSplitter.NotAllowed.selector);
            splitter.proposeOwnerPayee(company);
        }
        assertEq(splitter.proposedOwner(), address(0));

        vm.expectEmit(address(splitter));
        emit OwnerPayeeProposed(ownerWallet, company);
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(company);
        assertEq(splitter.proposedOwner(), company);
        assertEq(splitter.owner(), ownerWallet, "a proposal alone changes nothing");
    }

    function test_aProposalRefusesZeroAndTheOtherPlaces() public {
        vm.startPrank(ownerWallet);
        vm.expectRevert(PushdSplitter.ZeroAddress.selector);
        splitter.proposeOwnerPayee(payable(address(0)));
        address[4] memory bad = [ownerWallet, address(burnPot), address(splitter), address(escrow)];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(PushdSplitter.BadWallets.selector);
            splitter.proposeOwnerPayee(payable(bad[i]));
        }
        vm.stopPrank();
        assertEq(splitter.proposedOwner(), address(0));
    }

    function test_onlyTheProposedAddressCanAccept() public {
        vm.prank(company);
        vm.expectRevert(PushdSplitter.NothingProposed.selector);
        splitter.acceptOwnerPayee();

        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(company);
        address[3] memory others = [stranger, ownerWallet, address(burnPot)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(PushdSplitter.NotAllowed.selector);
            splitter.acceptOwnerPayee();
        }
        assertEq(splitter.owner(), ownerWallet);

        vm.expectEmit(address(splitter));
        emit OwnerPayeeChanged(ownerWallet, company);
        vm.prank(company);
        splitter.acceptOwnerPayee();
        assertEq(splitter.owner(), company);
        assertEq(splitter.proposedOwner(), address(0));

        // the old wallet has no say any more, and the acceptance cannot be repeated
        vm.prank(ownerWallet);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.proposeOwnerPayee(payable(ownerWallet));
        vm.prank(ownerWallet);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.cancelOwnerPayee();
        vm.prank(company);
        vm.expectRevert(PushdSplitter.NothingProposed.selector);
        splitter.acceptOwnerPayee();
    }

    function test_aProposalCanBeReplacedAndCancelled() public {
        address payable typo = payable(makeAddr("typo"));
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(typo);
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(company);
        vm.prank(typo);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.acceptOwnerPayee();

        address[2] memory others = [stranger, address(company)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(PushdSplitter.NotAllowed.selector);
            splitter.cancelOwnerPayee();
        }
        vm.expectEmit(address(splitter));
        emit OwnerPayeeProposalCancelled(ownerWallet, company);
        vm.prank(ownerWallet);
        splitter.cancelOwnerPayee();
        assertEq(splitter.proposedOwner(), address(0));

        vm.prank(company);
        vm.expectRevert(PushdSplitter.NothingProposed.selector);
        splitter.acceptOwnerPayee();
        vm.prank(ownerWallet);
        vm.expectRevert(PushdSplitter.NothingProposed.selector);
        splitter.cancelOwnerPayee();
        assertEq(splitter.owner(), ownerWallet);
    }

    function test_theOldWalletKeepsWhatItHadAndTheNewOneGetsEverySplitAfter() public {
        vm.deal(address(splitter), 1 ether);
        splitter.distribute();
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(company);
        vm.deal(address(splitter), 1 ether);
        splitter.distribute();
        assertEq(ownerWallet.balance, 1.2 ether, "a split while the proposal waits is still the old wallet's");
        assertEq(company.balance, 0);

        vm.prank(company);
        splitter.acceptOwnerPayee();
        vm.deal(address(splitter), 1 ether);
        vm.expectEmit(address(splitter));
        emit Split(1 ether, 0.6 ether, 0.4 ether, true, true);
        splitter.distribute();
        assertEq(company.balance, 0.6 ether);
        assertEq(ownerWallet.balance, 1.2 ether, "the old wallet gets nothing more");
        assertEq(address(burnPot).balance, 1.2 ether);
        assertEq(splitter.totalToOwner(), 1.8 ether);
        assertEq(address(splitter).balance, 0);
    }

    function test_feesInFlightDuringAChangeGoToTheNewWalletAndTheBurnIsUntouched() public {
        _launch(0);
        _trade(1 ether); // the fees sit on the curve
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(company);
        escrow.credit{value: 0.1 ether}(address(splitter)); // more waits in the escrow
        (bool ok,) = address(splitter).call{value: 0.05 ether}(""); // and some here, unsplit
        assertTrue(ok);
        vm.prank(company);
        splitter.acceptOwnerPayee();
        assertEq(splitter.sweep(), 0.187 ether);
        assertEq(company.balance, 0.1122 ether);
        assertEq(ownerWallet.balance, 0);
        assertEq(address(burnPot).balance, 0.0748 ether, "the burn share of the same 0.187 with no change");
    }

    function test_aRefusedShareStaysTheOldWalletsToCollect() public {
        Rejecter old = new Rejecter();
        (PushdSplitter s,) = _splitterFor(address(old));
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(s.ownerPendingOf(address(old)), 0.6 ether);
        _handOver(s, address(old), company);

        s.retry();
        assertEq(company.balance, 0, "retry never hands the old wallet's share to the new one");
        assertEq(s.ownerPendingOf(address(old)), 0.6 ether);
        vm.deal(address(s), address(s).balance + 1 ether);
        s.distribute();
        assertEq(company.balance, 0.6 ether, "the new wallet gets the new split");
        assertEq(s.ownerPending(), 0.6 ether, "and the old share is still waiting, once");

        vm.prank(company);
        vm.expectRevert(PushdSplitter.NothingPending.selector);
        s.withdrawOwner(company);
        vm.prank(stranger);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        s.withdrawOwner(payable(stranger));
        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(old));
        s.withdrawOwner(safe);
        assertEq(safe.balance, 0.6 ether, "exactly what the old wallet had accrued");
        assertEq(s.ownerPending(), 0);
        assertEq(address(s).balance, 0);
    }

    function test_aNewWalletThatRefusesWaitsUnderItsOwnName() public {
        Rejecter next = new Rejecter();
        _handOver(splitter, ownerWallet, address(next));
        vm.deal(address(splitter), 1 ether);
        splitter.distribute();
        assertEq(splitter.ownerPendingOf(address(next)), 0.6 ether);
        assertEq(splitter.ownerPendingOf(ownerWallet), 0);
        vm.prank(ownerWallet);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.withdrawOwner(payable(ownerWallet));
        next.setAccept(true);
        splitter.retry();
        assertEq(address(next).balance, 0.6 ether);
        assertEq(splitter.ownerPending(), 0);
    }

    /// The same fees, split the same way, on two identical deployments: one changes its owner wallet partway through
    /// (with fees arriving while the proposal waits and before the acceptance), the other does not. The burn pot gets
    /// the same amounts to the wei; the owner share is the same in all, only divided at the line.
    function testFuzz_theBurnIsTheSameWithOrWithoutAChange(uint96[4] memory raw) public {
        uint256[4] memory a;
        for (uint256 i = 0; i < 4; ++i) {
            a[i] = bound(raw[i], 0, 1e27);
        }
        address o1 = makeAddr("owner one");
        address o2 = makeAddr("owner two");
        (PushdSplitter changed, PushdBurnPot p1) = _splitterFor(o1);
        (PushdSplitter same, PushdBurnPot p2) = _splitterFor(o2);
        PushdSplitter[2] memory both = [changed, same];

        for (uint256 j = 0; j < 2; ++j) {
            vm.deal(address(both[j]), a[0]);
            both[j].distribute();
            vm.deal(address(both[j]), a[1]); // arrives, unsplit
        }
        vm.prank(o1);
        changed.proposeOwnerPayee(company);
        for (uint256 j = 0; j < 2; ++j) {
            vm.deal(address(both[j]), a[1] + a[2]); // more arrives while the proposal waits
        }
        vm.prank(company);
        changed.acceptOwnerPayee();
        for (uint256 j = 0; j < 2; ++j) {
            both[j].distribute();
            vm.deal(address(both[j]), a[3]);
            both[j].distribute();
        }

        assertEq(address(p1).balance, address(p2).balance, "the burn");
        assertEq(changed.totalToBurn(), same.totalToBurn());
        assertEq(o1.balance + company.balance, o2.balance, "the owner share in all");
        assertEq(o1.balance, (a[0] * OWNER_BPS) / 10_000, "the old wallet: what was split before the line");
        assertEq(
            company.balance,
            ((a[1] + a[2]) * OWNER_BPS) / 10_000 + (a[3] * OWNER_BPS) / 10_000,
            "the new wallet: everything split after it"
        );
        assertEq(address(changed).balance, 0);
    }

    function test_aChangeMovesNothingElse() public {
        _handOver(splitter, ownerWallet, company);
        assertEq(splitter.burnPot(), address(burnPot));
        assertEq(address(splitter.escrow()), address(escrow));
        assertEq(splitter.ownerBps(), OWNER_BPS);
        assertEq(splitter.burnBps(), BURN_BPS);
        assertEq(burnPot.splitter(), address(splitter));
        // and the new wallet has the same one power and no other: it cannot name the burn pot either
        vm.prank(company);
        vm.expectRevert(PushdSplitter.BadWallets.selector);
        splitter.proposeOwnerPayee(payable(address(burnPot)));
    }

    // ---------- the constructor ----------

    function _new(address o, address pot, uint16 a, uint16 b) internal returns (PushdSplitter) {
        return new PushdSplitter(payable(o), payable(pot), IPonsV2FeeEscrow(address(escrow)), a, b);
    }

    function test_theConstructorRefusesZeroAddresses() public {
        vm.expectRevert(PushdSplitter.ZeroAddress.selector);
        _new(address(0), address(burnPot), OWNER_BPS, BURN_BPS);
        vm.expectRevert(PushdSplitter.ZeroAddress.selector);
        _new(ownerWallet, address(0), OWNER_BPS, BURN_BPS);
        vm.expectRevert(PushdSplitter.ZeroAddress.selector);
        new PushdSplitter(
            payable(ownerWallet), payable(address(burnPot)), IPonsV2FeeEscrow(address(0)), OWNER_BPS, BURN_BPS
        );
    }

    function test_theOwnerWalletIsNoneOfTheOtherPlaces() public {
        vm.expectRevert(PushdSplitter.BadWallets.selector);
        _new(address(burnPot), address(burnPot), OWNER_BPS, BURN_BPS);
        vm.expectRevert(PushdSplitter.BadWallets.selector);
        _new(address(escrow), address(burnPot), OWNER_BPS, BURN_BPS);
        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(PushdSplitter.BadWallets.selector);
        _new(self, address(burnPot), OWNER_BPS, BURN_BPS);
    }

    function test_theSharesMustBeTwoAndWhole() public {
        vm.expectRevert(PushdSplitter.BadShares.selector);
        _new(ownerWallet, address(burnPot), 0, 10_000);
        vm.expectRevert(PushdSplitter.BadShares.selector);
        _new(ownerWallet, address(burnPot), 10_000, 0);
        vm.expectRevert(PushdSplitter.BadShares.selector);
        _new(ownerWallet, address(burnPot), 5000, 5001);
        vm.expectRevert(PushdSplitter.BadShares.selector);
        _new(ownerWallet, address(burnPot), 5000, 4999);
    }

    function test_theConstructorRefusesAPotThatIsNotWiredToIt() public {
        // the real pot points at the real splitter, not at a new one
        vm.expectRevert(PushdSplitter.PotMismatch.selector);
        _new(ownerWallet, address(burnPot), OWNER_BPS, BURN_BPS);
        // no code there at all
        vm.expectRevert(PushdSplitter.PotMismatch.selector);
        _new(ownerWallet, makeAddr("empty"), OWNER_BPS, BURN_BPS);
    }

    function test_theEscrowMustBeTheOneTheFactoryCredits() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        PushdBurnPot pot = new PushdBurnPot(launcher, IPonsV2LaunchFactory(address(factory)), at);
        vm.expectRevert(PushdSplitter.EscrowMismatch.selector);
        new PushdSplitter(
            payable(ownerWallet),
            payable(address(pot)),
            IPonsV2FeeEscrow(makeAddr("another escrow")),
            OWNER_BPS,
            BURN_BPS
        );
    }
}
