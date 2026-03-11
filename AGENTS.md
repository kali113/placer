# Agent Guide

Use this file as the repo-wide onboarding context. Keep it short, broadly applicable, and point to source files for task-specific detail.

## Why

SomniaPlace is a fully on-chain collaborative pixel canvas for the Somnia Shannon testnet. Pixel placement, scoring, anti-griefing penalties, and decay are driven by Somnia Reactivity.

## What

- `contracts/`: Solidity contracts for the canvas and the reactor.
- `scripts/`: deployment and subscription setup scripts plus shared script utilities.
- `deployments/`: deployed-address manifests.
- `frontend/`: Vite/React client that renders the board and subscribes to live events.
- `README.md`: primary product, architecture, and network overview.

## How

- Root package manager: `npm`
- Contract compile: `npm run compile`
- Full build: `npm run build`
- Frontend dev server: `npm run frontend:dev`
- Frontend production build/typecheck: `npm run frontend:build`
- Deploy contracts: `npm run deploy`
- Create the on-chain Reactivity subscription: `npm run setup:subscription`

There is no dedicated test suite checked in right now. For most code changes, verify with the narrowest relevant build command plus any directly impacted runtime flow.

## Progressive Disclosure

Read only what matches the task:

- Product and architecture: `README.md`
- Contract changes: `contracts/SomniaPlace.sol`, `contracts/SomniaPlaceReactor.sol`, `hardhat.config.ts`
- Deployment or subscription work: `scripts/deploy.ts`, `scripts/setupSubscription.ts`, `scripts/lib/`
- Frontend changes: `frontend/src/App.tsx`, `frontend/src/lib/`, `frontend/package.json`
- Current deployed values: `deployments/shannon.json`

Prefer existing code patterns over adding style rules here. Use project commands to validate changes instead of treating the agent guide as a linter or formatter policy file.
