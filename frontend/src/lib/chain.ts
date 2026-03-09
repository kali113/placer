import { defineChain } from "viem";
import { somniaTestnet } from "viem/chains";

export const somniaRpcUrl = "https://dream-rpc.somnia.network";
export const somniaWsUrl = "wss://dream-rpc.somnia.network/ws";
export const somniaExplorerUrl = "https://shannon.somnia.network";

export const somniaShannon = defineChain({
  ...somniaTestnet,
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

export const somniaChainId = 50312;

