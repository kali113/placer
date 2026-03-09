import { createPublicClient, http, webSocket } from "viem";
import { SDK as ReactivitySDK } from "@somnia-chain/reactivity";

import { somniaRpcUrl, somniaShannon, somniaWsUrl } from "./chain";

/** HTTP client for read-only contract calls. */
export const readClient = createPublicClient({
  chain: somniaShannon,
  transport: http(somniaRpcUrl)
});

/** WebSocket client used internally by the Reactivity SDK for live subscriptions. */
const wsClient = createPublicClient({
  chain: somniaShannon,
  transport: webSocket(somniaWsUrl)
});

/**
 * Somnia Reactivity SDK instance.
 *
 * Off-chain mode: `reactivitySdk.subscribe()` opens a WebSocket subscription
 * that pushes contract events to the browser in real-time — powered by the
 * same Reactivity layer that triggers on-chain handler contracts.
 */
export const reactivitySdk = new ReactivitySDK({
  public: wsClient
});
