// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PushdToken} from "../../script/PushdToken.sol";
import {PushdBurnPot} from "../../src/PushdBurnPot.sol";
import {PushdSplitter} from "../../src/PushdSplitter.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";

interface IFactoryX {
    function createGraduatedPool(address token) external returns (uint256);
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
    function setCreatorFeeRecipient(address token, address newRecipient) external;
}

interface ICurveX {
    function buy(uint256, uint256, address) external payable returns (uint256);
    function sweepFees(uint256) external;
    function currentSnipeTaxBps(address) external view returns (uint256);
    function snipeTaxExempt(address) external view returns (bool);
}

interface IPonsToken {
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IFeeEscrowX {
    function balanceOf(address) external view returns (uint256);
}

/// $PUSHD's burn pot and splitter against the real Pons, on a fork of Robinhood Chain: launched through the real
/// launch factory, traded on the real bonding curve and the real Uniswap v4 pool, fees through the real escrow.
/// Light on purpose: one fork block for the whole run, a handful of tests. RPC_URL overrides the public node,
/// RPC_URL="" skips them. Nothing reaches the real chain.
contract TokenForkTest is Test, PushdToken {
    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
    string constant UNSET = "__RPC_URL_UNSET__";
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    // made up for the tests; the real shares are set at deployment from contracts/split.local.json
    uint16 constant OWNER_BPS = 6000;
    uint16 constant BURN_BPS = 4000;

    // fresh addresses: the chain's well-known test accounts carry other code there
    address launcher = makeAddr("pushd launcher");
    address ownerWallet = makeAddr("pushd owner wallet");
    address company = makeAddr("pushd company wallet");
    address buyer = makeAddr("pushd buyer");
    address stranger = makeAddr("pushd stranger");

    PushdBurnPot burnPot;
    PushdSplitter splitter;
    IPonsToken token;
    ICurveX curve;
    uint256 t0;

    /// Every test forks the same recent block on a round number, so the node is asked for each piece of state once.
    /// It has to be recent: the public node throws old state away after a few thousand blocks.
    function setUp() public {
        string memory url = vm.envOr("RPC_URL", string(UNSET));
        if (keccak256(bytes(url)) == keccak256(bytes(UNSET))) url = DEFAULT_RPC;
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) {
            bytes memory raw = vm.rpc(url, "eth_blockNumber", "[]");
            uint256 head;
            for (uint256 i = 0; i < raw.length; ++i) {
                head = (head << 8) | uint8(raw[i]);
            }
            pinned = ((head - 20) / 500) * 500;
        }
        vm.createSelectFork(url, pinned);
        Wiring memory w = Wiring(launcher, ownerWallet, OWNER_BPS, BURN_BPS);
        Token memory t = _deployToken(address(this), w, _factory());
        _verifyToken(t, w, _factory());
        (burnPot, splitter) = (t.burnPot, t.splitter);
        vm.deal(buyer, 100 ether);
    }

