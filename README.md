# SomniaPlace

SomniaPlace is a fully on-chain collaborative pixel-art canvas built for Somnia Shannon testnet. Every pixel placement is a transaction on-chain, and the entire game logic — scoring, anti-griefing, pattern rewards, and decay — runs through **Somnia Reactivity**, the chain's native event-driven execution layer.

## Why Somnia Reactivity

Somnia Reactivity is the core differentiator of this project. It is a dual-mode event subscription system built into the Somnia blockchain:

### On-Chain Reactivity (Validator-Triggered Smart Contract Callbacks)

When a user places a pixel, the `SomniaPlace.sol` canvas contract emits a `PixelPlaced` event. The Somnia Reactivity Precompile (`0x0100`) intercepts this event at the validator level and automatically invokes our `SomniaPlaceReactor.sol` handler contract — with zero off-chain infrastructure, no indexers, no keepers, no cron jobs.

The Reactor then executes game logic atomically:
- **Territory scoring** — BFS cluster detection around the placed pixel; larger clusters earn exponentially more points (`clusterSize * 2`)
- **Pattern rewards** — Detects 2x2 blocks (+8 pts), horizontal-4 lines (+6 pts), vertical-4 lines (+6 pts) owned by the same player
- **Anti-griefing** — Tracks overwrite streaks per pixel; repeated overwrites trigger escalating cooldown penalties via `canvas.setPenaltyCooldown()`
- **Decay sweep** — Stale neighboring pixels (>30 min since last update) are reset via `canvas.decayPixel()`

This is registered as an on-chain Solidity subscription:

```
Emitter:  SomniaPlace.sol (Canvas)
Topic:    PixelPlaced(address,uint16,uint16,uint8,uint256)
Handler:  SomniaPlaceReactor.sol._onEvent()
Precompile: 0x0100
Subscription ID: 4614
```

### Off-Chain Reactivity (Browser Real-Time Event Delivery)

The frontend uses the same `@somnia-chain/reactivity` SDK in **off-chain mode** — `reactivitySdk.subscribe()` opens a WebSocket connection managed by Somnia's infrastructure that pushes contract events to the browser in real-time. This is not standard EVM log polling; it uses the same Reactivity layer that powers the on-chain handler invocations.

Two subscriptions run in the browser:
1. **Canvas subscription** — Watches `PixelPlaced` events from `SomniaPlace.sol` to update the board instantly
2. **Reactor subscription** — Watches `TerritoryScored`, `PatternRewarded`, `CooldownPenaltyApplied`, and `PixelDecayed` events from `SomniaPlaceReactor.sol` to update the leaderboard and cooldown UI

Both subscriptions deliver event payloads (topics + data) through the `onData` callback, which are decoded using viem's `decodeEventLog`.

## How the Reactivity SDK Is Used

### 1. Script-side: Creating the On-Chain Subscription

`scripts/setupSubscription.ts` uses the SDK's `createSoliditySubscription()` method:

```typescript
import { SDK as ReactivitySDK } from "@somnia-chain/reactivity";

const sdk = new ReactivitySDK({ public: publicClient, wallet: walletClient });

await sdk.createSoliditySubscription({
  handlerContractAddress: reactorAddress,   // SomniaPlaceReactor.sol
  emitter: canvasAddress,                   // SomniaPlace.sol
  eventTopics: [pixelPlacedTopic],          // keccak256("PixelPlaced(...)")
  priorityFeePerGas: parseGwei("2"),
  maxFeePerGas: parseGwei("10"),
  gasLimit: 500_000n,
  isGuaranteed: true,
  isCoalesced: false,
});
```

This registers the subscription with the Reactivity Precompile so validators know to invoke the Reactor whenever the Canvas emits `PixelPlaced`.

### 2. Frontend: Real-Time Event Subscriptions

`frontend/src/lib/clients.ts` creates the SDK instance:

```typescript
import { SDK as ReactivitySDK } from "@somnia-chain/reactivity";

export const reactivitySdk = new ReactivitySDK({
  public: wsClient  // viem WebSocket public client
});
```

`frontend/src/App.tsx` subscribes to events:

```typescript
// Canvas events — pixel placements
const canvasSub = await reactivitySdk.subscribe({
  eventContractSources: [canvasAddress],
  topicOverrides: [pixelPlacedTopic],
  ethCalls: [],
  onData: (payload) => handleCanvasStream(payload),
  onError: (error) => console.error("Canvas subscription error", error)
});

// Reactor events — scoring, penalties, decay
const reactorSub = await reactivitySdk.subscribe({
  eventContractSources: [reactorAddress],
  ethCalls: [],
  onData: (payload) => handleReactorStream(payload),
  onError: (error) => console.error("Reactor subscription error", error)
});
```

### 3. Solidity: Reactor Event Handler

`contracts/SomniaPlaceReactor.sol` extends `SomniaEventHandler` from `@somnia-chain/reactivity-contracts`:

```solidity
import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

contract SomniaPlaceReactor is SomniaEventHandler {
    function _onEvent(
        bytes32[] memory topics,
        bytes memory data,
        ...
    ) internal override {
        // Decode PixelPlaced event, run scoring/penalties/decay
    }
}
```

## Architecture

