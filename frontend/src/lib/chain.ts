import { defineChain } from "viem";
import { somniaTestnet } from "viem/chains";

import {
  somniaChainId,
  somniaExplorerUrl,
  somniaRpcUrl,
  somniaWsUrl
} from "./config";

export { somniaChainId, somniaExplorerUrl, somniaRpcUrl, somniaWsUrl };

export const somniaShannon = defineChain({
  ...somniaTestnet,
  id: somniaChainId,
  rpcUrls: {
    default: {
      http: [somniaRpcUrl],
      webSocket: [somniaWsUrl]
    },
    public: {
      http: [somniaRpcUrl],
      webSocket: [somniaWsUrl]
    }
  }
});