    function _params() internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "PUSHD";
        p.symbol = "PUSHD";
        p.logo = "https://pushd.fun/token.png";
        p.description = "The token of PUSHD.";
        p.socials.website = "https://pushd.fun";
        p.salt = keccak256("pushd-fork");
    }

    function _launch(uint256 openingBuy) internal {
        uint256 fee = _factory().launchFee();
        vm.deal(launcher, fee + openingBuy);
        vm.prank(launcher);
        address a = burnPot.launch{value: fee + openingBuy}(_params(), 0, new address[](0));
        token = IPonsToken(a);
        curve = ICurveX(_factory().getLaunchedToken(a).curve);
        t0 = block.timestamp;
    }

    function _buy(address who, uint256 eth) internal returns (uint256 got) {
        vm.prank(who);
        got = curve.buy{value: eth}(eth, 0, who);
    }

    /// The launch: the pot is the deployer, the fees go to the splitter, the tax is the pot's and cannot be moved,
    /// and the opening buy lands whole in the launcher wallet, untaxed by the launch seconds.
    function test_fork_theLaunchIsWhatThePotForcesAndTheOpeningBuyIsUntaxed() public {
        _launch(0.01 ether);
        IPonsV2LaunchFactory.LaunchedToken memory info = _factory().getLaunchedToken(address(token));
        assertEq(info.deployer, address(burnPot));
        assertEq(info.creatorFeeRecipient, address(splitter));
        assertEq(info.creatorTaxBps, burnPot.CREATOR_TAX_BPS());
        assertEq(info.pairToken, address(0));
        assertFalse(info.buybackEnabled);
        assertEq(token.symbol(), "PUSHD");
        assertTrue(curve.snipeTaxExempt(launcher));
        assertEq(curve.currentSnipeTaxBps(stranger), 9900, "anyone else pays the launch-second tax");
        uint256 got = token.balanceOf(launcher);
        assertEq(burnPot.openingBuyTokens(), got);
        assertEq(burnPot.openingBuyEth(), 0.01 ether);

        // nobody can move the fee recipient afterwards, the launcher included
        address[3] memory who = [launcher, stranger, address(burnPot)];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(address(_factory())).transferCreatorFeeRecipient(address(token), who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(address(_factory())).setCreatorFeeRecipient(address(token), who[i]);
        }
        assertEq(_factory().getLaunchedToken(address(token)).creatorFeeRecipient, address(splitter));

        // untaxed: the same ETH ten minutes later by a stranger on an identical launch buys the same
        Token memory twin = _deployToken(address(this), Wiring(launcher, ownerWallet, OWNER_BPS, BURN_BPS), _factory());
        uint256 fee = _factory().launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        IPonsV2LaunchFactory.TokenParams memory p = _params();
        p.salt = keccak256("pushd-twin");
        address t = twin.burnPot.launch{value: fee}(p, 0, new address[](0));
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(buyer);
        uint256 later = ICurveX(_factory().getLaunchedToken(t).curve).buy{value: 0.01 ether}(0.01 ether, 0, buyer);
        assertEq(got, later);
    }

    /// A trade's fees, released by the splitter, split two ways to the wei.
    function test_fork_tradingFeesSplitTwoWaysToTheWei() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 1 ether);
        vm.prank(stranger);
        uint256 amount = splitter.sweep();
        assertGt(amount, 0);
        emit log_named_decimal_uint("creator fees on a 1 ETH buy", amount, 18);
        uint256 toOwner = (amount * OWNER_BPS) / 10_000;
        assertEq(ownerWallet.balance, toOwner);
        assertEq(address(burnPot).balance, amount - toOwner);
        assertEq(address(splitter).balance, 0);
        assertEq(IFeeEscrowX(ESCROW).balanceOf(address(splitter)), 0);
    }

    /// The owner wallet hands its share to another address halfway, with a trade's fees still on the real curve:
    /// what was split before stays with the old wallet, the rest goes to the new one, and the burn pot's share of
    /// both sweeps is exactly what it would have been with no change.
    function test_fork_theOwnerWalletHandsItsShareOverMidway() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 1 ether);
        uint256 first = splitter.sweep();
        uint256 oldHas = ownerWallet.balance;
        assertEq(oldHas, (first * OWNER_BPS) / 10_000);

        _buy(buyer, 1 ether); // these fees are on the curve while the change happens
        vm.prank(stranger);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.proposeOwnerPayee(payable(stranger));
        vm.prank(ownerWallet);
        splitter.proposeOwnerPayee(payable(company));
        vm.prank(stranger);
        vm.expectRevert(PushdSplitter.NotAllowed.selector);
        splitter.acceptOwnerPayee();
        vm.prank(company);
        splitter.acceptOwnerPayee();
        uint256 second = splitter.sweep();
        assertGt(second, 0);
        assertEq(ownerWallet.balance, oldHas, "the old wallet gets nothing after the line");
        assertEq(company.balance, (second * OWNER_BPS) / 10_000, "the new wallet gets the owner share");
        uint256 burnShares = first - (first * OWNER_BPS) / 10_000 + second - (second * OWNER_BPS) / 10_000;
        assertEq(address(burnPot).balance, burnShares, "the burn pot's share is untouched");
        assertEq(splitter.ownerBps(), OWNER_BPS);
        assertEq(splitter.burnPot(), address(burnPot));
    }

    /// The burn on the curve, and a credit payment: $PUSHD transferred to the pot arrives whole and is destroyed
    /// with the burn, the total supply falling by exactly what was bought and paid in together.
    function test_fork_aBurnBuysOnTheCurveAndBurnsPaidInTokensAndTheSupplyFalls() public {
        _launch(0);
        vm.warp(t0 + 10);
        uint256 got = _buy(buyer, 0.2 ether);
        splitter.sweep();
        uint256 paid = got / 3;
        vm.prank(buyer);
        assertTrue(token.transfer(address(burnPot), paid));
        assertEq(token.balanceOf(address(burnPot)), paid, "a transfer arrives whole: no tax between wallets");
        uint256 potEth = address(burnPot).balance;
        assertGt(potEth, 0);

        vm.expectRevert(abi.encodeWithSelector(PushdBurnPot.TooSoon.selector, t0 + 30 minutes));
        burnPot.burn(0);
        vm.warp(t0 + 30 minutes);
        (,, bool ready, uint256 tokens) = burnPot.preview();
        assertTrue(ready);
        assertEq(tokens, paid);
        uint256 supply = token.totalSupply();
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, potEth < 0.001 ether ? 0 : potEth);
        assertGt(burned, paid);
        assertEq(supply - token.totalSupply(), burned, "total supply fell by exactly what was burned");
        assertEq(token.balanceOf(address(burnPot)), 0);
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0);
    }

    /// After graduation the pot buys in the real Uniswap v4 pool and the supply falls the same way.
    function test_fork_afterGraduationABurnBuysInThePool() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 10 ether); // buys the curve out
        assertEq(uint8(_factory().getLaunchedToken(address(token)).phase), 1, "graduated, no pool yet");
        vm.deal(address(burnPot), 0.005 ether);
        vm.warp(t0 + 1 hours);
        vm.expectRevert(PushdBurnPot.MarketNotReady.selector);
        burnPot.burn(0);
        IFactoryX(address(_factory())).createGraduatedPool(address(token));
        (bool open, bool viaCurve,) = burnPot.market();
        assertTrue(open);
        assertFalse(viaCurve);
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.005 ether);
        assertEq(supply - token.totalSupply(), burned);
    }
}
