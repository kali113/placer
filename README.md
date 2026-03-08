# SomniaPlace

SomniaPlace is a fully on-chain collaborative pixel-art game for Somnia Shannon. Wallets place pixels directly on a shared canvas contract, Somnia Reactivity runs validator-triggered game logic on each `PixelPlaced` event, and Somnia Data Streams pushes live updates to the frontend over WebSocket without polling.

## Why Somnia

Somnia is a strong fit for `r/place`-style gameplay because the workload is concentrated on shared state: many users write to the same canvas and the same contract family. The chain is positioned for fully on-chain mass-consumer apps, with published Somnia materials emphasizing high throughput, sub-second finality, and low-cost execution for games and social systems. The Nodes.guru architecture write-up is especially relevant here because it describes Somnia’s approach as optimizing high sequential throughput on shared logic rather than relying on application sharding. That maps directly to a collaborative canvas where contention is the feature, not an edge case.

## Reactivity vs Streams

- On-Chain Reactivity: validator-triggered smart-contract callbacks for scoring, anti-griefing penalties, and decay. In this project that path is `SomniaPlace.sol -> PixelPlaced -> Reactivity Precompile 0x0100 -> SomniaPlaceReactor.sol`.
- Somnia Data Streams: WebSocket delivery of structured on-chain data to the UI. In this project the default frontend path subscribes to canonical contract events, while `scripts/setupDataStream.ts` registers an optional structured mirror/feed for future extensions.

## Architecture

```text
                         ┌───────────────────────────────┐
                         │           User Wallet         │
                         └──────────────┬────────────────┘
                                        │
                                        │ placePixel(x,y,color)
                                        ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Frontend (React + Viem)                    │
│  - canvas render                                                  │
│  - color picker                                                   │
│  - cooldown UI                                                    │
│  - leaderboard                                                    │
│  - WebSocket Streams subscription                                 │
└──────────────┬───────────────────────────────┬─────────────────────┘
               │                               │
               │ write path                    │ read path (live push)
               ▼                               ▼
┌───────────────────────────┐      ┌─────────────────────────────────┐
│   SomniaPlace.sol         │      │ Somnia Data Streams subscribe() │
│ - canonical canvas state  │      │ - default: direct contract logs │
│ - cooldowns               │      │ - optional structured mirror    │
│ - stats                   │      └─────────────────────────────────┘
│ - emits PixelPlaced       │                     │
└──────────────┬────────────┘                     │ WebSocket push
               │                                  │
               │ PixelPlaced event                ▼
               ▼                      ┌───────────────────────────────┐
┌───────────────────────────┐         │ Frontend updates changed pixel│
│ Reactivity Precompile     │         │ instantly; no polling/indexer │
│ 0x0100                    │         └───────────────────────────────┘
└──────────────┬────────────┘
               │ validator-invoked callback
               ▼
┌───────────────────────────┐
│ SomniaPlaceReactor.sol    │
│ - territory scoring       │
│ - anti-griefing           │
│ - combos / rewards        │
│ - decay                   │
└──────────────┬────────────┘
               │ onlyReactor hooks
               ▼
┌───────────────────────────┐
│ SomniaPlace.sol           │
│ reactive updates / scores │
└───────────────────────────┘
```

## Shannon Config

- Chain ID: `50312`
- HTTP RPC: `https://dream-rpc.somnia.network`
- WebSocket RPC: `wss://dream-rpc.somnia.network/ws`
- Symbol: `STT`
- Explorer: `https://shannon-explorer.somnia.network`
- Faucet: `https://testnet.somnia.network/`

## Project Layout

- [contracts/SomniaPlace.sol](/home/arch/place/contracts/SomniaPlace.sol): canonical on-chain canvas, cooldowns, packed pixel storage, and reactor hooks.
- [contracts/SomniaPlaceReactor.sol](/home/arch/place/contracts/SomniaPlaceReactor.sol): Somnia event handler with bounded local scoring, overwrite penalties, and decay.
- [scripts/deploy.ts](/home/arch/place/scripts/deploy.ts): deploys canvas and reactor, links them, and writes deployment metadata.
- [scripts/setupSubscription.ts](/home/arch/place/scripts/setupSubscription.ts): creates the Solidity subscription for `PixelPlaced`.
- [scripts/setupDataStream.ts](/home/arch/place/scripts/setupDataStream.ts): registers optional Streams schemas and event metadata for a structured mirror path.
- [frontend/](/home/arch/place/frontend): React + TypeScript + Vite UI with viem wallet flow and live Streams listeners.
- [hardhat.config.ts](/home/arch/place/hardhat.config.ts): Shannon-ready Hardhat config.

## Environment

Root `.env` values:

