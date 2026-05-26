// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {PerpToken} from "../token/PerpToken.sol";
import {PerpCurve} from "../library/PerpCurve.sol";
import {PerpTypes} from "../PerpTypes.sol";
import {PerpLib} from "../library/PerpLib.sol";
import {PerpLong} from "../library/PerpLong.sol";
import {PerpShort} from "../library/PerpShort.sol";
import {PerpReserve} from "../library/PerpReserve.sol";

/// @dev Minimal ERC-20 surface for the base (currency0). Mirrors v2's existing
///      token-transfer idiom (PerpCore.IERC20Like).
interface IERC20Base {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  PerpHook — full perp (longs + shorts) on a bonding curve.
/// @notice Thin: holds all state, the v4 callbacks, user entry points, and
///         routes the heavy work to external delegate-libraries (kept under
///         EIP-170). See PERP_DESIGN.md for the complete spec.
contract PerpHook is IHooks, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PerpLib for PerpTypes.PerpState;

    // ─── Constants (PERP_DESIGN §11) ────────────────────────────────────────
    uint16  public constant MAX_LEVERAGE           = 3;
    uint256 public constant LONG_CAP_BPS           = 4000;   // 40% per-band ETH borrow
    uint256 public constant SHORT_CAP_BPS          = 2500;   // 25% per-band TOKEN borrow
    uint256 public constant BORROW_FEE_BPS         = 100;    // 1% at open
    uint256 public constant SWAP_FEE_BPS           = 100;    // 1% spot, external only
    uint256 public constant CLOSE_FEE_BPS          = 100;    // 1% on profit
    uint256 public constant LIQUIDATION_HEALTH_BPS = 10_500; // 105%
    /// @dev Base-denominated econ floors/caps — derived from `_s.curveTickWidth`
    ///      (W) so they auto-scale per base. Audit F6 RESOLVED: the engine
    ///      no longer hardcodes 18-dec/WETH-USD values. The derivation is:
    ///        maxBorrowPerBlock = W              (anti-flash-loan cap)
    ///        badDebtThreshold  = W              (auto-pause trigger)
    ///        minCollateral     = W / 500        (dust floor on open())
    ///      This works for every base because W is already USD-calibrated
    ///      per base via `Perpfactory.setBase` (audited W/V geometry ⇒ ~$10K
    ///      W in any base, ⇒ ~$20 dust floor everywhere).
    uint256 public constant MIN_COLLATERAL_DIVISOR = 500;
    uint256 public constant CLOSE_COOLDOWN_BLOCKS  = 2;
    uint256 public constant NUM_INITIAL_BANDS      = 300;   // curve defined over 300; seed cap + borrow-walk bound
    uint256 public constant LAUNCH_BANDS           = 50;    // trading enables once seeded (~98.6% supply); 50..300 are admin-only tail
    uint256 public constant ANTI_SNIPE_BLOCKS      = 3;     // no external trades/opens for N blocks post-launch; per-instance hook ⇒ launchBlock gate suffices
    uint256 public constant MAX_BORROW_BANDS       = 5;
    uint16  public constant MAX_LIQS_PER_SWAP      = 10;
    uint16  public constant MAX_SCAN_PER_SWAP      = 64;
    uint16  public constant MAX_LIQS_PER_BLOCK     = 5;
    uint32  public constant TWAP_SECONDS           = 300;
    uint256 public constant INSURANCE_BPS_HIGH     = 7000;
    uint256 public constant INSURANCE_BPS_LOW      = 5000;

    /// @dev Hardcoded SPOT-fee recipient. No setter — v1 parity. Receives
    ///      the 1% spot fee taken in beforeSwap/afterSwap. The LEVERAGE-fee
    ///      recipient is separate (see PerpCore.LEVERAGE_FEE_RECIPIENT).
    address internal constant feeRecipient = 0x98Fb2387eb8B5db1811D6789DE8c1e12546d994D;

