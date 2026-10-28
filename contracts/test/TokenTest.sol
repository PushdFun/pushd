// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PushdToken} from "../script/PushdToken.sol";
import {PushdBurnPot} from "../src/PushdBurnPot.sol";
import {PushdSplitter} from "../src/PushdSplitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {PoolKey} from "../src/interfaces/IPoolManager.sol";
import {MockCurve, MockEscrow, MockFactory, MockPushdToken, MockPoolManager} from "./mocks/MockPons.sol";

/// The burn pot and the splitter deployed exactly as the deploy script deploys them, against the stand-in for Pons,
/// with the handful of moves most tests start from. The shares here are made up for the tests: the real ones are
/// set at deployment from contracts/split.local.json and are not in this repository.
abstract contract TokenTest is Test, PushdToken {
    // A Tuesday noon UTC in October 2026.
    uint256 internal constant START = 1_791_288_000;
    uint16 internal constant OWNER_BPS = 6000;
    uint16 internal constant BURN_BPS = 4000;

    address internal launcher = makeAddr("launcher");
    address internal ownerWallet = makeAddr("owner wallet");
    address internal stranger = makeAddr("stranger");
    address internal trader = makeAddr("trader");

    MockPoolManager internal pm;
    MockFactory internal factory;
    MockEscrow internal escrow;

    PushdBurnPot internal burnPot;
    PushdSplitter internal splitter;

    MockPushdToken internal token;
    MockCurve internal curve;

    function setUp() public virtual {
        vm.warp(START);
        pm = new MockPoolManager();
        factory = new MockFactory(address(pm));
        escrow = MockEscrow(factory.feeEscrow());
        Wiring memory w = _wiring();
        Token memory t = _deployToken(address(this), w, IPonsV2LaunchFactory(address(factory)));
        _verifyToken(t, w, IPonsV2LaunchFactory(address(factory)));
        burnPot = t.burnPot;
        splitter = t.splitter;
    }

    function _wiring() internal view returns (Wiring memory w) {
        w = Wiring(launcher, ownerWallet, OWNER_BPS, BURN_BPS);
    }

    function _params() internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "PUSHD";
        p.symbol = "PUSHD";
        p.logo = "https://pushd.fun/token.png";
        p.description = "The token of PUSHD.";
        p.salt = keccak256("pushd");
    }

    /// The launch as the launcher sends it: the fee plus an opening buy.
    function _launch(uint256 openingBuy) internal {
        uint256 fee = factory.launchFee();
        vm.deal(launcher, launcher.balance + fee + openingBuy);
        vm.prank(launcher);
        address t = burnPot.launch{value: fee + openingBuy}(_params(), 0, new address[](0));
        token = MockPushdToken(t);
        curve = MockCurve(IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t).curve);
    }

    /// Somebody buys on the curve, past the launch seconds; the trade leaves fees on the curve.
    function _trade(uint256 eth) internal returns (uint256 got) {
        if (block.timestamp < curve.launchedAt() + 5) vm.warp(curve.launchedAt() + 5);
        vm.deal(trader, trader.balance + eth);
        vm.prank(trader);
        got = curve.buy{value: eth}(eth, 0, trader);
    }

    /// Graduate the token in the stand-in: the curve stops, a v4 pool exists with this price and depth.
    function _graduate(uint160 sqrtP, uint128 liquidity) internal {
        factory.setPhase(address(token), IPonsV2LaunchFactory.GraduationPhase.PoolCreated);
        PoolKey memory key = PoolKey({
            currency0: address(0), currency1: address(token), fee: 0, tickSpacing: 200, hooks: factory.memeHook()
        });
        pm.setPool(keccak256(abi.encode(key)), sqrtP, liquidity);
        // the pool's tokens: taken from the curve's stock, which is where the real ones come from too
        vm.prank(address(curve));
        token.transfer(address(pm), 100_000_000e18);
    }
}
