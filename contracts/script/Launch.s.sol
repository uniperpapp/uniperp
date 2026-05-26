// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Perpfactory} from "../src/Perpfactory.sol";
import {PerpHook} from "../src/hook/PerpHook.sol";
import {PerpToken} from "../src/token/PerpToken.sol";

/// @notice Launch one token via the deployed factory. ONE atomic tx:
///         token + perm-mined hook + lens + setBase + setCurve +
///         initializePool + seed 50 launch bands → trading live.
///
///         Prereqs: run script/MineSalt.s.sol first; export the printed
///         TOKEN_SALT / HOOK_SALT.
///
///         Run (X Layer):
///           PRIVATE_KEY=<creator> FACTORY=0xf9424db38dab21434dfe7701626dbed186b4d584 \
///           TOKEN_NAME="My Token" TOKEN_SYMBOL=MYT \
///           BASE=0xe538905cf8410324e03A5A23C1c177a474D59b2b \   # WOKB
///           TOKEN_SALT=0x.. HOOK_SALT=0x.. \
///           forge script script/Launch.s.sol --rpc-url xlayer --broadcast
///
///         V/W are admin-locked per base in the factory (see DeployXLayer),
///         so the creator no longer supplies them — the launch script just
///         reads them back for display. Atomic: a mis-mined salt /
///         mis-ordered currency reverts the WHOLE tx (no partial launch).
contract Launch is Script {
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
        Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG |
        Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG |
        Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        uint256 pk          = vm.envUint("PRIVATE_KEY");
        Perpfactory factory = Perpfactory(vm.envAddress("FACTORY"));
        string memory nm    = vm.envString("TOKEN_NAME");
        string memory sym   = vm.envString("TOKEN_SYMBOL");
        string memory uri   = vm.envOr("TOKEN_URI", string(""));
        address baseAddr    = vm.envAddress("BASE");
        bytes32 tokenSalt   = vm.envBytes32("TOKEN_SALT");
        bytes32 hookSalt    = vm.envBytes32("HOOK_SALT");
        // V/W come from the factory's per-base whitelist (admin-locked).
        (bool allowed, uint128 v, uint128 w) = factory.bases(baseAddr);
        require(allowed, "base not whitelisted");
        // Optional creator seed-buy (D9). 0 = no buy. If >0, creator MUST
        // pre-approve the factory for `seedBuyBase` of the chosen base
        // token; one transferFrom pulls it during create().
        uint256 seedBuy     = vm.envOr("SEED_BUY_BASE", uint256(0));

        // Pre-flight (read-only) so a bad salt fails BEFORE spending gas.
        address predToken = factory.predictToken(tokenSalt, nm, sym, uri);
        address predHook  = factory.predictHook(hookSalt, predToken);
        require(uint160(predToken) > uint160(baseAddr), "token<=base: re-mine TOKEN_SALT");
        require(uint160(predHook) & uint160(0x3fff) == FLAGS, "bad HOOK_SALT: re-mine (perm bits)");

        vm.startBroadcast(pk);

        (address hook, address token, address lens) = factory.create(
            Perpfactory.CreateParams({
                name: nm, symbol: sym, tokenUri: uri, base: baseAddr,
                tokenSalt: tokenSalt, hookSalt: hookSalt,
                seedBuyBase: seedBuy
            })
        );

        vm.stopBroadcast();

        require(hook == predHook && token == predToken, "address prediction mismatch");
        require(PerpHook(payable(hook)).owner() == address(factory), "owner != factory");
        require(PerpHook(payable(hook)).tradingEnabled(), "trading not live");
        require(PerpHook(payable(hook)).bandsSeededCount() == 50, "expected 50 launch bands");
        require(PerpToken(token).totalSupply() == 1_000_000 ether, "supply");

        console2.log("== launched ==");
        console2.log("token       ", token, sym);
        console2.log("hook        ", hook);
        console2.log("lens        ", lens);
        console2.log("base        ", baseAddr);
        console2.log("V (wei)     ", v);
        console2.log("W (wei)     ", w);
        console2.log("launchIndex ", factory.launchCount());
        console2.log("");
        console2.log("Tail bands 50..300 are admin-only (factory.seedTail).");
    }
}
