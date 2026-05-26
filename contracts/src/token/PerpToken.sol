// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/src/tokens/ERC20.sol";

/// @notice Plain fixed-supply ERC20. No mint/burn surface.
///
///         Constructor takes per-launch `name` / `symbol` / `tokenUri` and
///         mints `TOTAL_SUPPLY` to `msg.sender` (the factory). The factory
///         then `transfer`s the full supply to the hook before
///         `initializePool` so the hook's `balanceOf(hook) == TOTAL_SUPPLY`
///         invariant still gates init.
contract PerpToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;

    string private _name;
    string private _symbol;
    /// @notice IPFS URI of the off-chain metadata JSON
    ///         ({description, image, twitter, telegram, website, ...}). Set
    ///         ONCE at construction; **there is no setter** — the token's
    ///         identity is content-addressed and permanent. Audit-trivial:
    ///         one constructor SSTORE, zero ongoing mutation surface.
    string public tokenUri;

    constructor(string memory name_, string memory symbol_, string memory tokenUri_) {
        _name    = name_;
        _symbol  = symbol_;
        tokenUri = tokenUri_;
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }
}
