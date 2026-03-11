import {
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseGwei,
  toBytes,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  SDK as ReactivitySDK,
  type SoliditySubscriptionData
} from "@somnia-chain/reactivity";

import { readArtifact } from "./lib/artifacts.js";
import { readDeployment, upsertDeployment, writeFrontendEnv } from "./lib/deployments.js";
import {
  REACTIVITY_PRECOMPILE_ADDRESS,
  SHANNON_RPC_URL,
  envNumber,
  requirePrivateKey,
  somniaShannon
} from "./lib/somnia.js";

const canvasAdminAbi = parseAbi([
  "function setReactor(address newReactor) external"
]);

const subscriptionCreatedEvent = parseAbiItem(
  "event SubscriptionCreated(uint256 indexed subscriptionId, address indexed owner, (bytes32[4] eventTopics, address origin, address caller, address emitter, address handlerContractAddress, bytes4 handlerFunctionSelector, uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit, bool isGuaranteed, bool isCoalesced) subscriptionData)"
);

const defaultPriorityFeeGwei = "2";
const defaultMaxFeeGwei = "20";
const defaultSubscriptionGasLimit = 5_000_000n;
const zeroTopic = `0x${"0".repeat(64)}` as Hex;

function envGwei(name: string, fallback: string): bigint {
  return parseGwei(process.env[name] ?? fallback);
}

function normalizeTopics(topics: readonly Hex[] | undefined): string[] {
  const normalized = (topics ?? []).map((topic) => topic.toLowerCase());
  while (normalized.length > 0 && normalized[normalized.length - 1] === zeroTopic) {
    normalized.pop();
  }
  return normalized;
}

function sameTopics(left: readonly Hex[] | undefined, right: readonly Hex[]): boolean {
  const normalizedLeft = normalizeTopics(left);
  const normalizedRight = normalizeTopics(right);

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedRight.every((topic, index) => normalizedLeft[index] === topic);
}

function sameSubscriptionConfig(
  current: SoliditySubscriptionData,
  expected: SoliditySubscriptionData
): boolean {
  return (
    sameTopics(current.eventTopics, expected.eventTopics ?? []) &&
    (current.origin ?? "0x0000000000000000000000000000000000000000").toLowerCase() ===
      (expected.origin ?? "0x0000000000000000000000000000000000000000").toLowerCase() &&
    (current.caller ?? "0x0000000000000000000000000000000000000000").toLowerCase() ===
      (expected.caller ?? "0x0000000000000000000000000000000000000000").toLowerCase() &&
    (current.emitter ?? "0x0000000000000000000000000000000000000000").toLowerCase() ===
      (expected.emitter ?? "0x0000000000000000000000000000000000000000").toLowerCase() &&
    current.handlerContractAddress.toLowerCase() === expected.handlerContractAddress.toLowerCase() &&
    (current.handlerFunctionSelector ?? "0x53edf33d").toLowerCase() ===
      (expected.handlerFunctionSelector ?? "0x53edf33d").toLowerCase() &&
    current.priorityFeePerGas === expected.priorityFeePerGas &&
    current.maxFeePerGas === expected.maxFeePerGas &&
    current.gasLimit === expected.gasLimit &&
    current.isGuaranteed === expected.isGuaranteed &&
    current.isCoalesced === expected.isCoalesced
  );
}

