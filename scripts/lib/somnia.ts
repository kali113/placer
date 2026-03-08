import { config as loadEnv } from "dotenv";
import { defineChain, type Address, type Hex } from "viem";
import { somniaTestnet } from "viem/chains";

loadEnv();

export const SHANNON_CHAIN_ID = 50312;
export const SHANNON_RPC_URL =
  process.env.SOMNIA_RPC_URL ?? somniaTestnet.rpcUrls.default.http[0] ?? "https://dream-rpc.somnia.network";
export const SHANNON_WS_URL = process.env.SOMNIA_WS_URL ?? "wss://dream-rpc.somnia.network/ws";
export const SHANNON_EXPLORER_URL = "https://shannon-explorer.somnia.network";
export const REACTIVITY_PRECOMPILE_ADDRESS =
  "0x0000000000000000000000000000000000000100" as Address;

export const somniaShannon = defineChain({
  ...somniaTestnet,
  rpcUrls: {
    default: {
      http: [SHANNON_RPC_URL],
      webSocket: [SHANNON_WS_URL]
    },
    public: {
      http: [SHANNON_RPC_URL],
      webSocket: [SHANNON_WS_URL]
    }
  }
});

export function requirePrivateKey(): Hex {
  const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    throw new Error("Missing PRIVATE_KEY in environment");
  }
  return privateKey;
}

export function envNumber(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected ${name} to be numeric, received ${rawValue}`);
  }

  return parsed;
}