    // ─── Errors ─────────────────────────────────────────────────────────────
    error NotOwner();
    error PoolMgrOnly();
    error PoolAlreadyInitialized();
    error PoolNotInitializedErr();
    error UnauthorizedLP();
    error ZeroAddress();
    error Reentrancy();
    error InvalidAction();
    error EthTransferFailed();
    error TokenSupplyMismatch();
    error InvalidPoolKey();
    error CollateralBelowMin();
    error InvalidLeverage();
    error NoOpenPosition();
    error NotPositionOwner();
    error CooldownActive();
    error InsufficientBorrowCapacity();
    error BandAlreadySeeded();
    error UnauthorizedInit();
    error InvalidInitPrice();
    error ExactOutputDisallowed();
    error SlippageExceeded();
    error DeadlineExceeded();
    error NothingToClaim();
    error InvalidSellBps();
    error NothingSold();
    error PartialFill();
    error TradingNotEnabled();
    error ProtocolPaused();
    error BadSeedRange();
    error AntiSnipeWindow();
    error TokenTransferFailed();
    error CurveAlreadySet();
    error BadCurveParams();
    error BaseAlreadySet();
    error TwapNotWarm();
    error BorrowCapPerBlockExceeded();
    error NotShortable();

    // ─── Immutables + the single state blob ─────────────────────────────────
    IPoolManager  public immutable poolManager;
    PerpToken     public immutable token;
    address       public immutable owner;
    address       public base;       // currency0; ERC-20, set once by the factory pre-init
    bool          public baseSet;
    bool          public curveSet;   // per-launch (V, tickWidth), set once by the factory pre-init

    PerpTypes.PerpState internal _s;

