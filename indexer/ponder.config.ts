import { createConfig } from "@ponder/core";
import { http, parseAbiItem } from "viem";

import { PerpfactoryAbi } from "./abis/Perpfactory";
import { PerpHookAbi } from "./abis/PerpHook";
import { PerpTokenAbi } from "./abis/PerpToken";

const chainId = Number(process.env.CHAIN_ID ?? 196);
// "mainnet" is just Ponder's internal label for the configured network. For
// this X Layer build it resolves to X Layer mainnet (chain 196). Chain id from
// CHAIN_ID env, RPC from PONDER_RPC_URL_1.
const network = "mainnet";

const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

const startBlock = Number(process.env.START_BLOCK ?? 0);

// Ponder's `factory()` source pattern: subscribe to Perpfactory.Launched →
// auto-discover EVERY launched hook + token + lens and start indexing per-clone
// events from that point. No EventBus contract needed; no contract change to
// the audited engine.
//
// Architecture — Ponder factory() source pattern adapted to the perpfactory
// event scatter:
//   Perpfactory   — top-level subscription; Launched event drives discovery.
//   PerpHook      — discovered per launch; we index PositionOpened /
//                   PositionClosed / PositionLiquidated / Claimed +
//                   PausedSet / BandSeeded / ReserveRebalanced
//                   (the launched-instance state-changing events).
//   PerpToken     — discovered per launch; ERC-20 Transfer for holder tracking.
//
// Spot swaps go through the v4 PoolManager and don't emit a hook-side event
// today. For MVP we attribute volume from PositionOpened/Closed (leverage) and
// Claimed (fees); a future enhancement can index PoolManager.Swap filtered by
// poolId == toId(launch.poolKey) — adds an extra subscription per clone.

export default createConfig({
  networks: {
    mainnet: {
      chainId,
      transport: http(process.env.PONDER_RPC_URL_1),
      pollingInterval: 2_000,
    },
  },

  contracts: {
    // (1) The factory itself — singleton.
    Perpfactory: {
      network,
      address: FACTORY_ADDRESS,
      abi: PerpfactoryAbi,
      startBlock,
    },

    // (2) Every launched hook clone — auto-discovered from Launched events.
    //     Ponder dynamically subscribes to the hook addr emitted as `hook`.
    PerpHook: {
      network,
      abi: PerpHookAbi,
      factory: {
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event Launched(address indexed hook, address indexed token, address indexed creator, address lens, address base, uint256 v, uint256 tickWidth, string name, string symbol, string tokenUri)",
        ),
        parameter: "hook",
      },
      startBlock,
    },

    // (3) Every launched token clone — auto-discovered. Transfer-only.
    PerpToken: {
      network,
      abi: PerpTokenAbi,
      factory: {
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event Launched(address indexed hook, address indexed token, address indexed creator, address lens, address base, uint256 v, uint256 tickWidth, string name, string symbol, string tokenUri)",
        ),
        parameter: "token",
      },
      startBlock,
    },
  },
});
