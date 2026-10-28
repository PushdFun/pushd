// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPonsV2BondingCurve, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "./interfaces/IPoolManager.sol";

interface ISplitterWiring {
    function burnPot() external view returns (address);
}

/// @dev What every token the Pons launch factory makes offers: the caller destroys its own tokens and totalSupply()
///      falls by the same amount. Checked against the live chain in the fork tests.
interface IBurnableToken {
    function balanceOf(address who) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burn(uint256 value) external;
}

/// @title PushdBurnPot
/// @notice Holds the burn share of $PUSHD's trading fees, and any $PUSHD sent to it.
///         The only thing ETH can do here is buy $PUSHD and burn it, and the only thing $PUSHD can do here is be
///         burned: the token's own burn(), so its total supply falls by exactly what was burned. A burn that did not
///         lower the supply by that amount reverts.
///         - $PUSHD is launched on Pons BY THIS CONTRACT (launch(), the launcher only, once) with the fee settings
///           forced, so the pot can only ever burn that one token and its fees can only go to the splitter
///         - the launcher's opening buy happens inside that same transaction and its tokens go to the launcher
///           wallet; how much it spent and how many tokens it bought are recorded here
///         - burn() can be called by anyone (PUSHD's keeper calls it on a schedule), at most once every 30 minutes;
///           a burn spends what the pot holds up to 1% of the market's ETH depth, what that cap leaves waits for the
///           next one, and every $PUSHD the pot holds is burned with it
///         - below MIN_BURN the ETH waits, but it is always spent 24 hours after the last burn that spent ETH (a
///           burn of paid-in $PUSHD alone does not restart that day); $PUSHD that arrived by a transfer is burned
///           at the next burn whatever the ETH
///         - it buys on the Pons bonding curve before graduation and in the Uniswap v4 pool after
///         There is no withdraw function and no owner. If Pons ever ends the launch in its Rescued phase there is
///         nowhere to buy and the ETH stays here for good.
/// @dev Why anyone may call burn(): what makes a forced buy worth attacking is its size against the market, and that
///      is capped here (1% of depth on either venue, and on v4 a hard price limit of a 1% move of the square root
///      price). The round trip through the token's own fees costs a trader far more than a capped burn can move the
///      price, so buying before a burn and selling after it loses money.
///      Tested against the real Pons on a fork of Robinhood Chain (test/fork). No OpenZeppelin: the reentrancy guard
///      and the token calls are written out.
contract PushdBurnPot is IUnlockCallback {
    uint16 public constant BPS = 10_000;
    uint256 public constant DEPTH_BPS = 100; // a burn spends at most 1% of the market's ETH depth
    uint256 public constant MIN_INTERVAL = 30 minutes;
    uint256 public constant MAX_WAIT = 24 hours;
    uint256 public constant MIN_BURN = 0.001 ether;
    /// @notice The creator tax on every $PUSHD trade, fixed at launch.
    uint16 public constant CREATOR_TAX_BPS = 300;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant POOLS_SLOT = 6; // v4-core StateLibrary
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    /// @notice The wallet that launches $PUSHD and makes the opening buy. It has no other power here.
    address public immutable launcher;
    address public immutable splitter;
    IPonsV2LaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;
    address public immutable hook;

    IBurnableToken public token; // $PUSHD, set by launch() and by nothing else
    uint256 public startedAt; // when launch() ran: the burn schedule starts here

    /// @notice The launcher's opening buy, made inside the launch transaction: the ETH it spent and the tokens that
    ///         arrived in the launcher wallet, both measured. Written once. Nothing here can move those tokens.
    uint256 public openingBuyEth;
    uint256 public openingBuyTokens;

    uint256 public lastBurnAt;
    /// @notice The last burn that spent ETH: MAX_WAIT for a small amount counts from here, so burning a speck of
    ///         $PUSHD sent in every half hour cannot keep small ETH waiting for good.
    uint256 public lastEthBurnAt;
    uint256 public burnCount;
    uint256 public totalEthBurned;
    uint256 public totalTokensBurned;

    uint256 private _locked = 1;

    struct Market {
        bool ok; // a buy can go through right now
        bool viaCurve;
        address curve;
        uint24 fee;
        int24 tickSpacing;
        uint160 priceLimit; // v4 only
        uint256 depthCap; // the most ETH one burn may spend, from the market's depth
    }

    event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve);
    event TokenSet(address indexed token);
    event LaunchExemption(address indexed wallet);
    event OpeningBuy(address indexed wallet, uint256 ethIn, uint256 tokensOut);

    error NotLauncher();
    error Reentered();
    error DuplicateExemption(address wallet);
    error ZeroAddress();
    error TokenAlreadySet();
    error TokenNotSet();
    error TooSoon(uint256 nextAt);
    error TooSmall(uint256 amount, uint256 min);
    error NothingToBurn();
    error NotPoolManager();
    error Slippage();
    error NotPonsLaunch();
    error WrongFeeRecipient(address recipient);
    error NotEthPair();
    error WrongCreatorTax(uint16 bps);
    error BuybackEnabled();
    error SplitterMismatch();
    error MarketNotReady();
    error Overcharged();
    error LaunchFeeShort(uint256 fee);
    error SupplyDidNotFall();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address launcher_, IPonsV2LaunchFactory factory_, address splitter_) {
        if (launcher_ == address(0) || address(factory_) == address(0) || splitter_ == address(0)) {
            revert ZeroAddress();
        }
        launcher = launcher_;
        splitter = splitter_;
        factory = factory_;
        poolManager = IPoolManager(factory_.poolManager());
        hook = factory_.memeHook();
    }

    receive() external payable {}

    /// @notice The launcher only, once: launch $PUSHD on Pons from this contract and start the burn schedule.
    ///         Name, symbol, logo, description, socials, salt and the optional economics pin come from `params`.
    ///         The fee recipient (the splitter), the creator tax, buyback off and the ETH pair are forced and read
    ///         back.
    ///
    ///         msg.value is the Pons launch fee plus the opening buy: everything above the fee buys $PUSHD on the
    ///         curve in this same transaction and those tokens go straight to the launcher wallet. Nothing can trade
    ///         ahead of it, because the coin does not exist until this transaction runs, and the pot's own ETH is
    ///         never used for it.
    ///
    ///         Pons taxes the first seconds of a launch at up to 99% and exempts only the wallets it is handed. This
    ///         contract is exempt as the launch's deployer and the splitter as its fee recipient; the launcher is
    ///         added here, and `alsoExempt` is every further wallet that should be. Each exemption is published.
    function launch(
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256 launchConfigId,
        address[] calldata alsoExempt
    ) external payable nonReentrant returns (address token_) {
        if (msg.sender != launcher) revert NotLauncher();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (ISplitterWiring(splitter).burnPot() != address(this)) revert SplitterMismatch();

        uint256 fee = factory.launchFee();
        if (msg.value < fee) revert LaunchFeeShort(fee);
        uint256 openingBuy = msg.value - fee;

        IPonsV2LaunchFactory.TokenParams memory p = params;
        p.creatorFeeRecipient = splitter;
        p.creatorTaxBps = CREATOR_TAX_BPS;
        p.buybackEnabled = false;

        // the launcher first, then the rest; every entry is checked rather than trusted, because the zero address or
        // a repeat would spend an exemption on nobody
        address[] memory exempt = new address[](alsoExempt.length + 1);
        exempt[0] = launcher;
        for (uint256 i = 0; i < alsoExempt.length; ++i) {
            address a = alsoExempt[i];
            if (a == address(0)) revert ZeroAddress();
            for (uint256 j = 0; j <= i; ++j) {
                if (a == exempt[j]) revert DuplicateExemption(a);
            }
            exempt[i + 1] = a;
        }
        (token_,) = factory.launchToken{value: fee}(p, launchConfigId, address(0), exempt);

        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token_);
        if (!info.exists || info.token != token_ || info.deployer != address(this)) revert NotPonsLaunch();
        if (info.creatorFeeRecipient != splitter) revert WrongFeeRecipient(info.creatorFeeRecipient);
        if (info.pairToken != address(0)) revert NotEthPair();
        if (info.creatorTaxBps != CREATOR_TAX_BPS) revert WrongCreatorTax(info.creatorTaxBps);
        if (info.buybackEnabled) revert BuybackEnabled();

        token = IBurnableToken(token_);
        startedAt = block.timestamp;
        emit TokenSet(token_);
        for (uint256 i = 0; i < exempt.length; ++i) {
            emit LaunchExemption(exempt[i]);
        }

        // The opening buy. A zero minimum is safe because no other trade can exist yet. What is recorded is what was
        // measured: the ETH that left this contract and the tokens that arrived in the launcher wallet. Whatever the
        // curve refunds (only possible for a buy larger than the whole curve) stays here as burn budget.
        if (openingBuy > 0) {
            uint256 ethBefore = address(this).balance;
            uint256 tokensBefore = IBurnableToken(token_).balanceOf(launcher);
            IPonsV2BondingCurve(info.curve).buy{value: openingBuy}(openingBuy, 0, launcher);
            uint256 spent = ethBefore - address(this).balance;
            uint256 got = IBurnableToken(token_).balanceOf(launcher) - tokensBefore;
            openingBuyEth = spent;
            openingBuyTokens = got;
            emit OpeningBuy(launcher, spent, got);
        }
    }

    // ---------- views ----------

    /// @notice Whether a buy can go through right now, where it goes, and the depth cap: 1% of the curve's quote
    ///         reserve including its virtual part, or of the v4 pool's in-range ETH depth L / sqrtP.
    ///         open = false (and depthCap = max) before launch, between graduation and pool creation, or after a
    ///         Pons rescue.
    function market() external view returns (bool open, bool viaCurve, uint256 depthCap) {
        if (address(token) == address(0)) return (false, false, type(uint256).max);
        Market memory m = _market();
        return (m.ok, m.viaCurve, m.depthCap);
    }

    /// @notice What burn() would do. `amount` is the ETH the next burn would spend and `nextAt` the earliest time
    ///         burn() allows it, assuming the balances and the market do not change and nobody burns first; (0, 0)
    ///         means nothing is waiting. `tokens` is the $PUSHD here, all of which the next burn destroys. `ready` is
    ///         true exactly when burn() would go through now.
    function preview() external view returns (uint256 amount, uint256 nextAt, bool ready, uint256 tokens) {
        if (address(token) == address(0)) return (0, 0, false, 0);
        Market memory m = _market();
        tokens = token.balanceOf(address(this));
        uint256 since = _since();
        uint256 sinceEth = _sinceEth();
        uint256 open = since + MIN_INTERVAL;
        if (open < block.timestamp) open = block.timestamp;
        amount = _amountAt(address(this).balance, m.ok ? m.depthCap : type(uint256).max);
        if (amount > 0) {
            nextAt = open;
            // a small amount waits for more, but never past a day; held tokens never wait for it
            if (amount < MIN_BURN && sinceEth + MAX_WAIT > nextAt) nextAt = sinceEth + MAX_WAIT;
        }
        if (tokens > 0 && (nextAt == 0 || open < nextAt)) nextAt = open;
        if (block.timestamp >= since + MIN_INTERVAL) {
            (uint256 spend,) = _plan(m, sinceEth);
            ready = tokens > 0 || spend > 0;
        }
    }

    // ---------- the burn ----------

    /// @notice Buy $PUSHD with what the pot holds, up to the depth cap, and burn it together with every $PUSHD the
    ///         pot already held: the token's own burn(), so the total supply falls by exactly `tokensBurned`.
    /// @param minTokensOut a floor on the tokens bought (a price floor if the buy is only partly filled). The keeper
    ///        passes 0 and relies on the cap; a caller who wants a tighter bound passes a quote.
    function burn(uint256 minTokensOut) external nonReentrant returns (uint256 ethIn, uint256 tokensBurned) {
        if (address(token) == address(0)) revert TokenNotSet();
        uint256 since = _since();
        if (block.timestamp < since + MIN_INTERVAL) revert TooSoon(since + MIN_INTERVAL);
        Market memory m = _market();
        uint256 balBefore = address(this).balance;
        uint256 tokensBefore = token.balanceOf(address(this));
        (uint256 amount, uint256 capped) = _plan(m, _sinceEth());
        if (amount == 0 && tokensBefore == 0) {
            if (balBefore == 0) revert NothingToBurn();
            if (!m.ok) revert MarketNotReady();
            revert TooSmall(capped, MIN_BURN);
        }

        lastBurnAt = block.timestamp;
        if (amount > 0) {
            lastEthBurnAt = block.timestamp;
            if (m.viaCurve) {
                IPonsV2BondingCurve(m.curve).buy{value: amount}(amount, 0, address(this));
            } else {
                poolManager.unlock(abi.encode(amount, m.fee, m.tickSpacing, m.priceLimit));
            }
            // what really left: the curve refunds whatever it could not fill, v4 settles only what it swapped
            ethIn = balBefore - address(this).balance;
            if (ethIn > amount) revert Overcharged();
            uint256 bought = token.balanceOf(address(this)) - tokensBefore;
            if (ethIn == amount ? bought < minTokensOut : (minTokensOut * ethIn) / amount > bought) revert Slippage();
        }
        tokensBurned = token.balanceOf(address(this));

        burnCount += 1;
        totalEthBurned += ethIn;
        totalTokensBurned += tokensBurned;
        // everything the pot holds, including $PUSHD that arrived another way; and the supply must really fall
        uint256 supplyBefore = token.totalSupply();
        token.burn(tokensBurned);
        if (supplyBefore - token.totalSupply() != tokensBurned) revert SupplyDidNotFall();
        emit Burned(burnCount, msg.sender, ethIn, tokensBurned, amount > 0 && m.viaCurve);
    }

    // ---------- schedule internals ----------

    function _since() internal view returns (uint256) {
        return lastBurnAt == 0 ? startedAt : lastBurnAt;
    }

    function _sinceEth() internal view returns (uint256) {
        return lastEthBurnAt == 0 ? startedAt : lastEthBurnAt;
    }

    /// @dev Everything the pot holds, less whatever the market's depth will not take right now.
    function _amountAt(uint256 bal, uint256 depthCap) internal pure returns (uint256 amount) {
        amount = bal < depthCap ? bal : depthCap;
    }

    /// @dev The ETH a burn now would spend (`amount`), and what the cap allows before the MIN_BURN rule (`capped`).
    ///      No market, nothing to spend; under MIN_BURN, nothing until a day has passed since the last burn that spent
    ///      ETH (`since`).
    function _plan(Market memory m, uint256 since) internal view returns (uint256 amount, uint256 capped) {
        if (!m.ok) return (0, 0);
        capped = _amountAt(address(this).balance, m.depthCap);
        amount = capped < MIN_BURN && block.timestamp < since + MAX_WAIT ? 0 : capped;
    }

    // ---------- market internals ----------

    function _key(uint24 fee, int24 tickSpacing) internal view returns (PoolKey memory) {
        return
            PoolKey({currency0: address(0), currency1: address(token), fee: fee, tickSpacing: tickSpacing, hooks: hook});
    }

    /// @dev Where a buy can go right now and how much ETH it may take given the market's depth.
    ///      Curve: 1% of its quote reserve (virtual + real: the constant-product depth a trade faces).
    ///      v4: 1% of the in-range ETH depth L * 2^96 / sqrtPriceX96, and a hard swap price limit of a 1% sqrt-price
    ///      (about 2% price) move, so even just-in-time liquidity cannot make a burn move the price more.
    ///      Between graduation and pool creation, or after a Pons rescue, there is nowhere to buy.
    function _market() internal view returns (Market memory m) {
        m.depthCap = type(uint256).max;
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(address(token));
        if (info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) {
            m.viaCurve = true;
            m.curve = info.curve;
            if (IPonsV2BondingCurve(info.curve).readyToGraduate()) return m;
            (uint256 quoteReserve,) = IPonsV2BondingCurve(info.curve).getReserves();
            m.depthCap = (quoteReserve * DEPTH_BPS) / BPS;
            m.ok = true;
        } else if (info.phase == IPonsV2LaunchFactory.GraduationPhase.PoolCreated) {
            m.fee = info.poolFee;
            m.tickSpacing = info.tickSpacing;
            bytes32 poolId = keccak256(abi.encode(_key(info.poolFee, info.tickSpacing)));
            uint256 stateSlot = uint256(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
            uint160 sqrtP = uint160(uint256(poolManager.extsload(bytes32(stateSlot))));
            uint128 liquidity = uint128(uint256(poolManager.extsload(bytes32(stateSlot + LIQUIDITY_OFFSET))));
            if (sqrtP == 0) return m;
            // liquidity < 2^128 and Q96 = 2^96, so the product fits in 224 bits
            m.depthCap = ((uint256(liquidity) * Q96) / sqrtP * DEPTH_BPS) / BPS;
            // A hard bound on the burn's own price impact, whatever liquidity sits in range (in-range liquidity can
            // be inflated just in time): sqrtP may drop at most 1%, so the price moves at most about 2.01%. If the
            // limit stops the swap early, only the ETH actually swapped leaves; the rest stays for the next burn.
            uint256 limit = (uint256(sqrtP) * BPS) / (BPS + DEPTH_BPS);
            m.priceLimit = limit > MIN_SQRT_PRICE ? uint160(limit) : MIN_SQRT_PRICE + 1;
            m.ok = true;
        }
    }

    /// @dev Uniswap v4: runs inside poolManager.unlock. ETH is currency0 (address 0), so zeroForOne.
    ///      Settles at most the planned ETH; the slippage floor is applied by burn() for both venues.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 ethIn, uint24 fee, int24 tickSpacing, uint160 limit) =
            abi.decode(data, (uint256, uint24, int24, uint160));
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: limit});
        int256 delta = poolManager.swap(_key(fee, tickSpacing), p, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        if (amount0 >= 0 || amount1 <= 0) revert Slippage();
        uint256 owe = uint256(uint128(-amount0));
        if (owe > ethIn) revert Overcharged();
        poolManager.settle{value: owe}();
        poolManager.take(address(token), address(this), uint256(uint128(amount1)));
        return "";
    }
}