```text
                         ┌───────────────────────────────┐
                         │           User Wallet         │
                         └──────────────┬────────────────┘
                                        │
                                        │ placePixel(x,y,color)
                                        ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Frontend (React + Viem)                         │
│  - Canvas render (100x100 grid)                                   │
│  - Color picker (16 colors)                                       │
│  - Cooldown & penalty UI                                          │
│  - Leaderboard (on-chain scores)                                  │
│  - Somnia Reactivity SDK subscribe() for live event push          │
└──────────────┬───────────────────────────────┬─────────────────────┘
               │                               │
               │ write path                    │ Reactivity subscribe()
               ▼                               ▼
┌───────────────────────────┐      ┌─────────────────────────────────┐
│   SomniaPlace.sol         │      │ @somnia-chain/reactivity SDK    │
│ - canonical canvas state  │      │ - off-chain WebSocket mode      │
│ - cooldowns               │      │ - pushes PixelPlaced events     │
│ - user stats              │      │ - pushes Reactor events         │
│ - emits PixelPlaced       │      └─────────────────────────────────┘
└──────────────┬────────────┘
               │
               │ PixelPlaced event
               ▼
┌───────────────────────────┐
│ Reactivity Precompile     │
│ 0x0100                    │
│ Subscription #4614        │
└──────────────┬────────────┘
               │ validator-invoked callback
               ▼
┌───────────────────────────┐
│ SomniaPlaceReactor.sol    │
│ - territory scoring (BFS) │
│ - pattern rewards          │
│ - anti-griefing penalties │
│ - decay sweep             │
│ extends SomniaEventHandler│
└──────────────┬────────────┘
               │ onlyReactor hooks
               ▼
┌───────────────────────────┐
│ SomniaPlace.sol           │
│ reactive state updates    │
└───────────────────────────┘
```

## Shannon Testnet Config

| Parameter | Value |
|-----------|-------|
| Chain ID | `50312` |
| HTTP RPC | `https://dream-rpc.somnia.network` |
| WebSocket RPC | `wss://dream-rpc.somnia.network/ws` |
| Native Token | STT |
| Explorer | `https://shannon-explorer.somnia.network` |
| Faucet | `https://testnet.somnia.network/` |
| Reactivity Precompile | `0x0000000000000000000000000000000000000100` |

## Deployed Contracts (Shannon Testnet)

| Contract | Address |
|----------|---------|
| SomniaPlace (Canvas) | `0x199D3e126b2BE52954F5DFCc145463a96659cb19` |
| SomniaPlaceReactor | `0xf9CBa4cD9dfDd8dBE88C7345CCFb04495d13Bf1b` |
| Reactivity Subscription | ID `4614` |

## Project Layout

```
placer/
├── contracts/
│   ├── SomniaPlace.sol              # On-chain canvas, cooldowns, packed pixel storage
│   └── SomniaPlaceReactor.sol       # Reactivity handler: scoring, penalties, decay
├── scripts/
│   ├── deploy.ts                    # Deploy canvas + reactor, link them, write env
│   ├── setupSubscription.ts         # Create Reactivity subscription via SDK
│   └── lib/
│       ├── somnia.ts                # Chain config
│       ├── deployments.ts           # Deployment manifest I/O
│       └── artifacts.ts             # Hardhat artifact reader
├── deployments/
│   └── shannon.json                 # Deployed addresses + subscription ID
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Main UI with Reactivity subscriptions
│   │   ├── styles.css               # Dark aesthetic, responsive canvas
│   │   └── lib/
│   │       ├── clients.ts           # Reactivity SDK + viem clients
│   │       ├── chain.ts             # Somnia chain definition
│   │       ├── contracts.ts         # ABI exports
│   │       └── pixels.ts            # Pixel packing/unpacking
│   └── package.json
├── hardhat.config.ts
└── package.json
```

## Dependencies

### On-Chain
- `@somnia-chain/reactivity-contracts` — Solidity `SomniaEventHandler` base contract

### Script-Side
- `@somnia-chain/reactivity` — TypeScript SDK for creating Solidity subscriptions

### Frontend
- `@somnia-chain/reactivity` — TypeScript SDK for off-chain WebSocket event subscriptions
- `viem` — Ethereum client library (wallet connection, contract reads/writes)
- `react` 19 — UI framework
- `framer-motion` — Animations
- `lucide-react` — Icons

## Environment

Root `.env`:
- `PRIVATE_KEY` — Deployer/subscription owner key (never exposed in browser)
- `SOMNIA_RPC_URL` — Optional HTTP RPC override
- `SOMNIA_WS_URL` — Optional WebSocket RPC override

Frontend `.env` (auto-generated by `scripts/deploy.ts`):
- `VITE_SOMNIA_PLACE_ADDRESS`
- `VITE_SOMNIA_REACTOR_ADDRESS`
- `VITE_SOMNIA_CHAIN_ID`
- `VITE_SOMNIA_RPC_URL`
- `VITE_SOMNIA_WS_URL`
- `VITE_SOMNIA_EXPLORER_URL`
- `VITE_CANVAS_WIDTH` / `VITE_CANVAS_HEIGHT` / `VITE_PALETTE_SIZE`

## Local Workflow

```bash
# 1. Install dependencies
npm install

# 2. Add root .env with PRIVATE_KEY
echo "PRIVATE_KEY=0x..." > .env

# 3. Compile contracts
npm run compile

# 4. Deploy to Shannon testnet
npm run deploy

# 5. Create Reactivity subscription (requires 32+ STT balance)
npm run setup:subscription

# 6. Start frontend dev server
npm run frontend:dev
```

## Notes

- Wallet connection uses EIP-6963 provider detection to specifically target MetaMask, avoiding Trust Wallet / Coinbase hijacking `window.ethereum`.
- The reactor does not re-emit `PixelPlaced`, avoiding subscription loops.
- The leaderboard is fully on-chain: scores on the Reactor, placement counts on the Canvas.
- Hardhat uses Solidity 0.8.28 and 0.8.30 (the latter required by `@somnia-chain/reactivity-contracts`).
- Pixel placement includes optimistic UI updates — the board cell updates immediately after TX confirmation, before the Reactivity event arrives.
