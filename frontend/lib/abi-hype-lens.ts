export const hypeLensAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "hook_",
        "type": "address",
        "internalType": "contract HypeHook"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "LIQ_HEALTH_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPoolSnapshot",
    "inputs": [],
    "outputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct HypeLens.PoolSnapshot",
        "components": [
          {
            "name": "sqrtPriceX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "currentTick",
            "type": "int24",
            "internalType": "int24"
          },
          {
            "name": "curveEth",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalDebtETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalDebtTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalBadDebtETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalBadDebtTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalHoldingTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalHeldETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reserveETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reserveTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "insuranceETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "insuranceTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "numOpenPositions",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalSupply",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "poolInitialized",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "tradingEnabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "paused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "launchBlock",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPosition",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "v",
        "type": "tuple",
        "internalType": "struct HypeLens.PositionView",
        "components": [
          {
            "name": "id",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "side",
            "type": "uint8",
            "internalType": "enum HypeTypes.Side"
          },
          {
            "name": "collateralETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "debtETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "debtTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "holdingTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "heldETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "openedAtBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "currentValueEth",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "healthBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "liquidatable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "liquidationEth",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getUserPositions",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "views",
        "type": "tuple[]",
        "internalType": "struct HypeLens.PositionView[]",
        "components": [
          {
            "name": "id",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "side",
            "type": "uint8",
            "internalType": "enum HypeTypes.Side"
          },
          {
            "name": "collateralETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "debtETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "debtTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "holdingTOKEN",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "heldETH",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "openedAtBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "currentValueEth",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "healthBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "liquidatable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "liquidationEth",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hook",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract HypeHook"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolManager",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPoolManager"
      }
    ],
    "stateMutability": "view"
  }
] as const;
