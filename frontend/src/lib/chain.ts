import { defineChain } from "viem";
import { somniaTestnet } from "viem/chains";

export const somniaRpcUrl =
  import.meta.env.VITE_SOMNIA_RPC_URL ??
  somniaTestnet.rpcUrls.default.http[0] ??
  "https://dream-rpc.somnia.network";
export const somniaWsUrl = import.meta.env.VITE_SOMNIA_WS_URL ?? "wss://dream-rpc.somnia.network/ws";
export const somniaExplorerUrl =
  import.meta.env.VITE_SOMNIA_EXPLORER_URL ??
  somniaTestnet.blockExplorers?.default.url ??
  "https://shannon-explorer.somnia.network";

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

export const somniaChainId = Number(import.meta.env.VITE_SOMNIA_CHAIN_ID ?? somniaShannon.id);

