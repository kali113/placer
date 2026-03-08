import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http
} from "viem";

import { readArtifact } from "./lib/artifacts.js";
import { upsertDeployment, writeFrontendEnv } from "./lib/deployments.js";
import { envNumber, requirePrivateKey, SHANNON_RPC_URL, somniaShannon } from "./lib/somnia.js";

async function main(): Promise<void> {
  const privateKey = requirePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: somniaShannon,
    transport: http(SHANNON_RPC_URL)
  });
  const walletClient = createWalletClient({
    account,
    chain: somniaShannon,
    transport: http(SHANNON_RPC_URL)
  });

  const canvasWidth = envNumber("CANVAS_WIDTH", 100);
  const canvasHeight = envNumber("CANVAS_HEIGHT", 100);
  const paletteSize = envNumber("PALETTE_SIZE", 16);

  const [canvasArtifact, reactorArtifact, balance] = await Promise.all([
    readArtifact("contracts/SomniaPlace.sol", "SomniaPlace"),
    readArtifact("contracts/SomniaPlaceReactor.sol", "SomniaPlaceReactor"),
    publicClient.getBalance({ address: account.address })
  ]);

  console.log(`Deploying with ${account.address}`);
  console.log(`RPC: ${SHANNON_RPC_URL}`);
  console.log(`Balance: ${formatEther(balance)} STT`);

  const canvasHash = await walletClient.deployContract({
    abi: canvasArtifact.abi,
    bytecode: canvasArtifact.bytecode,
    args: [canvasWidth, canvasHeight, paletteSize]
  });
  const canvasReceipt = await publicClient.waitForTransactionReceipt({ hash: canvasHash });
  const canvasAddress = canvasReceipt.contractAddress;

  if (!canvasAddress) {
    throw new Error("Canvas deployment did not return a contract address");
  }

  const reactorHash = await walletClient.deployContract({
    abi: reactorArtifact.abi,
    bytecode: reactorArtifact.bytecode,
    args: [canvasAddress]
  });
  const reactorReceipt = await publicClient.waitForTransactionReceipt({ hash: reactorHash });
  const reactorAddress = reactorReceipt.contractAddress;

  if (!reactorAddress) {
    throw new Error("Reactor deployment did not return a contract address");
  }

  const setReactorHash = await walletClient.writeContract({
    address: canvasAddress,
    abi: canvasArtifact.abi,
    functionName: "setReactor",
    args: [reactorAddress]
  });
  await publicClient.waitForTransactionReceipt({ hash: setReactorHash });

  const deployment = await upsertDeployment((current) => ({
    ...current,
    canvas: {
      address: getAddress(canvasAddress),
      width: canvasWidth,
      height: canvasHeight,
      paletteSize
    },
    reactor: {
      address: getAddress(reactorAddress)
    }
  }));

  await writeFrontendEnv(deployment);

  console.log("SomniaPlace deployed:");
  console.log(`  canvas:  ${deployment.canvas?.address}`);
  console.log(`  reactor: ${deployment.reactor?.address}`);
  console.log("Wrote deployment manifest to deployments/shannon.json");
  console.log("Wrote frontend env file to frontend/.env");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