async function main(): Promise<void> {
  const deployment = await readDeployment();
  if (!deployment.canvas?.address) {
    throw new Error("Missing deployed canvas address. Run scripts/deploy.ts first.");
  }

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
  const sdk = new ReactivitySDK({
    public: publicClient,
    wallet: walletClient
  });

  const reactorArtifact = await readArtifact("contracts/SomniaPlaceReactor.sol", "SomniaPlaceReactor");

  console.log(`Deploying upgraded reactor with ${account.address}`);
  console.log(`Canvas: ${deployment.canvas.address}`);

  const deployHash = await walletClient.deployContract({
    abi: reactorArtifact.abi,
    bytecode: reactorArtifact.bytecode,
    args: [deployment.canvas.address]
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const reactorAddress = deployReceipt.contractAddress;

  if (!reactorAddress) {
    throw new Error("Reactor deployment did not return a contract address");
  }

  const normalizedReactorAddress = getAddress(reactorAddress);

  console.log(`Reactor deployed: ${normalizedReactorAddress}`);
  console.log(`Deploy tx:        ${deployHash}`);

  const setReactorHash = await walletClient.writeContract({
    address: deployment.canvas.address,
    abi: canvasAdminAbi,
    functionName: "setReactor",
    args: [normalizedReactorAddress]
  });
  const setReactorReceipt = await publicClient.waitForTransactionReceipt({ hash: setReactorHash });

  console.log(`Canvas updated:   ${setReactorHash}`);
  console.log(`Set status:       ${setReactorReceipt.status}`);

  const nextDeployment = await upsertDeployment((current) => ({
    ...current,
    reactor: {
      address: normalizedReactorAddress
    }
  }));
  await writeFrontendEnv(nextDeployment);

  const pixelPlacedTopic = keccak256(toBytes("PixelPlaced(address,uint16,uint16,uint8,uint256)"));
  const priorityFeePerGas = envGwei("REACTIVITY_PRIORITY_FEE_GWEI", defaultPriorityFeeGwei);
  const maxFeePerGas = envGwei("REACTIVITY_MAX_FEE_GWEI", defaultMaxFeeGwei);
  const gasLimit = BigInt(envNumber("REACTIVITY_GAS_LIMIT", Number(defaultSubscriptionGasLimit)));
  const subscriptionData: SoliditySubscriptionData = {
    handlerContractAddress: normalizedReactorAddress,
    emitter: deployment.canvas.address,
    eventTopics: [pixelPlacedTopic],
    priorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    isGuaranteed: true,
    isCoalesced: false
  };

  const existingSubscriptionId = nextDeployment.reactivity?.subscriptionId
    ? BigInt(nextDeployment.reactivity.subscriptionId)
    : undefined;

  if (existingSubscriptionId !== undefined) {
    const existingInfo = await sdk.getSubscriptionInfo(existingSubscriptionId);
    if (!(existingInfo instanceof Error)) {
      if (existingInfo.owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(
          `Subscription ${existingSubscriptionId.toString()} is owned by ${existingInfo.owner}, not ${account.address}.`
        );
      }

      if (!sameSubscriptionConfig(existingInfo.subscriptionData, subscriptionData)) {
        console.log(`Replacing prior subscription ${existingSubscriptionId.toString()}`);
        const cancelHash = await sdk.cancelSoliditySubscription(existingSubscriptionId);
        if (cancelHash instanceof Error) {
          throw cancelHash;
        }
        const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
        console.log(`Cancelled tx:     ${cancelHash}`);
        console.log(`Cancel status:    ${cancelReceipt.status}`);
      } else {
        console.log(
          `Existing subscription ${existingSubscriptionId.toString()} already matches new reactor and gas settings.`
        );
      }
    }
  }

  const subscribeHash = await sdk.createSoliditySubscription(subscriptionData);
  if (subscribeHash instanceof Error) {
    throw subscribeHash;
  }

  const subscribeReceipt = await publicClient.waitForTransactionReceipt({ hash: subscribeHash });
  let subscriptionId: bigint | undefined;

  for (const log of subscribeReceipt.logs) {
    if (getAddress(log.address) !== REACTIVITY_PRECOMPILE_ADDRESS) {
      continue;
    }
    if (log.topics.length === 0) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: [subscriptionCreatedEvent],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]]
      });

      if (decoded.eventName === "SubscriptionCreated") {
        subscriptionId = decoded.args.subscriptionId;
        break;
      }
    } catch {
      continue;
    }
  }

  const finalDeployment = await upsertDeployment((current) => ({
    ...current,
    reactor: {
      address: normalizedReactorAddress
    },
    reactivity: {
      pixelPlacedTopic,
      subscriptionId: subscriptionId?.toString(),
      subscriptionTxHash: subscribeHash
    }
  }));
  await writeFrontendEnv(finalDeployment);

  console.log("Upgraded Shannon deployment:");
  console.log(`  reactor:         ${normalizedReactorAddress}`);
  console.log(`  subscriptionId:  ${subscriptionId?.toString() ?? "not parsed from receipt"}`);
  console.log(`  subscriptionTx:  ${subscribeHash}`);
  console.log(`  gasLimit:        ${gasLimit.toString()}`);
  console.log(`  priorityFee:     ${priorityFeePerGas.toString()}`);
  console.log(`  maxFee:          ${maxFeePerGas.toString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
