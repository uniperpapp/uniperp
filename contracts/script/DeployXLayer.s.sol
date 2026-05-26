// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Perpfactory}  from "../src/Perpfactory.sol";
import {HookDeployer} from "../src/HookDeployer.sol";

/// @notice X Layer (chain 196) mainnet deploy. Deploys HookDeployer + Perpfactory,
///         binds them 1:1, and whitelists WOKB + USDC as bases with calibrated V/W.
///
///         Run:
///           PRIVATE_KEY=0x<deployer> XLAYER_RPC_URL=https://rpc.xlayer.tech \
///             forge script script/DeployXLayer.s.sol --rpc-url xlayer --broadcast
///
///         Bridge a small amount of OKB to the deployer wallet first (for gas).
contract DeployXLayer is Script {
    // Uniswap v4 PoolManager on X Layer mainnet — from
    // https://docs.uniswap.org/contracts/v4/deployments#x-layer-196 ,
    // re-verified on-chain via `cast code` (48 KB runtime).
    address constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    // Factory admin (override at deploy time for your own deployments).
    address constant ADMIN        = 0x38e5Bd272372c2A76f39dd480F3d2f57FE77E166;
    // Wrapped OKB on X Layer (18 decimals, standard ERC-20).
    address constant WOKB         = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;
    // USDC on X Layer (6 decimals).
    address constant USDC         = 0x74b7F16337b8972027F6196A17a631aC6dE26d22;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        // HookDeployer is a sidecar that holds the 22 KB PerpHook initcode so
        // the factory bytecode stays under EIP-170. One-shot bound to the
        // factory via setFactory so only the factory can deploy hooks.
        HookDeployer hookDeployer = new HookDeployer(ADMIN);
        Perpfactory factory = new Perpfactory(IPoolManager(POOL_MANAGER), ADMIN, hookDeployer);
        hookDeployer.setFactory(address(factory));
        require(factory.admin() == ADMIN, "admin mismatch");
        require(address(factory.hookDeployer()) == address(hookDeployer), "hookDeployer mismatch");
        require(hookDeployer.factory() == address(factory), "hookDeployer not bound");

        // ── per-base V/W calibration ────────────────────────────────────────
        // Target launch FDV ≈ $7,487 (= 3.5 × ETH_USD, frozen at deploy time).
        // For each base: V_base = target_USD / base_USD ; W_base = V_base × 10/7.
        //
        //   OKB ≈ $111.71  ⇒ V_WOKB ≈ 67.02 WOKB,  W_WOKB ≈ 95.75 WOKB
        //   USDC ≈ $1.00   ⇒ V_USDC ≈ 7,487 USDC,  W_USDC ≈ 10,696 USDC
        //
        // Re-run setBase when a base's USD price drifts ±10–20%.

        factory.setBase(WOKB, true, 67023136000000000000, 95747337142857142857);
        (bool wOk,,) = factory.bases(WOKB);
        require(wOk, "WOKB not whitelisted");

        factory.setBase(USDC, true, 7487130000, 10695900000);
        (bool uOk,,) = factory.bases(USDC);
        require(uOk, "USDC not whitelisted");

        vm.stopBroadcast();

        console2.log("X Layer Perpfactory ", address(factory));
        console2.log("HookDeployer        ", address(hookDeployer));
        console2.log("poolManager (v4)    ", POOL_MANAGER);
        console2.log("admin               ", ADMIN);
        console2.log("WOKB whitelisted (V=67.02, W=95.75)");
        console2.log("USDC whitelisted (V=7487, W=10696)");
    }
}
