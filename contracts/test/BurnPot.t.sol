// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenTest} from "./TokenTest.sol";
import {PushdBurnPot} from "../src/PushdBurnPot.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {MockCurve, MockFactory, MockPushdToken, MockPoolManager} from "./mocks/MockPons.sol";

contract BurnPotTest is TokenTest {
    event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve);
    event TokenSet(address indexed token);
    event LaunchExemption(address indexed wallet);
    event OpeningBuy(address indexed wallet, uint256 ethIn, uint256 tokensOut);

    uint160 constant SQRT_ONE = 2 ** 96; // price 1: the pool's ETH depth equals its liquidity

    function _info() internal view returns (IPonsV2LaunchFactory.LaunchedToken memory) {
        return IPonsV2LaunchFactory(address(factory)).getLaunchedToken(address(token));
    }

    // ---------- what it is ----------

    function test_constants() public view {
        assertEq(burnPot.CREATOR_TAX_BPS(), 300);
        assertEq(burnPot.DEPTH_BPS(), 100);
        assertEq(burnPot.MIN_INTERVAL(), 30 minutes);
        assertEq(burnPot.MAX_WAIT(), 24 hours);
        assertEq(burnPot.MIN_BURN(), 0.001 ether);
        assertEq(burnPot.launcher(), launcher);
        assertEq(burnPot.splitter(), address(splitter));
    }

    function test_theConstructorRefusesZeroAddresses() public {
        IPonsV2LaunchFactory f = IPonsV2LaunchFactory(address(factory));
        vm.expectRevert(PushdBurnPot.ZeroAddress.selector);
        new PushdBurnPot(address(0), f, address(splitter));
        vm.expectRevert(PushdBurnPot.ZeroAddress.selector);
        new PushdBurnPot(launcher, IPonsV2LaunchFactory(address(0)), address(splitter));
        vm.expectRevert(PushdBurnPot.ZeroAddress.selector);
        new PushdBurnPot(launcher, f, address(0));
    }

    /// ETH can only leave by buying the token: there is no function that sends it anywhere else.
    function test_thereIsNoWayToWithdraw() public {
        vm.deal(address(burnPot), 1 ether);
        string[6] memory sigs = [
            "withdraw()",
            "withdraw(uint256)",
            "withdraw(address,uint256)",
            "sweep(address)",
            "rescue(address,uint256)",
            "setToken(address)"
        ];
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.prank(launcher);
            (bool ok,) = address(burnPot).call(abi.encodeWithSignature(sigs[i], launcher, 1 ether));
            assertFalse(ok, sigs[i]);
        }
        assertEq(address(burnPot).balance, 1 ether);
    }

    // ---------- the launch ----------

    function test_onlyTheLauncherLaunches() public {
        uint256 fee = factory.launchFee();
        vm.deal(stranger, fee);
        vm.prank(stranger);
        vm.expectRevert(PushdBurnPot.NotLauncher.selector);
        burnPot.launch{value: fee}(_params(), 0, new address[](0));
        vm.deal(stranger, fee);
        vm.prank(stranger);
        vm.expectRevert(PushdBurnPot.NotLauncher.selector);
        burnPot.launch{value: fee}(_params(), 0, new address[](0));
    }

    function test_lessThanTheLaunchFeeIsRefused() public {
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.LaunchFeeShort.selector, fee));
        burnPot.launch{value: fee - 1}(_params(), 0, new address[](0));
    }

    function test_theLaunchForcesTheFeeSettingsWhateverIsAsked() public {
        IPonsV2LaunchFactory.TokenParams memory p = _params();
        p.creatorFeeRecipient = stranger; // asked for, and overridden
        p.creatorTaxBps = 1000;
        p.buybackEnabled = true;
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        address t = burnPot.launch{value: fee}(p, 0, new address[](0));
        IPonsV2LaunchFactory.LaunchedToken memory info = IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t);
        assertEq(info.creatorFeeRecipient, address(splitter), "fees go to the splitter");
        assertEq(info.creatorTaxBps, 300, "the creator tax, fixed");
        assertFalse(info.buybackEnabled);
        assertEq(info.pairToken, address(0), "paired with ETH");
        assertEq(info.deployer, address(burnPot), "the pot is the launch's deployer");
        assertEq(address(burnPot.token()), t);
        assertEq(burnPot.startedAt(), block.timestamp);
    }

    function test_theLaunchHappensOnce() public {
        _launch(0);
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        vm.expectRevert(PushdBurnPot.TokenAlreadySet.selector);
        burnPot.launch{value: fee}(_params(), 0, new address[](0));
    }

    function test_theLaunchIsReadBackNotTrusted() public {
        uint256 fee = factory.launchFee();
        vm.deal(launcher, 10 * fee);
        MockFactory.Lie[6] memory lies = [
            MockFactory.Lie.Missing,
            MockFactory.Lie.Deployer,
            MockFactory.Lie.Recipient,
            MockFactory.Lie.Pair,
            MockFactory.Lie.Tax,
            MockFactory.Lie.Buyback
        ];
        bytes[6] memory errors = [
            abi.encodeWithSelector(PushdBurnPot.NotPonsLaunch.selector),
            abi.encodeWithSelector(PushdBurnPot.NotPonsLaunch.selector),
            abi.encodeWithSelector(PushdBurnPot.WrongFeeRecipient.selector, address(0xBAD)),
            abi.encodeWithSelector(PushdBurnPot.NotEthPair.selector),
            abi.encodeWithSelector(PushdBurnPot.WrongCreatorTax.selector, uint16(301)),
            abi.encodeWithSelector(PushdBurnPot.BuybackEnabled.selector)
        ];
        for (uint256 i = 0; i < lies.length; ++i) {
            factory.setLie(lies[i]);
            vm.prank(launcher);
            vm.expectRevert(errors[i]);
            burnPot.launch{value: fee}(_params(), 0, new address[](0));
            assertEq(address(burnPot.token()), address(0), "a refused launch leaves no token set");
        }
    }

    /// A burn pot whose splitter pays some other pot would launch a token whose burn share never arrives.
    function test_aPotTheSplitterDoesNotPayCannotLaunch() public {
        PushdBurnPot orphan = new PushdBurnPot(launcher, IPonsV2LaunchFactory(address(factory)), address(splitter));
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        vm.expectRevert(PushdBurnPot.SplitterMismatch.selector);
        orphan.launch{value: fee}(_params(), 0, new address[](0));
    }

    function test_theLauncherIsExemptFirstThenTheRestAndEachIsPublished() public {
        address[] memory also = new address[](2);
        also[0] = makeAddr("friend");
        also[1] = makeAddr("streamer");
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee);
        vm.expectEmit(true, false, false, false, address(burnPot));
        emit LaunchExemption(launcher);
        vm.expectEmit(true, false, false, false, address(burnPot));
        emit LaunchExemption(also[0]);
        vm.expectEmit(true, false, false, false, address(burnPot));
        emit LaunchExemption(also[1]);
        vm.prank(launcher);
        address t = burnPot.launch{value: fee}(_params(), 0, also);
        token = MockPushdToken(t);
        curve = MockCurve(IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t).curve);
        assertTrue(curve.snipeTaxExempt(launcher));
        assertTrue(curve.snipeTaxExempt(also[0]));
        assertTrue(curve.snipeTaxExempt(also[1]));
        assertTrue(curve.snipeTaxExempt(address(burnPot)), "the pot, as the launch's deployer");
        assertTrue(curve.snipeTaxExempt(address(splitter)), "the splitter, as the fee recipient");
        assertFalse(curve.snipeTaxExempt(stranger));
    }

    function test_aBadExemptionListIsRefused() public {
        uint256 fee = factory.launchFee();
        vm.deal(launcher, 3 * fee);
        address[] memory zero = new address[](1);
        vm.prank(launcher);
        vm.expectRevert(PushdBurnPot.ZeroAddress.selector);
        burnPot.launch{value: fee}(_params(), 0, zero);

        address[] memory twice = new address[](2);
        twice[0] = stranger;
        twice[1] = stranger;
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.DuplicateExemption.selector, stranger));
        burnPot.launch{value: fee}(_params(), 0, twice);

        address[] memory launcherAgain = new address[](1);
        launcherAgain[0] = launcher;
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.DuplicateExemption.selector, launcher));
        burnPot.launch{value: fee}(_params(), 0, launcherAgain);
    }

    function test_theOpeningBuyLandsInTheLauncherWalletAndIsWrittenDown() public {
        vm.deal(address(burnPot), 1 ether); // the pot's own ETH must not be what pays for it
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee + 0.05 ether);
        vm.expectEmit(true, false, false, false, address(burnPot));
        emit OpeningBuy(launcher, 0.05 ether, 0);
        vm.prank(launcher);
        address t = burnPot.launch{value: fee + 0.05 ether}(_params(), 0, new address[](0));
        token = MockPushdToken(t);
        uint256 held = token.balanceOf(launcher);
        assertGt(held, 0, "the tokens are in the launcher wallet");
        assertEq(burnPot.openingBuyTokens(), held, "and the pot recorded exactly what arrived");
        assertEq(burnPot.openingBuyEth(), 0.05 ether);
        assertEq(token.balanceOf(address(burnPot)), 0, "the pot holds none of them");
        assertEq(address(burnPot).balance, 1 ether, "the pot's own ETH is untouched");
        assertEq(launcher.balance, 0, "the launcher paid the fee and the buy");
        // not taxed as a sniper: the same buy a minute later, by a stranger, gets fewer tokens only by the price
        // having moved, not 99% fewer
        assertGt(held, 30_000_000e18);
    }

    function test_noOpeningBuyRecordsNothing() public {
        _launch(0);
        assertEq(burnPot.openingBuyTokens(), 0);
        assertEq(burnPot.openingBuyEth(), 0);
        assertEq(token.balanceOf(launcher), 0);
    }

    /// A buy bigger than the curve can fill is refunded to the pot, where the only thing it can do is burn, and
    /// what is written down is what was really spent.
    function test_anOpeningBuyRefundBecomesBurnBudget() public {
        factory.setCurveMaxFill(1 ether);
        uint256 fee = factory.launchFee();
        vm.deal(launcher, fee + 3 ether);
        vm.prank(launcher);
        address t = burnPot.launch{value: fee + 3 ether}(_params(), 0, new address[](0));
        assertEq(burnPot.openingBuyEth(), 1 ether, "what the curve took");
        assertEq(address(burnPot).balance, 2 ether, "the refund stays here as burn budget");
        assertEq(burnPot.openingBuyTokens(), MockPushdToken(t).balanceOf(launcher));
    }

    // ---------- the burn: when ----------

    function test_noBurnBeforeTheLaunch() public {
        vm.deal(address(burnPot), 1 ether);
        vm.expectRevert(PushdBurnPot.TokenNotSet.selector);
        burnPot.burn(0);
        (bool open,, uint256 cap) = burnPot.market();
        assertFalse(open);
        assertEq(cap, type(uint256).max);
        (uint256 amount, uint256 nextAt, bool ready,) = burnPot.preview();
        assertEq(amount + nextAt, 0);
        assertFalse(ready);
    }

    /// The launch seconds are taxed by Pons. The pot is exempt, and it also cannot burn for 30 minutes anyway.
    function test_noBurnInTheFirstThirtyMinutes() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        assertEq(curve.currentSnipeTaxBps(address(burnPot)), 0);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSoon.selector, START + 30 minutes));
        burnPot.burn(0);
        vm.warp(START + 30 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSoon.selector, START + 30 minutes));
        burnPot.burn(0);
        (,, bool ready,) = burnPot.preview();
        assertFalse(ready);
        vm.warp(START + 30 minutes);
        (uint256 amount, uint256 nextAt, bool ready2,) = burnPot.preview();
        assertEq(amount, 0.01 ether);
        assertEq(nextAt, START + 30 minutes);
        assertTrue(ready2);
        burnPot.burn(0);
    }

    function test_thirtyMinutesBetweenBurns() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        burnPot.burn(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSoon.selector, START + 1 hours + 30 minutes));
        burnPot.burn(0);
        vm.warp(START + 1 hours + 30 minutes);
        burnPot.burn(0);
        assertEq(burnPot.burnCount(), 2);
    }

    function test_anEmptyPotRevertsCleanly() public {
        _launch(0);
        vm.warp(START + 1 hours);
        vm.expectRevert(PushdBurnPot.NothingToBurn.selector);
        burnPot.burn(0);
        (uint256 amount, uint256 nextAt, bool ready,) = burnPot.preview();
        assertEq(amount + nextAt, 0);
        assertFalse(ready);
    }

    function test_aSmallBurnWaitsForMoreOrForADay() public {
        _launch(0);
        vm.deal(address(burnPot), 0.0005 ether);
        vm.warp(START + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSmall.selector, 0.0005 ether, 0.001 ether));
        burnPot.burn(0);
        (uint256 amount, uint256 nextAt, bool ready,) = burnPot.preview();
        assertEq(amount, 0.0005 ether);
        assertEq(nextAt, START + 24 hours, "allowed a day after the launch at the latest");
        assertFalse(ready);
        // more arrives: it goes at once
        vm.deal(address(burnPot), 0.001 ether);
        burnPot.burn(0);
        // and a small one alone goes after a day
        vm.deal(address(burnPot), 0.0002 ether);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSmall.selector, 0.0002 ether, 0.001 ether));
        burnPot.burn(0);
        vm.warp(block.timestamp + 1);
        (uint256 ethIn,) = burnPot.burn(0);
        assertEq(ethIn, 0.0002 ether);
    }

    // ---------- the burn: on the curve ----------

    function test_aBurnBuysOnTheCurveAndTheSupplyFallsByExactlyThat() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        uint256 supply = token.totalSupply();
        vm.expectEmit(true, true, false, false, address(burnPot));
        emit Burned(1, stranger, 0, 0, true);
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.01 ether, "everything the pot held");
        assertGt(burned, 0);
        assertEq(supply - token.totalSupply(), burned, "destroyed, not parked: total supply fell");
        assertEq(token.balanceOf(address(burnPot)), 0);
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0, "nothing went to a dead address");
        assertEq(address(burnPot).balance, 0);
        assertEq(burnPot.totalEthBurned(), 0.01 ether);
        assertEq(burnPot.totalTokensBurned(), burned);
        assertEq(burnPot.lastBurnAt(), block.timestamp);
    }

    function test_oneBurnSpendsAtMostOnePercentOfTheCurvesDepth() public {
        _launch(0);
        vm.deal(address(burnPot), 5 ether);
        vm.warp(START + 1 hours);
        (uint256 depth,) = curve.getReserves();
        (bool open, bool viaCurve, uint256 cap) = burnPot.market();
        assertTrue(open);
        assertTrue(viaCurve);
        assertEq(cap, depth / 100);
        (uint256 ethIn,) = burnPot.burn(0);
        assertEq(ethIn, depth / 100);
        assertEq(address(burnPot).balance, 5 ether - depth / 100, "the rest waits for the next burn");
    }

    function test_whatTheCurveCannotFillIsNotCountedAsSpent() public {
        _launch(0);
        curve.setMaxFill(0.004 ether);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        (uint256 ethIn,) = burnPot.burn(0);
        assertEq(ethIn, 0.004 ether, "measured, not assumed");
        assertEq(address(burnPot).balance, 0.006 ether, "the refund stays in the pot");
        assertEq(burnPot.totalEthBurned(), 0.004 ether);
    }

    function test_theCallersFloorIsEnforced() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        uint256 snap = vm.snapshotState();
        (, uint256 burned) = burnPot.burn(0);
        vm.revertToState(snap);
        vm.expectRevert(PushdBurnPot.Slippage.selector);
        burnPot.burn(burned + 1);
        burnPot.burn(burned);
    }

    /// On a partial fill the floor is a price floor: the same tokens per ETH, on the part that filled.
    function test_theFloorScalesWithAPartialFill() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        uint256 snap = vm.snapshotState();
        (, uint256 full) = burnPot.burn(0);
        vm.revertToState(snap);
        curve.setMaxFill(0.005 ether);
        snap = vm.snapshotState();
        (, uint256 half) = burnPot.burn(0);
        vm.revertToState(snap);
        // half the ETH at a slightly better price than the full buy: a floor quoted for the full buy passes
        burnPot.burn(full);
        vm.revertToState(snap);
        // a floor above the price actually paid fails
        vm.expectRevert(PushdBurnPot.Slippage.selector);
        burnPot.burn(half * 2 + 2);
    }

    function test_tokensThatArrivedAnotherWayAreBurnedToo() public {
        _launch(0);
        uint256 got = _trade(0.1 ether);
        vm.prank(trader);
        token.transfer(address(burnPot), got);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        uint256 supply = token.totalSupply();
        (, uint256 burned) = burnPot.burn(0);
        assertGt(burned, got);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    /// If the token's burn ever stopped lowering the supply, the pot refuses to call it a burn.
    function test_aBurnThatDoesNotLowerTheSupplyReverts() public {
        _launch(0);
        token.setFakeBurn(true);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        vm.expectRevert(PushdBurnPot.SupplyDidNotFall.selector);
        burnPot.burn(0);
        assertEq(address(burnPot).balance, 0.01 ether, "and nothing was spent");
    }

    // ---------- the burn: where ----------

    function test_noBurnWhileTheCurveIsGraduating() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        curve.setReadyToGraduate(true);
        vm.expectRevert(PushdBurnPot.MarketNotReady.selector);
        burnPot.burn(0);
        (bool open,,) = burnPot.market();
        assertFalse(open);
        (uint256 amount,, bool ready,) = burnPot.preview();
        assertEq(amount, 0.01 ether, "it knows what is waiting");
        assertFalse(ready);
    }

    function test_noBurnBetweenGraduationAndThePoolOrAfterARescue() public {
        _launch(0);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        factory.setPhase(address(token), IPonsV2LaunchFactory.GraduationPhase.Swept);
        vm.expectRevert(PushdBurnPot.MarketNotReady.selector);
        burnPot.burn(0);
        factory.setPhase(address(token), IPonsV2LaunchFactory.GraduationPhase.Rescued);
        vm.expectRevert(PushdBurnPot.MarketNotReady.selector);
        burnPot.burn(0);
        // a pool that Pons says exists but that has no price yet
        factory.setPhase(address(token), IPonsV2LaunchFactory.GraduationPhase.PoolCreated);
        vm.expectRevert(PushdBurnPot.MarketNotReady.selector);
        burnPot.burn(0);
        assertEq(address(burnPot).balance, 0.01 ether);
    }

    // ---------- the burn: in the pool ----------

    function test_afterGraduationABurnBuysInThePoolAndTheSupplyFalls() public {
        _launch(0);
        _graduate(SQRT_ONE, 100 ether);
        vm.deal(address(burnPot), 0.5 ether);
        vm.warp(START + 1 hours);
        (bool open, bool viaCurve, uint256 cap) = burnPot.market();
        assertTrue(open);
        assertFalse(viaCurve);
        assertEq(cap, 1 ether, "1% of the pool's in-range ETH depth");
        uint256 supply = token.totalSupply();
        vm.expectEmit(true, true, false, false, address(burnPot));
        emit Burned(1, address(this), 0, 0, false);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.5 ether);
        assertEq(pm.settled(), 0.5 ether, "exactly that was paid to the pool");
        assertEq(burned, (0.5 ether * pm.rate()) / 1e18);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    function test_oneBurnSpendsAtMostOnePercentOfThePoolsDepth() public {
        _launch(0);
        _graduate(SQRT_ONE, 100 ether);
        vm.deal(address(burnPot), 5 ether);
        vm.warp(START + 1 hours);
        (uint256 ethIn,) = burnPot.burn(0);
        assertEq(ethIn, 1 ether);
        assertEq(address(burnPot).balance, 4 ether);
    }

    /// The pool stops the swap at the pot's price limit: only what was swapped leaves.
    function test_aSwapStoppedByThePriceLimitSpendsOnlyWhatItSwapped() public {
        _launch(0);
        _graduate(SQRT_ONE, 100 ether);
        pm.setFillBps(2500);
        vm.deal(address(burnPot), 0.4 ether);
        vm.warp(START + 1 hours);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.1 ether);
        assertEq(address(burnPot).balance, 0.3 ether);
        assertEq(burned, (0.1 ether * pm.rate()) / 1e18);
    }

    function test_thePoolsFloorIsEnforcedToo() public {
        _launch(0);
        _graduate(SQRT_ONE, 100 ether);
        vm.deal(address(burnPot), 0.5 ether);
        vm.warp(START + 1 hours);
        uint256 quote = (0.5 ether * pm.rate()) / 1e18;
        vm.expectRevert(PushdBurnPot.Slippage.selector);
        burnPot.burn(quote + 1);
        burnPot.burn(quote);
    }

    function test_aPoolThatAsksForMoreThanPlannedIsRefused() public {
        _launch(0);
        _graduate(SQRT_ONE, 100 ether);
        vm.deal(address(burnPot), 0.5 ether);
        vm.warp(START + 1 hours);
        pm.setFault(MockPoolManager.Fault.Overcharge);
        vm.expectRevert(PushdBurnPot.Overcharged.selector);
        burnPot.burn(0);
        pm.setFault(MockPoolManager.Fault.WrongSign);
        vm.expectRevert(PushdBurnPot.Slippage.selector);
        burnPot.burn(0);
        assertEq(address(burnPot).balance, 0.5 ether);
    }

    function test_onlyThePoolManagerCanCallTheCallback() public {
        _launch(0);
        vm.deal(address(burnPot), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(PushdBurnPot.NotPoolManager.selector);
        burnPot.unlockCallback(abi.encode(uint256(1 ether), uint24(0), int24(200), uint160(1)));
        assertEq(address(burnPot).balance, 1 ether);
    }

    /// A price so low that 1% under it would be below Uniswap's minimum: the limit stays just above the minimum.
    function test_thePriceLimitNeverGoesBelowThePoolsMinimum() public {
        _launch(0);
        _graduate(4295128740, 100 ether);
        vm.deal(address(burnPot), 0.001 ether);
        vm.warp(START + 1 hours);
        burnPot.burn(0);
    }

    // ---------- fuzz ----------

    /// Whatever the pot holds and whatever the venue, a burn never spends more than it held or than 1% of the
    /// depth, and the supply falls by exactly what it reports burned.
    function testFuzz_aBurnIsBoundedAndExact(uint96 potEth, uint96 liquidity, bool pool) public {
        _launch(0);
        uint256 held = bound(potEth, 0.001 ether, 50 ether);
        if (pool) {
            _graduate(SQRT_ONE, uint128(bound(liquidity, 1 ether, 10_000 ether)));
            pm.setRate(1_000_000e18); // so the stand-in pool's stock covers the largest burn here
        }
        vm.deal(address(burnPot), held);
        vm.warp(START + 25 hours);
        (,, uint256 cap) = burnPot.market();
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertLe(ethIn, held);
        assertLe(ethIn, cap);
        assertEq(ethIn, held < cap ? held : cap);
        assertEq(address(burnPot).balance, held - ethIn);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    // ---------- $PUSHD paid in (credits) ----------

    /// $PUSHD sent straight to the pot (a credit payment on the site) is burned at the next burn with no ETH at all.
    function test_tokensAloneAreBurnedWithNoEth() public {
        _launch(0);
        uint256 got = _trade(0.1 ether);
        vm.prank(trader);
        token.transfer(address(burnPot), got);
        vm.warp(START + 1 hours);
        (uint256 amount, uint256 nextAt, bool ready, uint256 tokens) = burnPot.preview();
        assertEq(amount, 0);
        assertEq(nextAt, block.timestamp);
        assertTrue(ready);
        assertEq(tokens, got);
        uint256 supply = token.totalSupply();
        vm.expectEmit(true, true, false, true, address(burnPot));
        emit Burned(1, stranger, 0, got, false);
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0);
        assertEq(burned, got);
        assertEq(supply - token.totalSupply(), got, "the supply fell by exactly what was paid in");
        assertEq(burnPot.totalTokensBurned(), got);
        assertEq(burnPot.totalEthBurned(), 0);
    }

    /// With nowhere to buy, the ETH waits, but $PUSHD the pot holds is still burned.
    function test_tokensAreBurnedEvenWhenTheMarketIsShut() public {
        _launch(0);
        uint256 got = _trade(0.1 ether);
        vm.prank(trader);
        token.transfer(address(burnPot), got);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(START + 1 hours);
        curve.setReadyToGraduate(true);
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0);
        assertEq(burned, got);
        assertEq(supply - token.totalSupply(), got);
        assertEq(address(burnPot).balance, 0.01 ether, "the ETH waits for a market");
    }

    /// A small amount of ETH waits for more; the tokens beside it do not.
    function test_tokensDoNotWaitForASmallAmountOfEth() public {
        _launch(0);
        uint256 got = _trade(0.1 ether);
        vm.prank(trader);
        token.transfer(address(burnPot), got);
        vm.deal(address(burnPot), 0.0005 ether);
        vm.warp(START + 1 hours);
        (uint256 amount, uint256 nextAt, bool ready,) = burnPot.preview();
        assertEq(amount, 0.0005 ether);
        assertEq(nextAt, block.timestamp);
        assertTrue(ready);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0);
        assertEq(burned, got);
        assertEq(address(burnPot).balance, 0.0005 ether);
    }

    /// Anyone may send a speck of $PUSHD and call burn() every half hour. That must not restart the day a small amount
    /// of ETH waits: the day counts from the last burn that spent ETH, so the ETH still goes after a day.
    function test_specksOfTokensDoNotKeepSmallEthWaitingForever() public {
        _launch(0);
        _trade(0.1 ether);
        vm.deal(address(burnPot), 0.0005 ether);
        for (uint256 i = 1; i <= 48; ++i) {
            vm.warp(START + i * 30 minutes);
            vm.prank(trader);
            token.transfer(address(burnPot), 1);
            (uint256 ethIn, uint256 burned) = burnPot.burn(0);
            if (i < 48) {
                assertEq(ethIn, 0, "small ETH waits inside the day");
                assertEq(burned, 1);
            } else {
                assertEq(ethIn, 0.0005 ether, "and goes once the day is up, specks or not");
                assertGt(burned, 1, "what it bought burns with the speck");
            }
        }
        assertEq(burnPot.lastEthBurnAt(), START + 24 hours);
        assertEq(address(burnPot).balance, 0);
        // the next small amount waits a day from that burn, not from the specks after it
        vm.deal(address(burnPot), 0.0003 ether);
        vm.warp(START + 24 hours + 30 minutes);
        vm.prank(trader);
        token.transfer(address(burnPot), 1);
        (uint256 again,) = burnPot.burn(0);
        assertEq(again, 0);
        (uint256 amount, uint256 nextAt,,) = burnPot.preview();
        assertEq(amount, 0.0003 ether);
        assertEq(nextAt, START + 48 hours);
    }

    /// Paid-in tokens keep the same schedule: nothing burns inside the thirty minutes.
    function test_tokensWaitForTheInterval() public {
        _launch(0);
        uint256 got = _trade(0.1 ether);
        vm.prank(trader);
        token.transfer(address(burnPot), got);
        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSoon.selector, START + 30 minutes));
        burnPot.burn(0);
        (,, bool ready,) = burnPot.preview();
        assertFalse(ready);
    }
}
