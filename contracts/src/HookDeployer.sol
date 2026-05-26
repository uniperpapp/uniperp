// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PerpHook}    from "./hook/PerpHook.sol";
import {PerpToken}   from "./token/PerpToken.sol";

/// @title  HookDeployer — owns the CREATE2-deploy of `PerpHook`.
/// @notice Split off `Perpfactory` so the factory's deployed bytecode stays
///         under EIP-170's 24,576-byte ceiling. The factory used to embed
///         `type(PerpHook).creationCode` (PerpHook initcode ≈ 22 KB) for
///         both `new PerpHook{salt:...}(...)` and `type(PerpHook).creationCode`
///         in `hookInitCodeHash` — both moved here so the factory no longer
///         carries that payload.
///
///         `deploy()` is **factory-gated** — only the bound Perpfactory can
///         call it. This closes the only attack-surface delta the split
///         would otherwise introduce: a public deployer would let any EOA
///         pre-occupy a victim's predicted CREATE2 address for the cost
///         of one hook deploy (~6 M gas). With the gate, the only griefing
///         path is `factory.create()` itself (~280 M gas per attempt) —
///         materially the same as pre-split.
///
///         Binding is one-shot: `admin` calls `setFactory(factory)` exactly
///         once, immediately after the factory is deployed. After that, the
///         binding is permanent. Admin cannot rebind, rotate, or revoke.
contract HookDeployer {
    address public immutable admin;   // can call `setFactory` exactly once
    address public          factory;  // gates deploy()

    error OnlyAdmin();
    error OnlyFactory();
    error FactoryAlreadyBound();
    error ZeroAddress();

    event FactoryBound(address indexed factory);

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    /// @notice One-shot bind to the Perpfactory. Admin-only, single use.
    ///         After this call the deployer is permanently locked to
    ///         `factory` and cannot be rebound.
    function setFactory(address factory_) external {
        if (msg.sender != admin)       revert OnlyAdmin();
        if (factory != address(0))     revert FactoryAlreadyBound();
        if (factory_ == address(0))    revert ZeroAddress();
        factory = factory_;
        emit FactoryBound(factory_);
    }

    /// @notice CREATE2-deploy a `PerpHook`. Callable ONLY by the bound
    ///         Perpfactory. The hook constructor runs
    ///         `Hooks.validateHookPermissions`, so a salt whose predicted
    ///         address doesn't carry the v4 hook perm-bit FLAGS reverts
    ///         here (and via the factory's salt-verify check the whole
    ///         `create()` rolls back atomically).
    function deploy(bytes32 salt, IPoolManager pm, PerpToken token, address owner)
        external returns (PerpHook hook)
    {
        if (msg.sender != factory) revert OnlyFactory();
        hook = new PerpHook{salt: salt}(pm, token, owner);
    }

    /// @notice The CREATE2 init-code hash for off-chain salt mining (the
    ///         frontend's web worker + `script/MineSalt.s.sol`). Pure
    ///         (no state read), so anyone can call — it's just a hash.
    function hookInitCodeHash(IPoolManager pm, address token, address owner)
        external pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(
            type(PerpHook).creationCode, abi.encode(pm, token, owner)
        ));
    }
}
