// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {PushdToken} from "./PushdToken.sol";

interface IBalance {
    function balanceOf(address who) external view returns (uint256);
}

/// Launches $PUSHD on Pons through the burn pot, from the launcher wallet, with the opening buy inside the same
/// transaction. The pot forces the fee settings (fees to the splitter, the creator tax, no buyback, paired with ETH)
/// and reads them back; the tokens the opening buy gets go to the launcher wallet and stay there.
///
/// contracts/token-launch.sh runs this with every value filled in. What is fixed for good once it runs: the name, the
/// ticker, the picture's link, the description and the links, all from contracts/launch.json.
///
/// Two things about Pons are pinned, so that a launch never goes through on terms nobody looked at:
///   - the launch fee must be the one written in launch.json (launchFeeWei), or the script stops
///   - the launch carries Pons' own hash of its launch terms (previewLaunchEconomics) as expectedEconomics, and the
///     factory refuses the launch if its terms are no longer those when the transaction is mined. token-launch.sh
///     hands the hash its dry run printed to the real run as PUSHD_EXPECTED_ECONOMICS.
contract LaunchToken is Script, PushdToken {
    using stdJson for string;

    /// Pons' launch configuration $PUSHD is launched under, and the one its terms are read for.
    uint256 internal constant LAUNCH_CONFIG = 0;

    function run() external returns (address token) {
        _requireChain();
        Token memory t = _deployed();
        IPonsV2LaunchFactory factory = _factory();
        address launcher = t.burnPot.launcher();
        _verifyToken(t, _wiringFromEnv(launcher), factory);
        require(address(t.burnPot.token()) == address(0), "$PUSHD is already launched");

        uint256 openingBuy = vm.envUint("PUSHD_OPENING_BUY_WEI");
        string memory json = vm.envString("PUSHD_LAUNCH_JSON");
        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = json.readString(".name");
        p.symbol = json.readString(".symbol");
        p.logo = json.readString(".logo");
        p.description = json.readString(".description");
        p.socials.website = json.readString(".website");
        p.socials.twitter = json.readString(".twitter");
        p.salt = keccak256(bytes(p.symbol));
        require(keccak256(bytes(p.symbol)) == keccak256("PUSHD"), "launch.json is not $PUSHD");
        require(bytes(p.name).length > 0 && bytes(p.logo).length > 0, "launch.json: name and logo are needed");
        // wallets besides the launcher that should not pay Pons' launch-seconds tax; usually none
        address[] memory alsoExempt = vm.envOr("PUSHD_ALSO_EXEMPT", ",", new address[](0));

        uint256 fee = factory.launchFee();
        console.log("Launching %s ($%s) from %s", p.name, p.symbol, launcher);
        console.log("Launch fee %s wei, opening buy %s wei", fee, openingBuy);
        require(
            fee == json.readUint(".launchFeeWei"),
            "Pons' launch fee is not the launchFeeWei written in launch.json: look at the new fee before launching"
        );
        bytes32 economics = factory.previewLaunchEconomics(LAUNCH_CONFIG, address(0));
        bytes32 seenByDryRun = vm.envOr("PUSHD_EXPECTED_ECONOMICS", bytes32(0));
        require(
            seenByDryRun == bytes32(0) || seenByDryRun == economics,
            "Pons' launch terms have changed since the dry run: run the dry run again and look before launching"
        );
        p.expectedEconomics = economics;
        console.log("PUSHD_EXPECTED_ECONOMICS=%s", vm.toString(economics));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == launcher, "only the launcher can launch: run it from the launcher wallet (--sender)");
        token = t.burnPot.launch{value: fee + openingBuy}(p, LAUNCH_CONFIG, alsoExempt);
        vm.stopBroadcast();

        _verifyLaunch(t, factory, token, openingBuy);
        console.log("");
        console.log("PUSHD_TOKEN_ADDRESS=%s", token);
        console.log("Opening buy: %s tokens in the launcher wallet", t.burnPot.openingBuyTokens());
    }

    /// Reads the launch back from the chain. No broadcast, no key.
    function check() external view {
        _requireChain();
        Token memory t = _deployed();
        address token = address(t.burnPot.token());
        require(token != address(0), "$PUSHD is not launched yet");
        _verifyLaunch(t, _factory(), token, t.burnPot.openingBuyEth());
        console.log("OK: $PUSHD %s", token);
        console.log("    opening buy  %s tokens for %s wei", t.burnPot.openingBuyTokens(), t.burnPot.openingBuyEth());
    }

    function _verifyLaunch(Token memory t, IPonsV2LaunchFactory factory, address token, uint256 openingBuy)
        internal
        view
    {
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token);
        require(info.exists && info.token == token, "Pons does not know the token");
        require(info.deployer == address(t.burnPot), "the burn pot is not the launch's deployer");
        require(info.creatorFeeRecipient == address(t.splitter), "fees do not go to the splitter");
        require(info.creatorTaxBps == t.burnPot.CREATOR_TAX_BPS(), "the creator tax is not the pot's");
        require(info.pairToken == address(0), "not paired with ETH");
        require(!info.buybackEnabled, "Pons' own buyback is on");
        require(address(t.burnPot.token()) == token, "the burn pot burns another token");
        require(
            t.splitter.curve() == info.curve || info.phase != IPonsV2LaunchFactory.GraduationPhase.NotGraduated,
            "the splitter cannot find the curve"
        );
        require(IBalance(token).balanceOf(address(t.burnPot)) == 0, "the burn pot holds tokens");
        if (openingBuy > 0) require(t.burnPot.openingBuyTokens() > 0, "the opening buy bought nothing");
    }
}
