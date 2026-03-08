Original prompt: Build SomniaPlace from the provided implementation brief, using verified Somnia docs for Reactivity, Streams, network config, and setup scripts; keep unresolved Somnia-specific gaps explicitly marked as VERIFY AGAINST LATEST SOMNIA DOCS instead of guessing.

2026-03-08
- Repo started nearly empty with only a placeholder README.
- Loaded the `develop-web-game` skill because this is a browser-based collaborative game with a required test loop.
- Confirmed the current official Reactivity subscription-management docs say on-chain subscriptions require 32+ STT on testnet, while the older Solidity Reactivity tutorial still mentions 32+ SOM. Code/README should use 32+ STT and call out the mismatch as a verification item.
- Need to keep Path A (Streams subscribe to contract events) as the default realtime path because docs clearly show that flow; contract-side structured Streams publishing remains a documented VERIFY item unless package inspection reveals a stable Solidity interface.
- Added a full Hardhat + TypeScript scaffold, React/Vite frontend workspace, and shared deployment manifest flow.
- Implemented `SomniaPlace.sol` with packed pixel storage, cooldowns, participant tracking, canvas hydration helpers, and `onlyReactor` mutation hooks.
- Implemented `SomniaPlaceReactor.sol` on top of the published `SomniaEventHandler` package with bounded local cluster scoring, overwrite penalties, pattern rewards, and opportunistic decay.
- Implemented viem-based deploy/setup scripts and a Shannon deployment manifest that also writes frontend env values.
- Verified the published npm package surfaces directly:
  - `@somnia-chain/reactivity` currently peers on `viem ~2.37.8`.
  - `@somnia-chain/reactivity-contracts@0.1.6` pins `SomniaEventHandler.sol` to `pragma solidity 0.8.30`, so the Hardhat config now includes both `0.8.28` and `0.8.30`.
  - `@somnia-chain/streams` subscribes with `eventContractSources`, not singular `eventContractSource`.
- Browser validation loop:
  - `npm run build` passes.
  - `npx tsc -p tsconfig.json` passes.
  - Playwright screenshot + `render_game_to_text` pass completed against the dev server with no fresh console/page errors after adding a browser `Buffer` polyfill bootstrap for the Streams SDK.
- Remaining TODOs for a real Shannon demo:
  - Run `scripts/deploy.ts` with funded Shannon credentials.
  - Run `scripts/setupSubscription.ts` and confirm the emitted `subscriptionId` on-chain.
  - Optionally wire a true structured mirror publisher if Somnia publishes a verified Solidity store+emit interface beyond the current `esstores()` proxy pattern.
- Added GitHub Pages support for the `kali113/placer` repo:
  - Vite now computes a repo-site base path automatically during GitHub Actions builds and still defaults to `/` locally.
  - Added `.github/workflows/deploy-pages.yml` using the official Pages Actions flow and repository variables for build-time contract addresses.
  - Updated README with Pages setup steps and the required repository variables.
- Important gotcha resolved: stale generated `frontend/vite.config.js` / `.d.ts` files were shadowing `vite.config.ts`, which would have broken repo-path base handling. Those generated config artifacts were removed.
