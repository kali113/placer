import { createPublicClient, http, webSocket } from "viem";
import { SDK as StreamsSDK } from "@somnia-chain/streams";

import { somniaRpcUrl, somniaShannon, somniaWsUrl } from "./chain";

export const readClient = createPublicClient({
  chain: somniaShannon,
  transport: http(somniaRpcUrl)
});

export const streamClient = createPublicClient({
  chain: somniaShannon,
  transport: webSocket(somniaWsUrl)
});

export const streamsSdk = new StreamsSDK({
  public: streamClient
});

