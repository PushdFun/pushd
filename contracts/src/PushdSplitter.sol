// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

interface IBurnPotWiring {
    function splitter() external view returns (address);
    function factory() external view returns (address);
    function token() external view returns (address);
}

interface ITransferable {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title PushdSplitter
/// @notice The address $PUSHD's trading fees are paid to on Pons. Everything that arrives here is divided two ways,
///         in shares (basis points) fixed when it is deployed:
///           the owner wallet
///           the burn pot, which buys $PUSHD and burns it
///         The two shares and the burn pot are immutable. One thing can change: the owner wallet itself may hand its
///         own share of future splits to another address, in two steps (it proposes, the new address accepts).
///         Nobody else can change anything. The token is not set here either; it is read from the burn pot, which
///         launches it.
/// @dev Pons never pushes fees. The tax first sits on the bonding curve, a sweep moves it into Pons' fee escrow, and
///      the escrow keeps a ledger. sweep() does both steps and splits, claim() does the escrow half alone, and ETH
///      sent straight to this contract is split by distribute(). All three can be called by anyone.
///
///      Rounding: the owner share is rounded down and the burn share is whatever is left, so the two always add up
///      to exactly what came in and the dust is burned.
///
///      A destination that refuses its ETH does not stop the other: its share is written down as pending and stays
///      here until retry() delivers it, or until the owner wallet collects its own refused share elsewhere.
///
///      Changing the owner wallet: the line is the moment of acceptOwnerPayee(). Every split before it was made for the
///      wallet that was the owner then (paid, or pending under that wallet's name, which only that wallet can collect);
///      every split from it on is made for the new one, including fees that were already on the curve, in the escrow
///      or here unsplit at that moment. The change touches only who receives the owner share: the burn pot's amounts
///      are the same, to the wei, whether or not it happens.
///
///      Fees arrive as ETH. Pons' escrow can also hold a credit in a token; if it ever holds one in $PUSHD for this
///      contract, claimToken() takes it and sends it to the burn pot, which burns it. $PUSHD is never split.
///
///      Tested against the real Pons on a fork of Robinhood Chain (test/fork). No OpenZeppelin.
contract PushdSplitter {
    uint16 public constant BPS = 10_000;
    /// @dev The owner is an ordinary wallet, but a wallet can carry code these days. A bounded push keeps such code
    ///      from eating all the gas and failing the split for everyone.
    uint256 internal constant WALLET_PUSH_GAS = 50_000;

    /// @notice The wallet the owner share is paid to. Only it can propose another (proposeOwnerPayee), and the change
    ///         happens only when the proposed address accepts (acceptOwnerPayee).
    address payable public owner;
    /// @notice The address the owner wallet has proposed to hand its share to, or zero when there is none.
    address payable public proposedOwner;
    address payable public immutable burnPot;
    IPonsV2FeeEscrow public immutable escrow;

    uint16 public immutable ownerBps;
    uint16 public immutable burnBps;

    /// @notice Shares that could not be delivered when they were split, by destination. They are not split again.
    ///         ownerPending is the total for every wallet that has been the owner; ownerPendingOf says whose it is.
    uint256 public ownerPending;
    mapping(address => uint256) public ownerPendingOf;
    uint256 public burnPending;

    uint256 public totalSplit;
    uint256 public totalToOwner;
    uint256 public totalToBurn;

    uint256 private _locked = 1;

    event Split(uint256 amount, uint256 toOwner, uint256 toBurn, bool ownerPushed, bool burnPushed);
    event PendingDelivered(address indexed to, uint256 amount);
    event TokensSentToBurn(uint256 amount);
    event OwnerPayeeProposed(address indexed current, address indexed proposed);
    event OwnerPayeeProposalCancelled(address indexed current, address indexed proposed);
    event OwnerPayeeChanged(address indexed previous, address indexed current);

    error ZeroAddress();
    error BadWallets();
    error BadShares();
    error PotMismatch();
    error EscrowMismatch();
    error NotAllowed();
    error NothingPending();
    error NothingProposed();
    error PushFailed();
    error Reentered();
    error TransferFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @dev The burn pot must already exist and be wired to this address (the deploy script predicts this address
    ///      from the deployer's nonce and gives it to the burn pot). If it is missing or wired elsewhere this
    ///      constructor fails, so fees can never be aimed at a splitter that pays an empty address.
    constructor(
        address payable owner_,
        address payable burnPot_,
        IPonsV2FeeEscrow escrow_,
        uint16 ownerBps_,
        uint16 burnBps_
    ) {
        if (owner_ == address(0) || burnPot_ == address(0) || address(escrow_) == address(0)) {
            revert ZeroAddress();
        }
        // the owner wallet is none of the other places: that would quietly turn one share into the other
        if (owner_ == burnPot_ || owner_ == address(this) || owner_ == address(escrow_)) revert BadWallets();
        if (ownerBps_ == 0 || burnBps_ == 0) revert BadShares();
        if (uint256(ownerBps_) + burnBps_ != BPS) revert BadShares();
        if (burnPot_.code.length == 0) revert PotMismatch();
        if (IBurnPotWiring(burnPot_).splitter() != address(this)) revert PotMismatch();
        // this contract claims from the escrow the live factory credits, or it would wait on the wrong ledger
        if (IPonsV2LaunchFactory(IBurnPotWiring(burnPot_).factory()).feeEscrow() != address(escrow_)) {
            revert EscrowMismatch();
        }
        owner = owner_;
        burnPot = burnPot_;
        escrow = escrow_;
        ownerBps = ownerBps_;
        burnBps = burnBps_;
    }

    receive() external payable {}

    /// @notice Everything in one transaction: release the fees still on the bonding curve into Pons' escrow, claim
    ///         what the escrow holds for this contract, and split it. Anyone may call it; PUSHD's keeper does,
    ///         regularly.
    /// @dev Only the fee recipient (this contract) or Pons' own keeper may release a curve's fees, which is why the
    ///      release has to be a function here. Buyback is off for the token, so the release swaps nothing and its
    ///      zero minimum cannot be sandwiched. The release is best effort: it reverts when there is nothing on the
    ///      curve, and after graduation only Pons' keeper can release the pool's fees. The claim runs either way.
    function sweep() external nonReentrant returns (uint256 amount) {
        address c = curve();
        if (c != address(0)) {
            try IPonsV2BondingCurve(c).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Claim what the escrow holds for this contract and split it.
    function claim() external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Claim whatever $PUSHD Pons' escrow holds for this contract and send every $PUSHD here to the burn
    ///         pot, which burns all it holds with its next burn. Anyone may call it. With nothing to claim and nothing
    ///         here (or before the launch) it does nothing and returns zero.
    function claimToken() external nonReentrant returns (uint256 amount) {
        address t = IBurnPotWiring(burnPot).token();
        if (t == address(0)) return 0;
        if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
        amount = ITransferable(t).balanceOf(address(this));
        if (amount == 0) return 0;
        if (!ITransferable(t).transfer(burnPot, amount)) revert TransferFailed();
        emit TokensSentToBurn(amount);
    }

    /// @notice Split whatever ETH is here and has not been split yet.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice The token's bonding curve while this contract can still release its fees: zero before the launch and
    ///         from graduation on.
    function curve() public view returns (address) {
        address t = IBurnPotWiring(burnPot).token();
        if (t == address(0)) return address(0);
        try IPonsV2LaunchFactory(IBurnPotWiring(burnPot).factory()).getLaunchedToken(t) returns (
            IPonsV2LaunchFactory.LaunchedToken memory info
        ) {
            if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
        } catch {}
        return address(0);
    }

    /// @notice ETH here that has arrived and not been split yet.
    function unsplit() public view returns (uint256) {
        return address(this).balance - ownerPending - burnPending;
    }

    /// @notice Deliver every share that was refused earlier, each to the destination it was split for. Anyone may
    ///         call it. A share that is refused again simply stays pending. The owner share goes to the current owner
    ///         wallet; a wallet that was the owner before collects its own with withdrawOwner().
    function retry() external nonReentrant {
        address payable o = owner;
        uint256 a = ownerPendingOf[o];
        if (a > 0) {
            ownerPendingOf[o] = 0;
            ownerPending -= a;
            if (_pushCapped(o, a)) {
                emit PendingDelivered(o, a);
            } else {
                ownerPendingOf[o] = a;
                ownerPending += a;
            }
        }
        uint256 b = burnPending;
        if (b > 0) {
            burnPending = 0;
            (bool ok,) = burnPot.call{value: b}("");
            if (ok) emit PendingDelivered(burnPot, b);
            else burnPending = b;
        }
    }

    /// @notice The owner wallet, or a wallet that was the owner before, collects a share of its own that it refused,
    ///         to an address it names. Only ETH already split as that wallet's owner share can leave this way; the
    ///         burn share cannot.
    function withdrawOwner(address payable to) external nonReentrant {
        uint256 a = ownerPendingOf[msg.sender];
        if (a == 0) {
            if (msg.sender != owner) revert NotAllowed();
            revert NothingPending();
        }
        ownerPendingOf[msg.sender] = 0;
        ownerPending -= a;
        _send(to, a);
    }

    /// @notice Step one of handing the owner share to another address: the current owner wallet names it. Nothing
    ///         changes until that address calls acceptOwnerPayee(), so a mistyped address changes nothing. A new
    ///         proposal replaces the one before. The burn pot, this contract and the escrow cannot be proposed: that
    ///         would turn one share into the other.
    function proposeOwnerPayee(address payable next) external nonReentrant {
        address payable o = owner;
        if (msg.sender != o) revert NotAllowed();
        if (next == address(0)) revert ZeroAddress();
        if (next == o || next == burnPot || next == address(this) || next == address(escrow)) revert BadWallets();
        proposedOwner = next;
        emit OwnerPayeeProposed(o, next);
    }

    /// @notice The current owner wallet withdraws its proposal before it is accepted.
    function cancelOwnerPayee() external nonReentrant {
        address payable o = owner;
        if (msg.sender != o) revert NotAllowed();
        address payable p = proposedOwner;
        if (p == address(0)) revert NothingProposed();
        proposedOwner = payable(address(0));
        emit OwnerPayeeProposalCancelled(o, p);
    }

    /// @notice Step two: the proposed address accepts, and from this call on the owner share of every split is paid
    ///         to it. What was split before stays the previous wallet's: anything pending under its name is still
    ///         its own to collect with withdrawOwner(). The shares and the burn pot do not change.
    function acceptOwnerPayee() external nonReentrant {
        address payable p = proposedOwner;
        if (p == address(0)) revert NothingProposed();
        if (msg.sender != p) revert NotAllowed();
        address payable previous = owner;
        owner = p;
        proposedOwner = payable(address(0));
        emit OwnerPayeeChanged(previous, p);
    }

    function _send(address payable to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
        emit PendingDelivered(to, amount);
    }

    /// @dev A push with a fixed amount of gas that ignores whatever the receiver returns: nothing the receiver hands
    ///      back is copied, so code on a wallet can neither take more gas than the cap nor make this contract pay to
    ///      read a large reply.
    function _pushCapped(address to, uint256 value) internal returns (bool ok) {
        uint256 gasCap = WALLET_PUSH_GAS;
        assembly ("memory-safe") {
            ok := call(gasCap, to, value, 0, 0, 0, 0)
        }
    }

    function _distribute() internal returns (uint256 amount) {
        amount = unsplit();
        if (amount == 0) return 0;
        uint256 toOwner = (amount * ownerBps) / BPS;
        // the remainder, so the two always add up to the whole and the rounding dust is burned, not kept
        uint256 toBurn = amount - toOwner;

        totalSplit += amount;
        totalToOwner += toOwner;
        totalToBurn += toBurn;

        // A share whose push is refused is written down and stays here; the other is not held up by it. ETH that
        // arrives while these pushes run is not part of this split: it waits, unsplit, for the next call.
        bool okBurn = true;
        if (toBurn > 0) {
            (okBurn,) = burnPot.call{value: toBurn}("");
            if (!okBurn) burnPending += toBurn;
        }
        bool okOwner = true;
        if (toOwner > 0) {
            address payable o = owner;
            okOwner = _pushCapped(o, toOwner);
            if (!okOwner) {
                ownerPending += toOwner;
                ownerPendingOf[o] += toOwner;
            }
        }
        emit Split(amount, toOwner, toBurn, okOwner, okBurn);
    }
}
