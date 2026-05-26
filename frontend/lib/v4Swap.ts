import { encodeAbiParameters, encodePacked, type Hex, type Address } from "viem";

/// V4-router action identifiers. Source: Uniswap/v4-periphery Actions.sol.
const ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL:           0x0c,
  TAKE_ALL:             0x0f,
} as const;

/// UR command identifier for a V4 swap. Source: Uniswap/universal-router Commands.sol.
const COMMAND_V4_SWAP = 0x10;

const NATIVE = "0x0000000000000000000000000000000000000000" as const;

export interface PoolKey {
  currency0: Address;   // sorted asc; address(0) = native ETH
  currency1: Address;
  fee: number;          // perpfactory pools use 0
  tickSpacing: number;  // perpfactory pools use 60
  hooks: Address;
}

/// Build the perpfactory / $PERP PoolKey. base==address(0) ⇒ native-ETH pool
/// (v2 $PERP); otherwise base is the ERC-20 currency0 (launch pools, where the
/// salt miner guarantees token > base ⇒ base = currency0, token = currency1).
export function buildPerpPoolKey(opts: {
  base: Address;   // WETH/PERP for launches, 0x0 for v2 $PERP
  token: Address;  // launched token / PERP
  hook: Address;
}): PoolKey {
  const baseIsNative = opts.base.toLowerCase() === NATIVE;
  // Native (0x0) always sorts first. For ERC-20 bases the miner enforces
  // token > base, so currency0 = base in both cases.
  return {
    currency0: baseIsNative ? NATIVE : opts.base,
    currency1: opts.token,
    fee: 0,
    tickSpacing: 60,
    hooks: opts.hook,
  };
}

/// Encode an exact-input single-hop swap into the bytes blob the Universal
/// Router expects under command 0x10 (V4_SWAP).
export function encodeV4ExactInSingle(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
): Hex {
  const [currencyIn, currencyOut] = zeroForOne
    ? [key.currency0, key.currency1]
    : [key.currency1, key.currency0];

  const actions: Hex = `0x${ACTIONS.SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, "0")}${ACTIONS.SETTLE_ALL.toString(16).padStart(2, "0")}${ACTIONS.TAKE_ALL.toString(16).padStart(2, "0")}`;

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { type: "address", name: "currency0" },
              { type: "address", name: "currency1" },
              { type: "uint24",  name: "fee" },
              { type: "int24",   name: "tickSpacing" },
              { type: "address", name: "hooks" },
            ],
          },
          { type: "bool",    name: "zeroForOne" },
          { type: "uint128", name: "amountIn" },
          { type: "uint128", name: "amountOutMinimum" },
          { type: "bytes",   name: "hookData" },
        ],
      },
    ],
    [
      {
        poolKey: key,
        zeroForOne,
        amountIn,
        amountOutMinimum: amountOutMin,
        hookData: "0x",
      } as any,
    ],
  );

  // SETTLE_ALL: (currency, maxAmount) we pay
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, amountIn],
  );
  // TAKE_ALL: (currency, minAmount) we accept
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, amountOutMin],
  );

  return encodeAbiParameters(
    [
      { type: "bytes",   name: "actions" },
      { type: "bytes[]", name: "params" },
    ],
    [actions, [swapParams, settleParams, takeParams]],
  );
}

/// Build the (commands, inputs) tuple for UniversalRouter.execute(...).
export function buildV4ExactInCall(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
): { commands: Hex; inputs: Hex[] } {
  const commands = encodePacked(["uint8"], [COMMAND_V4_SWAP]);
  const inputs = [encodeV4ExactInSingle(key, zeroForOne, amountIn, amountOutMin)];
  return { commands, inputs };
}