- `PRIVATE_KEY`: deployer/subscription owner key. Never expose this in browser code.
- `SOMNIA_RPC_URL`: optional override for Shannon HTTP RPC. Defaults to `https://dream-rpc.somnia.network`.
- `SOMNIA_WS_URL`: optional override for Shannon WebSocket RPC. Defaults to `wss://dream-rpc.somnia.network/ws`.
- `CANVAS_WIDTH`: optional deploy override. Defaults to `100`.
- `CANVAS_HEIGHT`: optional deploy override. Defaults to `100`.
- `PALETTE_SIZE`: optional deploy override. Defaults to `16`.

Frontend env values are written automatically to `frontend/.env` by `scripts/deploy.ts`:

- `VITE_SOMNIA_PLACE_ADDRESS`
- `VITE_SOMNIA_REACTOR_ADDRESS`
- `VITE_SOMNIA_CHAIN_ID`
- `VITE_SOMNIA_RPC_URL`
- `VITE_SOMNIA_WS_URL`
- `VITE_SOMNIA_EXPLORER_URL`
- `VITE_CANVAS_WIDTH`
- `VITE_CANVAS_HEIGHT`
- `VITE_PALETTE_SIZE`

For GitHub Pages builds, the workflow reads the same frontend values from repository-level GitHub Actions variables where applicable:

- `VITE_SOMNIA_PLACE_ADDRESS`
- `VITE_SOMNIA_REACTOR_ADDRESS`
- `VITE_CANVAS_WIDTH`
- `VITE_CANVAS_HEIGHT`
- `VITE_PALETTE_SIZE`

## Local Workflow

1. Install dependencies.

```bash
npm install
```

2. Add a root `.env` with at least `PRIVATE_KEY`.

3. Compile contracts.

```bash
npm run compile
```

4. Deploy to Shannon.

```bash
npm run deploy
```

5. Create the Reactivity subscription.

```bash
npm run setup:subscription
```

6. Optionally register structured Streams schemas for a future mirror/feed.

```bash
npm run setup:streams
```

7. Run the frontend.

```bash
npm run frontend:dev
```

## GitHub Pages

This repo now includes [deploy-pages.yml](/home/arch/place/.github/workflows/deploy-pages.yml), which deploys the Vite frontend to GitHub Pages from the `main` branch using the official GitHub Pages Actions flow.

Repository-specific notes:

- The repository is `kali113/placer`, so the Vite base path resolves to `/placer/` automatically during GitHub Actions builds.
- On GitHub, go to `Settings -> Pages` and set `Source` to `GitHub Actions`.
- Add these repository variables before relying on the hosted app:
  - `VITE_SOMNIA_PLACE_ADDRESS`
  - `VITE_SOMNIA_REACTOR_ADDRESS`
  - optionally `VITE_CANVAS_WIDTH`, `VITE_CANVAS_HEIGHT`, and `VITE_PALETTE_SIZE`
- Shannon public RPC, WebSocket, explorer, and chain ID defaults are already baked into the workflow.
- If you later move the frontend to a user-site repo like `kali113.github.io` or to a custom domain, override `VITE_BASE_PATH=/` for the Pages build instead of the repo-path default.

## Frontend Realtime Behavior

- Default path: the UI uses `@somnia-chain/streams` WebSocket subscriptions against canonical contract events. It subscribes to `PixelPlaced` from the canvas contract and a wildcard reactor stream for decay and score events.
- Optional path: `scripts/setupDataStream.ts` registers a pixel schema, a leaderboard schema, and a named Streams event schema for a structured mirror path. The base app does not depend on that mirror to function.

## Notes

- The frontend intentionally uses the user wallet for `placePixel()` writes. No private key is exposed in browser code.
- The reactor does not re-emit `PixelPlaced`, which avoids obvious subscription loops.
- The leaderboard is on-chain: reactor scores are stored on the reactor contract, while placement counters remain on the canvas contract.
- Hardhat is configured with Solidity `0.8.28` and `0.8.30`. The extra `0.8.30` compiler is necessary because the published `@somnia-chain/reactivity-contracts` package currently pins `SomniaEventHandler.sol` to `pragma solidity 0.8.30`.
- In this environment Hardhat builds successfully but warns that Node `25.7.0` is not an officially supported runtime. Prefer Node 22 LTS for a production setup.

## VERIFY AGAINST LATEST SOMNIA DOCS

- Shannon subscription funding: current subscription-management docs say `32+ STT` on testnet, while older Solidity tutorial text still says `32+ SOM`.
- Structured Streams publishing from Solidity: current docs and package inspection clearly show TypeScript `setAndEmitEvents()` and a Solidity proxy pattern using low-level `esstores()`, but not a verified Solidity-side `setAndEmitEvents()` example for the canvas contract itself.
- Cron rounds are not implemented in this base build. If you add timed resets/snapshots, re-verify the latest cron-subscription SDK version requirements before wiring scheduled rounds.
