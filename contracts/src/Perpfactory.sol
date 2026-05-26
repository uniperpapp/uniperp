// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PerpToken}    from "./token/PerpToken.sol";
import {PerpHook}     from "./hook/PerpHook.sol";
import {PerpLens}     from "./hook/PerpLens.sol";
import {HookDeployer} from "./HookDeployer.sol";

/// @dev Minimal base-asset surface for the optional seed buy (one
///      transferFrom: creator → hook). Same `IERC20`-shaped contract
///      the engine already uses for currency0 settlement.
interface IBaseLike {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  Perpfactory — permissionless launchpad for v2-engine perp tokens.
/// @notice One creator tx (`create`) atomically deploys a token + a CREATE2
///         hook (perm-bit verified) + lens, moves the full supply into the
///         hook, configures the per-launch base/curve, initializes the pool,
///         seeds the 50 launch bands, and goes live. Engine logic is exactly
///         v2 (faithfully generalized to an ERC-20 base + parameterized
///         curve). The factory is the hook `owner`; ongoing owner-ops are
///         gated to `admin` only — the creator gets ZERO privileged powers,
///         and there is intentionally NO path to `withdrawBackstop`
///         (unreachable ⇒ effectively disabled for launchpad instances).
///
///         Off-chain salt mining: a miner computes `tokenSalt` then mines
///         `hookSalt` so the hook address carries the v4 perm bits, using the
///         exact init-code hashes this contract exposes (`tokenInitCodeHash` /
///         `hookInitCodeHash`) — eliminating any library-link mismatch. A
///         wrong `hookSalt` makes the hook constructor's
///         `Hooks.validateHookPermissions` revert, so the whole `create`
///         reverts atomically (no partial launch).
contract Perpfactory {
    IPoolManager public immutable poolManager;
    /// @notice Protocol admin (v2 deployer 0x38e5Bd272372c2A76f39dd480F3d2f57FE77E166
    ///         in production) — the only address that can curate the base
    ///         whitelist and trigger ongoing owner-ops on launched hooks.
    address public immutable admin;
    /// @notice Owns the CREATE2-deploy of every `PerpHook`. Split out so the
    ///         factory's deployed bytecode stays under EIP-170 (PerpHook's
    ///         ~22 KB initcode would push the factory over the 24,576-byte
    ///         limit). See `HookDeployer.sol` for the security delta.
    HookDeployer public immutable hookDeployer;

    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;

    // v4 hook permission bits the mined hook address must carry.
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
        Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG |
        Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG |
        Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint160 internal constant FLAG_MASK = uint160(0x3fff);

    /// @notice Per-base launch policy. Admin USD-calibrates V/W when
    ///         whitelisting a base; every launch on that base uses these
    ///         exact values (creator has no V/W choice — see `create()`).
    ///         The 3 base-denominated econ params (anti-FL cap, auto-pause
    ///         threshold, dust floor) are NOT stored here — the hook derives
    ///         them from W (`_s.curveTickWidth`) on the fly, so non-18-dec
    ///         and differently-priced bases all work without engine churn
    ///         (audit F6 RESOLVED).
    struct BaseInfo {
        bool    allowed;
        uint128 v;          // V locked per base, raw base units
        uint128 tickWidth;  // W locked per base, raw base units
    }
    mapping(address => BaseInfo) public bases;

    struct Launch {
        address hook;
        address token;
        address lens;
        address base;
        address creator;
        uint64  createdAt;
    }
    Launch[] public launches;
    mapping(address => uint256) public hookId; // hook → launches index + 1 (0 = unknown)

    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyAdmin()    { require(msg.sender == admin, "not admin"); _; }

    error NotWhitelisted();
    error BadParams();
    error BadHookAddr();
    error TransferFailed();

    event BaseSet(address indexed base, bool allowed);
    event Launched(
        address indexed hook, address indexed token, address indexed creator,
        address lens, address base, uint256 v, uint256 tickWidth,
        string name, string symbol, string tokenUri
    );

    constructor(IPoolManager pm_, address admin_, HookDeployer hd_) {
        require(address(pm_) != address(0) && admin_ != address(0) && address(hd_) != address(0), "zero");
        poolManager  = pm_;
        admin        = admin_;
        hookDeployer = hd_;
    }

    // ─── admin: base whitelist ──────────────────────────────────────────────
    function setBase(address base, bool allowed, uint128 v, uint128 tickWidth)
        external onlyAdmin
    {
        bases[base] = BaseInfo(allowed, v, tickWidth);
        emit BaseSet(base, allowed);
    }

    // ─── deterministic address prediction (for the off-chain salt miner) ────
    function tokenInitCodeHash(string calldata name, string calldata symbol, string calldata tokenUri)
        public pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(type(PerpToken).creationCode, abi.encode(name, symbol, tokenUri)));
    }

    function hookInitCodeHash(address token) public view returns (bytes32) {
        // Delegated to HookDeployer so `type(PerpHook).creationCode` stays
        // out of this contract's bytecode (EIP-170 size constraint).
        return hookDeployer.hookInitCodeHash(poolManager, token, address(this));
    }

    function predictToken(
        bytes32 tokenSalt, string calldata name, string calldata symbol, string calldata tokenUri
    ) external view returns (address) {
        return _create2(tokenSalt, tokenInitCodeHash(name, symbol, tokenUri));
    }

    function predictHook(bytes32 hookSalt, address token) external view returns (address) {
        // Hook is CREATE2-deployed BY `hookDeployer`, so its address is
        // derived from hookDeployer's address (not the factory's).
        return _create2By(address(hookDeployer), hookSalt, hookInitCodeHash(token));
    }

    function _create2(bytes32 salt, bytes32 initHash) internal view returns (address) {
        return _create2By(address(this), salt, initHash);
    }

    function _create2By(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(
            keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash))
        )));
    }

    // ─── launch ─────────────────────────────────────────────────────────────
    /// @dev V/W are NOT creator inputs — they're read straight from
    ///      `bases[base]` (admin-locked per base). The creator controls only
    ///      identity, base choice, salts, and optional seed-buy.
    struct CreateParams {
        string  name;
        string  symbol;
        string  tokenUri;     // IPFS URI of the off-chain metadata JSON (immutable)
        address base;
        bytes32 tokenSalt;
        bytes32 hookSalt;     // off-chain mined so hook addr carries FLAGS
        uint256 seedBuyBase;  // optional creator initial buy, 0 = none
    }

    function create(CreateParams calldata p)
        external nonReentrant
        returns (address hook, address token, address lens)
    {
        BaseInfo memory bi = bases[p.base];
        if (!bi.allowed) revert NotWhitelisted();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert BadParams();

        // 1. token (CREATE2) — mints TOTAL_SUPPLY to this factory.
        token = address(new PerpToken{salt: p.tokenSalt}(p.name, p.symbol, p.tokenUri));

        // 2. hook (CREATE2 at the off-chain-mined salt, deployed BY the
        //    external HookDeployer so PerpHook's ~22 KB initcode stays out
        //    of this contract's bytecode). The hook constructor runs
        //    Hooks.validateHookPermissions, so a wrong salt reverts the
        //    whole create() atomically. Explicit FLAGS assert as
        //    belt-and-suspenders.
        PerpHook h = hookDeployer.deploy(p.hookSalt, poolManager, PerpToken(token), address(this));
        hook = address(h);
        if (uint160(hook) & FLAG_MASK != FLAGS) revert BadHookAddr();

        // 3. lens.
        lens = address(new PerpLens(h));

        // 4. move full supply into the hook — preserves v2's exact
        //    initializePool invariant (balanceOf(hook) == TOTAL_SUPPLY).
        if (!PerpToken(token).transfer(hook, TOTAL_SUPPLY)) revert TransferFailed();

        // 5. configure + go live (factory is hook.owner ⇒ onlyOwner calls ok).
        h.setBase(p.base);
        h.setCurve(bi.v, bi.tickWidth);
        h.initializePool();
        h.seedBands(0, 25);
        h.seedBands(25, 50);   // bandsSeededCount == LAUNCH_BANDS(50) ⇒ trading enabled

        // 6. optional seed buy — fee-exempt + anti-snipe-exempt via the
        //    hook's sender==self path (see PerpHook.seedBuy doc + AUDIT D9).
        //    Pulls base directly from the creator (msg.sender) into the hook
        //    in a SINGLE transferFrom, then the hook does the swap and
        //    forwards the tokens to the creator. Factory holds no base.
        if (p.seedBuyBase > 0) {
            if (!IBaseLike(p.base).transferFrom(msg.sender, hook, p.seedBuyBase))
                revert TransferFailed();
            h.seedBuy(p.seedBuyBase, msg.sender);
        }

        // 7. registry.
        launches.push(Launch(hook, token, lens, p.base, msg.sender, uint64(block.timestamp)));
        hookId[hook] = launches.length;
        emit Launched(hook, token, msg.sender, lens, p.base, bi.v, bi.tickWidth, p.name, p.symbol, p.tokenUri);
    }

    function launchCount() external view returns (uint256) { return launches.length; }

    // ─── admin-gated ongoing owner-ops (creator gets NONE) ──────────────────
    // No withdrawBackstop wrapper exists ⇒ that owner power is unreachable for
    // every launched hook (factory is owner; no path) = disabled for launchpad.
    function seedTail(address hook, uint256 from, uint256 to) external onlyAdmin {
        PerpHook(payable(hook)).seedBands(from, to);   // 50..300 tail, only if a token runs there
    }
    function pause(address hook)   external onlyAdmin { PerpHook(payable(hook)).pause(); }
    function unpause(address hook) external onlyAdmin { PerpHook(payable(hook)).unpause(); }
    function rebalanceReserve(address hook, bool sellToken, uint256 amount, uint256 minOut)
        external onlyAdmin
    {
        PerpHook(payable(hook)).rebalanceReserve(sellToken, amount, minOut);
    }
}
