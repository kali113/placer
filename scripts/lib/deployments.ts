import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";

import {
  SHANNON_CHAIN_ID,
  SHANNON_EXPLORER_URL,
  SHANNON_RPC_URL,
  SHANNON_WS_URL
} from "./somnia.js";

export interface DeploymentFile {
  network: {
    name: "somnia-shannon";
    chainId: number;
    rpcUrl: string;
    wsUrl: string;
    explorerUrl: string;
  };
  canvas?: {
    address: Address;
    width: number;
    height: number;
    paletteSize: number;
  };
  reactor?: {
    address: Address;
  };
  reactivity?: {
    pixelPlacedTopic: Hex;
    subscriptionId?: string;
    subscriptionTxHash?: Hex;
  };
  dataStreams?: {
    protocolAddress?: Address;
    pixelSchemaId?: Hex;
    leaderboardSchemaId?: Hex;
    pixelEventId?: string;
    notes?: string[];
  };
}

const defaultDeployment = (): DeploymentFile => ({
  network: {
    name: "somnia-shannon",
    chainId: SHANNON_CHAIN_ID,
    rpcUrl: SHANNON_RPC_URL,
    wsUrl: SHANNON_WS_URL,
    explorerUrl: SHANNON_EXPLORER_URL
  }
});

export const deploymentPath = join(process.cwd(), "deployments", "shannon.json");
const frontendEnvPath = join(process.cwd(), "frontend", ".env");

export async function readDeployment(): Promise<DeploymentFile> {
  try {
    const raw = await readFile(deploymentPath, "utf8");
    return JSON.parse(raw) as DeploymentFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultDeployment();
    }
    throw error;
  }
}

export async function writeDeployment(next: DeploymentFile): Promise<void> {
  await mkdir(join(process.cwd(), "deployments"), { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function upsertDeployment(
  updater: (current: DeploymentFile) => DeploymentFile
): Promise<DeploymentFile> {
  const current = await readDeployment();
  const next = updater(current);
  await writeDeployment(next);
  return next;
}

export async function writeFrontendEnv(deployment: DeploymentFile): Promise<void> {
  if (!deployment.canvas || !deployment.reactor) {
    return;
  }

  const lines = [
    `VITE_SOMNIA_CHAIN_ID=${deployment.network.chainId}`,
    `VITE_SOMNIA_RPC_URL=${deployment.network.rpcUrl}`,
    `VITE_SOMNIA_WS_URL=${deployment.network.wsUrl}`,
    `VITE_SOMNIA_EXPLORER_URL=${deployment.network.explorerUrl}`,
    `VITE_SOMNIA_PLACE_ADDRESS=${deployment.canvas.address}`,
    `VITE_SOMNIA_REACTOR_ADDRESS=${deployment.reactor.address}`,
    `VITE_CANVAS_WIDTH=${deployment.canvas.width}`,
    `VITE_CANVAS_HEIGHT=${deployment.canvas.height}`,
    `VITE_PALETTE_SIZE=${deployment.canvas.paletteSize}`
  ];

  await mkdir(join(process.cwd(), "frontend"), { recursive: true });
  await writeFile(frontendEnvPath, `${lines.join("\n")}\n`, "utf8");
}