    uint256 private _locked = 1;
    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }
    modifier onlyOwner()       { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyPoolManager() { if (msg.sender != address(poolManager)) revert PoolMgrOnly(); _; }

    event PositionOpened(uint256 indexed id, address indexed owner, PerpTypes.Side side, uint256 collateral, uint256 debt, uint256 holding);
    event PositionClosed(uint256 indexed id, address indexed owner, uint256 returned);
    event PositionLiquidated(uint256 indexed id, address indexed owner, PerpTypes.Side side);
    event BandSeeded(uint256 indexed bandId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event PausedSet(bool paused);
    event Claimed(address indexed user, uint256 amount);
    event ReserveRebalanced(bool soldToken, uint256 amountIn, uint256 amountOut);
    event BackstopWithdrawn(uint256 ethAmount, uint256 tokAmount);

    constructor(IPoolManager pm_, PerpToken token_, address owner_) {
        if (address(pm_) == address(0) || address(token_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        poolManager = pm_;
        token = token_;
        owner = owner_;
        _s.nextPositionId = 1;
        // `base` and the curve params (curveV/curveK/curveTickWidth) stay
        // zero until the factory's `setBase` + `setCurve` run pre-init.
        // `initializePool` self-guards against either being unset.
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    receive() external payable {}

    // ─── Owner ──────────────────────────────────────────────────────────────
    /// @notice Set per-launch curve params once, pre-init. `k` is always
    ///         derived from `v` so realTokens(0)=TOTAL_SUPPLY holds.
    ///         Degenerate geometry self-reverts at initializePool/seedBands;
    ///         per-base bounds are enforced by the factory whitelist. The
    ///         base-denominated econ params (anti-FL cap, auto-pause, dust
    ///         floor) are derived from `tickWidth` (W) — see the comment on
    ///         `MIN_COLLATERAL_DIVISOR` above. Audit F6 RESOLVED.
    function setCurve(uint256 v, uint256 tickWidth) external onlyOwner {
        if (curveSet || _s.poolInitialized) revert CurveAlreadySet();
        if (v == 0 || tickWidth == 0)       revert BadCurveParams();
        _s.curveV         = v;
        _s.curveK         = PerpCurve.deriveK(v);
        _s.curveTickWidth = tickWidth;
        curveSet = true;
    }

    /// @notice Set the ERC-20 base (currency0) once, pre-init.
    function setBase(address base_) external onlyOwner {
        if (baseSet || _s.poolInitialized) revert BaseAlreadySet();
        if (base_ == address(0))           revert ZeroAddress();
        base    = base_;
        baseSet = true;
    }

    /// @notice Emergency stop for NEW opens only. Spot, closes, liquidations,
    ///         and rebalanceReserve are never affected — users can always exit.
    function pause()   external onlyOwner { _s.paused = true;  emit PausedSet(true);  }
    function unpause() external onlyOwner { _s.paused = false; emit PausedSet(false); }

    /// @notice Owner-timed reserve cleanup. Swaps excess one-sided reserve
    ///         through the pool (no owner capital — pool is counterparty),
    ///         refills bands, clears bad debt. Owner picks direction + amount;
    ///         it moves spot, so use small chunks in favorable conditions.
    ///         `minOut` is the owner's slippage floor on the swap output —
    ///         set it (and/or submit privately) so MEV can't sandwich the heal.
    function rebalanceReserve(bool sellToken, uint256 amount, uint256 minOut) external onlyOwner nonReentrant {
        bytes memory ret = poolManager.unlock(
            abi.encode(PerpTypes.Action.REBALANCE, abi.encode(sellToken, amount, minOut))
        );
        (uint256 amtIn, uint256 amtOut) = abi.decode(ret, (uint256, uint256));
        emit ReserveRebalanced(sellToken, amtIn, amtOut);
    }

    /// @notice Owner withdrawal of the protocol backstop (reserve + insurance,
    ///         either/both assets in one call; pass 0 to skip a side). Pulls
    ///         reserve-first then insurance, and is HARD-CAPPED at the
    ///         reserve+insurance counters — it can never reach user `claimable`
    ///         or long `holdingTOKEN`. Counters drop by exactly the amount sent,
    ///         so INV4/INV5 solvency stays exact. Trusted-owner facility (see
    ///         PERP_DESIGN §5) — deliberately NOT trustless.
    function withdrawBackstop(uint256 ethAmount, uint256 tokAmount) external onlyOwner nonReentrant {
        if (ethAmount > 0) {
            uint256 cap = _s.reserveETH + _s.insuranceETH;
            if (ethAmount > cap) ethAmount = cap;
            uint256 fromRes = ethAmount < _s.reserveETH ? ethAmount : _s.reserveETH;
            _s.reserveETH   -= fromRes;
            _s.insuranceETH -= (ethAmount - fromRes);
            if (!IERC20Base(base).transfer(owner, ethAmount)) revert EthTransferFailed();
        }
        if (tokAmount > 0) {
            uint256 capT = _s.reserveTOKEN + _s.insuranceTOKEN;
            if (tokAmount > capT) tokAmount = capT;
            uint256 fromResT = tokAmount < _s.reserveTOKEN ? tokAmount : _s.reserveTOKEN;
            _s.reserveTOKEN   -= fromResT;
            _s.insuranceTOKEN -= (tokAmount - fromResT);
            if (!token.transfer(owner, tokAmount)) revert TokenTransferFailed();
        }
        emit BackstopWithdrawn(ethAmount, tokAmount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        amount = _s.claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _s.claimable[msg.sender] = 0;
        if (!IERC20Base(base).transfer(msg.sender, amount)) { _s.claimable[msg.sender] = amount; revert EthTransferFailed(); }
        emit Claimed(msg.sender, amount);
    }

    // ─── Pool setup ─────────────────────────────────────────────────────────
    function initializePool() external onlyOwner {
        if (_s.poolInitialized) revert PoolAlreadyInitialized();
        if (!baseSet)           revert ZeroAddress();
        if (!curveSet)          revert BadCurveParams();
        if (token.balanceOf(address(this)) != PerpCurve.TOTAL_SUPPLY) revert TokenSupplyMismatch();

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(base),
            currency1: Currency.wrap(address(token)),
            fee: 0,
            tickSpacing: PerpCurve.TICK_SPACING,
            hooks: IHooks(address(this))
        });
        _s.poolKey = key;

        PerpCurve.CurveParams memory cp = PerpCurve.CurveParams(_s.curveV, _s.curveK, _s.curveTickWidth);
        (, int24 band0TickUpper) = PerpCurve.bandToV4Ticks(0, cp);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(band0TickUpper));
        _s.poolInitialized = true;
        _s.launchBlock = uint64(block.number);

        // Pre-seed TWAP ring so no manipulation window exists right after deploy.
        _s.seedTwap(band0TickUpper, TWAP_SECONDS + 60);
    }

    function seedBands(uint256 fromBand, uint256 toBand) external onlyOwner nonReentrant {
        if (!_s.poolInitialized) revert PoolNotInitializedErr();
        if (toBand > NUM_INITIAL_BANDS || fromBand >= toBand) revert BadSeedRange();
        poolManager.unlock(abi.encode(PerpTypes.Action.SEED_BANDS, abi.encode(fromBand, toBand)));
        _s.bandsSeededCount += (toBand - fromBand);
        if (!_s.tradingEnabled && _s.bandsSeededCount >= LAUNCH_BANDS) _s.tradingEnabled = true;
    }

    /// @notice Atomic seed buy used by `Perpfactory.create()` when a creator
    ///         opts to immediately buy some of their own token at launch.
    ///
    ///         CALLER FLOW: factory `transferFrom(creator → hook, baseIn)`
    ///         FIRST, then calls this. The hook holds `baseIn` of base when
    ///         we enter. Inside the unlock callback we run a normal pool
    ///         swap; because `sender == address(this)`, `beforeSwap`
    ///         early-returns at the top — so this swap is BOTH fee-exempt
    ///         (no 1% spot fee on the creator's launch buy — by design) AND
    ///         anti-snipe-exempt (matches the seedBands exemption that runs
    ///         in the same tx).
    ///
    ///         INV-NEUTRAL: hook base round-trips (in baseIn / out baseIn);
    ///         hook token round-trips (in tokensOut / out tokensOut to
    ///         recipient); reserveETH/insuranceETH/claim unchanged; no
    ///         position opened. INV-4/5 preserved by construction.
    function seedBuy(uint256 baseIn, address recipient)
        external onlyOwner nonReentrant returns (uint256 tokensOut)
    {
        if (!_s.poolInitialized) revert PoolNotInitializedErr();
        if (!_s.tradingEnabled)  revert TradingNotEnabled();
        if (baseIn == 0 || recipient == address(0)) return 0;
        bytes memory ret = poolManager.unlock(
            abi.encode(PerpTypes.Action.SEED_BUY, abi.encode(baseIn, recipient))
        );
        tokensOut = abi.decode(ret, (uint256));
    }

    // ─── v4 callbacks ───────────────────────────────────────────────────────
    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external view onlyPoolManager returns (bytes4)
    {
        if (sender != address(this)) revert UnauthorizedInit();
        if (Currency.unwrap(key.currency0) != base)          revert InvalidPoolKey();
        if (Currency.unwrap(key.currency1) != address(token)) revert InvalidPoolKey();
        if (key.fee != 0)                                    revert InvalidPoolKey();
        if (key.tickSpacing != PerpCurve.TICK_SPACING)       revert InvalidPoolKey();
        if (address(key.hooks) != address(this))             revert InvalidPoolKey();
        PerpCurve.CurveParams memory cp = PerpCurve.CurveParams(_s.curveV, _s.curveK, _s.curveTickWidth);
        (, int24 expectedUpper) = PerpCurve.bandToV4Ticks(0, cp);
        if (sqrtPriceX96 != TickMath.getSqrtPriceAtTick(expectedUpper)) revert InvalidInitPrice();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external view onlyPoolManager returns (bytes4)
    {
        if (sender != address(this)) revert UnauthorizedLP();
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external view onlyPoolManager returns (bytes4)
    {
        if (sender != address(this)) revert UnauthorizedLP();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @notice 1% spot fee on external BUYs (zeroForOne). Hook-internal swaps exempt.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == address(this)) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        if (!_s.tradingEnabled) revert TradingNotEnabled();
        if (block.number < _s.launchBlock + ANTI_SNIPE_BLOCKS) revert AntiSnipeWindow();
        if (params.amountSpecified > 0) revert ExactOutputDisallowed();
        if (params.amountSpecified == type(int256).min) revert ExactOutputDisallowed();
        if (!params.zeroForOne) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 fee = (amountIn * SWAP_FEE_BPS) / 10000;
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        if (fee > uint256(uint128(type(int128).max))) revert ExactOutputDisallowed();

        poolManager.take(key.currency0, address(this), fee);
        _s.claimable[feeRecipient] += fee;
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @notice 1% spot fee on external SELLs + the liquidation scan.
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external onlyPoolManager returns (bytes4, int128)
    {
        if (sender == address(this)) return (IHooks.afterSwap.selector, 0);

        if (!_s.inLiquidation) {
            PerpLib.scanAndLiquidate(
                _s, poolManager, address(token), LIQUIDATION_HEALTH_BPS, TWAP_SECONDS,
                MAX_SCAN_PER_SWAP, MAX_LIQS_PER_SWAP, MAX_LIQS_PER_BLOCK, NUM_INITIAL_BANDS
            );
        }
        PerpLib.writeObservation(_s, poolManager, _poolId());

        if (params.zeroForOne)           return (IHooks.afterSwap.selector, 0);
        if (params.amountSpecified >= 0) return (IHooks.afterSwap.selector, 0);

        int128 ethOut = delta.amount0();
        if (ethOut <= 0) return (IHooks.afterSwap.selector, 0);
        uint256 fee = (uint256(uint128(ethOut)) * SWAP_FEE_BPS) / 10000;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(key.currency0, address(this), fee);
        _s.claimable[feeRecipient] += fee;
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { revert InvalidAction(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { revert InvalidAction(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert InvalidAction(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)  external pure returns (bytes4) { revert InvalidAction(); }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true, afterInitialize: false,
            beforeAddLiquidity: true, afterAddLiquidity: false,
            beforeRemoveLiquidity: true, afterRemoveLiquidity: false,
            beforeSwap: true, afterSwap: true,
            beforeDonate: false, afterDonate: false,
            beforeSwapReturnDelta: true, afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false, afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─── User entry points ──────────────────────────────────────────────────
    function openLong(uint256 leverage, uint256 collateral, uint256 minHoldingOut, uint256 deadline)
        external nonReentrant returns (uint256 positionId, uint256 holdingOut)
    {
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _preOpenChecks(leverage, collateral);
        if (!IERC20Base(base).transferFrom(msg.sender, address(this), collateral)) revert TokenTransferFailed();
        uint256 borrowEth  = collateral * (leverage - 1);
        uint256 borrowFee  = (borrowEth * BORROW_FEE_BPS) / 10_000;
        uint256 effectiveCol = collateral - borrowFee;
        (uint160 sqrtP,,,) = poolManager.getSlot0(_poolId());

        bytes memory ret = poolManager.unlock(abi.encode(
            PerpTypes.Action.OPEN_LONG,
            abi.encode(borrowEth, effectiveCol, borrowFee, msg.sender, leverage)
        ));
        (uint256 actualBorrowed, uint256 swapTokensOut) = abi.decode(ret, (uint256, uint256));
        if (swapTokensOut < minHoldingOut) revert SlippageExceeded();

        positionId = _s.nextPositionId++;
        _s.positions[positionId] = PerpTypes.Position({
            owner: msg.sender, side: PerpTypes.Side.LONG,
            collateralETH: effectiveCol, debtETH: actualBorrowed, debtTOKEN: 0,
            holdingTOKEN: swapTokensOut, heldETH: 0,
            openSqrtPriceX96: sqrtP, leverage: uint8(leverage),
            openedAtBlock: uint64(block.number), realizedOut: 0
        });
        _registerPosition(positionId, msg.sender);
        _s.totalDebtETH      += actualBorrowed;
        _s.totalHoldingTOKEN += swapTokensOut;
        holdingOut = swapTokensOut;
        emit PositionOpened(positionId, msg.sender, PerpTypes.Side.LONG, effectiveCol, actualBorrowed, swapTokensOut);
    }

    function openShort(uint256 leverage, uint256 collateral, uint256 minEthOut, uint256 deadline)
        external nonReentrant returns (uint256 positionId, uint256 heldEthOut)
    {
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _preOpenChecks(leverage, collateral);
        if (!IERC20Base(base).transferFrom(msg.sender, address(this), collateral)) revert TokenTransferFailed();
        uint256 borrowValEth = collateral * (leverage - 1);
        uint256 borrowFee    = (borrowValEth * BORROW_FEE_BPS) / 10_000;
        uint256 effectiveCol = collateral - borrowFee;
        (uint160 sqrtP,,,) = poolManager.getSlot0(_poolId());

        bytes memory ret = poolManager.unlock(abi.encode(
            PerpTypes.Action.OPEN_SHORT,
            abi.encode(borrowValEth, effectiveCol, borrowFee, msg.sender, leverage)
        ));
        (uint256 actualBorrowedTok, uint256 heldEth) = abi.decode(ret, (uint256, uint256));
        if (heldEth < minEthOut) revert SlippageExceeded();

        positionId = _s.nextPositionId++;
        _s.positions[positionId] = PerpTypes.Position({
            owner: msg.sender, side: PerpTypes.Side.SHORT,
            collateralETH: effectiveCol, debtETH: 0, debtTOKEN: actualBorrowedTok,
            holdingTOKEN: 0, heldETH: heldEth,
            openSqrtPriceX96: sqrtP, leverage: uint8(leverage),
            openedAtBlock: uint64(block.number), realizedOut: 0
        });
        _registerPosition(positionId, msg.sender);
        _s.totalDebtTOKEN += actualBorrowedTok;
        _s.totalHeldETH   += heldEth;
        heldEthOut = heldEth;
        emit PositionOpened(positionId, msg.sender, PerpTypes.Side.SHORT, effectiveCol, actualBorrowedTok, heldEth);
    }

    function close(uint256 positionId, uint256 sellBps, uint256 minOut, uint256 deadline)
        external nonReentrant returns (uint256 returned, uint256 consumed)
    {
        if (block.timestamp > deadline) revert DeadlineExceeded();
        if (sellBps == 0 || sellBps > 10_000) revert InvalidSellBps();
        PerpTypes.Position storage p = _s.positions[positionId];
        if (p.owner == address(0)) revert NoOpenPosition();
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (block.number < p.openedAtBlock + CLOSE_COOLDOWN_BLOCKS) revert CooldownActive();

        bytes memory ret = poolManager.unlock(abi.encode(
            PerpTypes.Action.CLOSE, abi.encode(positionId, sellBps, minOut)
        ));
        (returned, consumed) = abi.decode(ret, (uint256, uint256));
    }

    // ─── Unlock callback (routes to delegate-libraries) ─────────────────────
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PerpTypes.Action action, bytes memory payload) = abi.decode(data, (PerpTypes.Action, bytes));

        if (action == PerpTypes.Action.SEED_BANDS) {
            (uint256 f, uint256 t) = abi.decode(payload, (uint256, uint256));
            for (uint256 i = f; i < t; i++) {
                (int24 tl, int24 tu, uint128 liq) = PerpLib.seedSingleBand(_s, poolManager, address(token), i);
                emit BandSeeded(i, tl, tu, liq);
            }
            return "";
        }
        if (action == PerpTypes.Action.OPEN_LONG) {
            return PerpLong.openHandler(
                _s, poolManager, address(token), payload,
                _cfg(), address(0)
            );
        }
        if (action == PerpTypes.Action.OPEN_SHORT) {
            return PerpShort.openHandler(
                _s, poolManager, address(token), payload,
                _cfg(), address(0)
            );
        }
        if (action == PerpTypes.Action.CLOSE) {
            return _routeClose(payload);
        }
        if (action == PerpTypes.Action.REBALANCE) {
            (bool sellTok, uint256 amt, uint256 minOut) = abi.decode(payload, (bool, uint256, uint256));
            return PerpReserve.rebalanceHandler(_s, poolManager, address(token), sellTok, amt, minOut, NUM_INITIAL_BANDS);
        }
        if (action == PerpTypes.Action.SEED_BUY) {
            (uint256 baseIn, address to) = abi.decode(payload, (uint256, address));
            // sender == address(this) ⇒ our own beforeSwap early-returns at
            // the top, so this swap is fee-exempt AND anti-snipe-exempt.
            BalanceDelta d = poolManager.swap(
                _s.poolKey,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(baseIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
            // Settle base out (currency0 owed by hook) using the same
            // sync→transfer→settle pattern PerpCore._payBase uses elsewhere.
            int128 a0 = d.amount0();
            if (a0 < 0) {
                uint256 paid = uint256(uint128(-a0));
                poolManager.sync(_s.poolKey.currency0);
                if (!IERC20Base(base).transfer(address(poolManager), paid)) revert TokenTransferFailed();
                poolManager.settle();
            }
            // Take token to hook (currency1) and forward to the creator.
            uint256 outAmt = 0;
            int128 a1 = d.amount1();
            if (a1 > 0) {
                outAmt = uint256(uint128(a1));
                poolManager.take(_s.poolKey.currency1, address(this), outAmt);
                if (!token.transfer(to, outAmt)) revert TokenTransferFailed();
            }
            return abi.encode(outAmt);
        }
        revert InvalidAction();
    }

    function _routeClose(bytes memory payload) internal returns (bytes memory) {
        (uint256 positionId,,) = abi.decode(payload, (uint256, uint256, uint256));
        PerpTypes.Side side = _s.positions[positionId].side;
        if (side == PerpTypes.Side.LONG) {
            return PerpLong.closeHandler(_s, poolManager, address(token), payload, _cfg(), address(0));
        }
        return PerpShort.closeHandler(_s, poolManager, address(token), payload, _cfg(), address(0));
    }

    // ─── Internal helpers ───────────────────────────────────────────────────
    /// @dev Packs the fee/cap config the libs need (avoids long arg lists).
    function _cfg() internal view returns (PerpTypes.Cfg memory) {
        uint256 w = _s.curveTickWidth;
        return PerpTypes.Cfg({
            longCapBps: LONG_CAP_BPS, shortCapBps: SHORT_CAP_BPS,
            maxBorrowBands: MAX_BORROW_BANDS, numBands: NUM_INITIAL_BANDS,
            twapSeconds: TWAP_SECONDS, maxBorrowPerBlock: w,
            borrowFeeBps: BORROW_FEE_BPS, closeFeeBps: CLOSE_FEE_BPS,
            badDebtThreshold: w,
            insuranceBpsHigh: INSURANCE_BPS_HIGH, insuranceBpsLow: INSURANCE_BPS_LOW,
            liqHealthBps: LIQUIDATION_HEALTH_BPS,
            maxLeverage: MAX_LEVERAGE
        });
    }

    function _preOpenChecks(uint256 leverage, uint256 collateral) internal view {
        if (!_s.poolInitialized) revert PoolNotInitializedErr();
        if (!_s.tradingEnabled) revert TradingNotEnabled();
        if (block.number < _s.launchBlock + ANTI_SNIPE_BLOCKS) revert AntiSnipeWindow();
        if (_s.paused) revert ProtocolPaused();
        if (leverage < 2 || leverage > MAX_LEVERAGE) revert InvalidLeverage();
        if (collateral < _s.curveTickWidth / MIN_COLLATERAL_DIVISOR) revert CollateralBelowMin();
    }

    function _registerPosition(uint256 id, address user) internal {
        _s.userPosIndex[id] = _s.userPositions[user].length;
        _s.userPositions[user].push(id);
        _s.openIdIndex[id] = _s.openIds.length;
        _s.openIds.push(id);
    }

    function _poolId() internal view returns (PoolId) {
        return PoolIdLibrary.toId(_s.poolKey);
    }

    // ─── Minimal views (rich views live in PerpLens) ────────────────────────
    function poolKey() external view returns (PoolKey memory) { return _s.poolKey; }
    function poolInitialized() external view returns (bool) { return _s.poolInitialized; }
    function tradingEnabled() external view returns (bool) { return _s.tradingEnabled; }
    function paused() external view returns (bool) { return _s.paused; }
    function bandsSeededCount() external view returns (uint256) { return _s.bandsSeededCount; }
    function launchBlock() external view returns (uint64) { return _s.launchBlock; }
    function totalDebtETH() external view returns (uint256) { return _s.totalDebtETH; }
    function totalDebtTOKEN() external view returns (uint256) { return _s.totalDebtTOKEN; }
    function totalBadDebtETH() external view returns (uint256) { return _s.totalBadDebtETH; }
    function totalBadDebtTOKEN() external view returns (uint256) { return _s.totalBadDebtTOKEN; }
    function totalHoldingTOKEN() external view returns (uint256) { return _s.totalHoldingTOKEN; }
    function totalHeldETH() external view returns (uint256) { return _s.totalHeldETH; }
    function reserveETH() external view returns (uint256) { return _s.reserveETH; }
    function reserveTOKEN() external view returns (uint256) { return _s.reserveTOKEN; }
    /// @notice Per-launch curve immutables (for PerpLens / off-chain readers).
    function curveParams() external view returns (uint256 v, uint256 k, uint256 tickWidth) {
        return (_s.curveV, _s.curveK, _s.curveTickWidth);
    }
    function insuranceETH() external view returns (uint256) { return _s.insuranceETH; }
    function insuranceTOKEN() external view returns (uint256) { return _s.insuranceTOKEN; }
    function claimable(address u) external view returns (uint256) { return _s.claimable[u]; }
    function openIdsLength() external view returns (uint256) { return _s.openIds.length; }
    function openIdAt(uint256 i) external view returns (uint256) { return _s.openIds[i]; }
    function positions(uint256 id) external view returns (PerpTypes.Position memory) { return _s.positions[id]; }
    function bands(uint256 id) external view returns (PerpTypes.Band memory) { return _s.bands[id]; }
    function userPositions(address u, uint256 i) external view returns (uint256) { return _s.userPositions[u][i]; }
    function userHistoryLength(address u) external view returns (uint256) { return _s.userHistory[u].length; }
    function userHistory(address u, uint256 i) external view returns (PerpTypes.ClosedPositionRecord memory) { return _s.userHistory[u][i]; }
    function getTwapTick(uint32 s) external view returns (int24 t, bool ok) { return PerpLib.twapTick(_s, s); }
    function currentSqrtPriceX96() external view returns (uint160 sp) { (sp,,,) = poolManager.getSlot0(_poolId()); }
}
