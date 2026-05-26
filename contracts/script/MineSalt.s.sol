// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Perpfactory} from "../src/Perpfactory.sol";

/// @notice Off-chain salt miner for a launch. Reads the DEPLOYED factory's own
///         `tokenInitCodeHash`/`hookInitCodeHash` views (so the init-code
///         hashes are byte-exact to what `factory.create()` will use — no
///         library-link mismatch), then brute-forces:
///
///           tokenSalt : CREATE2(factory,      tokenSalt, tokenHash) > BASE
///                       (v4 currency0(base) < currency1(token); see AUDIT F2)
///           hookSalt  : CREATE2(hookDeployer, hookSalt,  hookHash) & 0x3fff == FLAGS
///                       (hook address must carry the v4 perm bits)
///
///         CREATE2 deployers:
///           tokenSalt → `factory` (factory does `new PerpToken` inside create())
///           hookSalt  → `factory.hookDeployer()` (separate contract, split off
///                       so factory bytecode fits EIP-170 — see src/HookDeployer.sol)
///
///         This is the exact in-EVM port of test/Harness.sol::_mineSaltsFor
///         (test-proven by Perpfactory.test_Create2Determinism).
///
///         Run (read-only, no key, no broadcast):
///           FACTORY=0x.. TOKEN_NAME="My Token" TOKEN_SYMBOL=MYT \
///           TOKEN_URI=ipfs://bafy.../metadata.json \
///           BASE=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
///           forge script script/MineSalt.s.sol --rpc-url mainnet
///
///         Feed the printed TOKEN_SALT / HOOK_SALT into script/Launch.s.sol.
contract MineSalt is Script {
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
        Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG |
        Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG |
        Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint160 constant FLAG_MASK = uint160(0x3fff);

    function _c2(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(
            keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash))
        )));
    }

    function run() external view {
        Perpfactory factory = Perpfactory(vm.envAddress("FACTORY"));
        string memory nm  = vm.envString("TOKEN_NAME");
        string memory sym = vm.envString("TOKEN_SYMBOL");
        string memory uri = vm.envOr("TOKEN_URI", string(""));
        address baseAddr  = vm.envAddress("BASE");

        // init-code hashes straight from the deployed factory (link-safe).
        bytes32 tHash = factory.tokenInitCodeHash(nm, sym, uri);

        bytes32 tokenSalt;
        address tok;
        bool gotT;
        for (uint256 ts = 0; ts < 5_000_000; ts++) {
            tok = _c2(address(factory), bytes32(ts), tHash);
            if (uint160(tok) > uint160(baseAddr)) { tokenSalt = bytes32(ts); gotT = true; break; }
        }
        require(gotT, "no tokenSalt (token>base) in range");

        bytes32 hHash = factory.hookInitCodeHash(tok);
        address hookDep = address(factory.hookDeployer());

        bytes32 hookSalt;
        address hk;
        bool gotH;
        for (uint256 hs = 0; hs < 5_000_000; hs++) {
            address h = _c2(hookDep, bytes32(hs), hHash);
            if (uint160(h) & FLAG_MASK == FLAGS) { hookSalt = bytes32(hs); hk = h; gotH = true; break; }
        }
        require(gotH, "no hookSalt (FLAGS) in range");

        // Cross-check against the factory's OWN prediction views — guarantees
        // the off-chain mining matches the on-chain create() byte-for-byte.
        require(factory.predictToken(tokenSalt, nm, sym, uri) == tok, "predictToken mismatch");
        require(factory.predictHook(hookSalt, tok) == hk,             "predictHook mismatch");
        require(uint160(tok) > uint160(baseAddr),                     "ordering check");
        require(uint160(hk) & FLAG_MASK == FLAGS,                     "flags check");

        console2.log("== mined OK ==");
        console2.log("FACTORY     ", address(factory));
        console2.log("BASE        ", baseAddr);
        console2.log("name/symbol ", nm, sym);
        console2.log("tokenUri    ", uri);
        console2.log("predToken   ", tok);
        console2.log("predHook    ", hk);
        console2.log("TOKEN_SALT  ", vm.toString(tokenSalt));
        console2.log("HOOK_SALT   ", vm.toString(hookSalt));
        console2.log("");
        console2.log("export TOKEN_SALT=", vm.toString(tokenSalt));
        console2.log("export HOOK_SALT=",  vm.toString(hookSalt));
    }
}
