// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {PushdBurnPot} from "../src/PushdBurnPot.sol";
import {PushdSplitter} from "../src/PushdSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// The two contracts of $PUSHD, in the one order they can be deployed in, and the checks that say they are wired as
/// meant. The deploy script and the tests both go through here, so what the tests exercise is what gets deployed.
abstract contract PushdToken is CommonBase {
    uint256 internal constant ROBINHOOD_CHAIN = 4663;
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    struct Token {
        PushdBurnPot burnPot;
        PushdSplitter splitter;
    }

    /// Who is paid, and in what shares (basis points). The shares are read from contracts/split.local.json by the
    /// shell scripts; they are never written in this repository's source.
    struct Wiring {
        address launcher;
        address owner;
        uint16 ownerBps;
        uint16 burnBps;
    }

    /// Deploys from `deployer`, which must be the account the next two creations come from: the broadcaster in a
    /// script, the test contract in a test.
    ///
    /// The burn pot has to know the splitter (it aims the token's fees at it) and the splitter has to know the burn
    /// pot, so the splitter's address is worked out beforehand from the deployer's nonce and the splitter goes last:
    /// it refuses to deploy unless the burn pot exists and points at it. A fee address that pays an empty address can
    /// therefore never come out of this.
    function _deployToken(address deployer, Wiring memory w, IPonsV2LaunchFactory factory)
        internal
        returns (Token memory t)
    {
        uint256 nonce = vm.getNonce(deployer);
        address splitterAt = vm.computeCreateAddress(deployer, nonce + 1);
        t.burnPot = new PushdBurnPot(w.launcher, factory, splitterAt);
        t.splitter = new PushdSplitter(
            payable(w.owner), payable(address(t.burnPot)), IPonsV2FeeEscrow(factory.feeEscrow()), w.ownerBps, w.burnBps
        );
        require(address(t.splitter) == splitterAt, "the splitter did not land at the address the burn pot was given");
    }

    /// Everything about a deployment that can be read back, read back. Reverts with the first thing that is wrong.
    function _verifyToken(Token memory t, Wiring memory w, IPonsV2LaunchFactory factory) internal view {
        require(address(t.burnPot).code.length > 0, "no burn pot");
        require(address(t.splitter).code.length > 0, "no splitter");

        require(t.burnPot.launcher() == w.launcher, "burn pot: wrong launcher");
        require(t.burnPot.splitter() == address(t.splitter), "burn pot: fees would not go to this splitter");
        require(address(t.burnPot.factory()) == address(factory), "burn pot: wrong Pons factory");
        require(address(t.burnPot.poolManager()) == factory.poolManager(), "burn pot: wrong pool manager");
        require(t.burnPot.hook() == factory.memeHook(), "burn pot: wrong hook");

        require(t.splitter.owner() == w.owner, "splitter: wrong owner wallet");
        require(t.splitter.burnPot() == address(t.burnPot), "splitter: wrong burn pot");
        require(address(t.splitter.escrow()) == factory.feeEscrow(), "splitter: escrow is not the factory's");
        require(
            t.splitter.ownerBps() == w.ownerBps && t.splitter.burnBps() == w.burnBps,
            "splitter: not the shares in split.local.json"
        );
        require(
            uint256(t.splitter.ownerBps()) + t.splitter.burnBps() == t.splitter.BPS(), "splitter: shares do not add up"
        );
    }

    function _factory() internal view returns (IPonsV2LaunchFactory f) {
        f = IPonsV2LaunchFactory(vm.envOr("PONS_FACTORY", PONS_FACTORY));
        require(address(f).code.length > 0, "no contract at the Pons factory address on this chain");
    }

    function _requireChain() internal view {
        require(block.chainid == ROBINHOOD_CHAIN, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
    }

    /// The owner wallet and the shares from the environment the shell scripts set. Public addresses and numbers only;
    /// a key is never read from the environment or a file, forge asks for it at its own prompt.
    function _wiringFromEnv(address launcher) internal view returns (Wiring memory w) {
        w.launcher = launcher;
        w.owner = vm.envAddress("PUSHD_OWNER_WALLET");
        w.ownerBps = uint16(vm.envUint("PUSHD_SPLIT_OWNER_BPS"));
        w.burnBps = uint16(vm.envUint("PUSHD_SPLIT_BURN_BPS"));
        require(w.owner != address(0), "the owner wallet is the zero address");
    }

    /// The deployed pair, each of which must exist.
    function _deployed() internal view returns (Token memory t) {
        t.burnPot = PushdBurnPot(payable(_contract("PUSHD_BURN_POT_ADDRESS")));
        t.splitter = PushdSplitter(payable(_contract("PUSHD_SPLITTER_ADDRESS")));
    }

    function _contract(string memory name) private view returns (address a) {
        a = vm.envAddress(name);
        require(a.code.length > 0, string.concat("no contract at ", name));
    }
}
