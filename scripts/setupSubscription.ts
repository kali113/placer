import {
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
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

import { readDeployment, upsertDeployment } from "./lib/deployments.js";
import {
  REACTIVITY_PRECOMPILE_ADDRESS,
  SHANNON_RPC_URL,
  envNumber,
  requirePrivateKey,
  somniaShannon
} from "./lib/somnia.js";

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
  if (!deployment.canvas?.address || !deployment.reactor?.address) {
    throw new Error("Missing deployed canvas or reactor address. Run scripts/deploy.ts first.");
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

  const pixelPlacedTopic = keccak256(toBytes("PixelPlaced(address,uint16,uint16,uint8,uint256)"));
  const priorityFeePerGas = envGwei("REACTIVITY_PRIORITY_FEE_GWEI", defaultPriorityFeeGwei);
  const maxFeePerGas = envGwei("REACTIVITY_MAX_FEE_GWEI", defaultMaxFeeGwei);
  const gasLimit = BigInt(envNumber("REACTIVITY_GAS_LIMIT", Number(defaultSubscriptionGasLimit)));
  const subscriptionData: SoliditySubscriptionData = {
    handlerContractAddress: deployment.reactor.address,
    emitter: deployment.canvas.address,
    eventTopics: [pixelPlacedTopic],
    priorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    isGuaranteed: true,
    isCoalesced: false
  };

  const existingSubscriptionId = deployment.reactivity?.subscriptionId
    ? BigInt(deployment.reactivity.subscriptionId)
    : undefined;

  if (existingSubscriptionId !== undefined) {
    const existingInfo = await sdk.getSubscriptionInfo(existingSubscriptionId);
    if (!(existingInfo instanceof Error)) {
      if (existingInfo.owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(
          `Subscription ${existingSubscriptionId.toString()} is owned by ${existingInfo.owner}, not ${account.address}.`
        );
      }

      if (sameSubscriptionConfig(existingInfo.subscriptionData, subscriptionData)) {
        console.log("Existing subscription already matches requested configuration.");
        console.log(`  subscriptionId:  ${existingSubscriptionId.toString()}`);
        console.log(`  emitter:         ${deployment.canvas.address}`);
        console.log(`  handler:         ${deployment.reactor.address}`);
        console.log(`  topic:           ${pixelPlacedTopic}`);
        console.log(`  gasLimit:        ${gasLimit.toString()}`);
        console.log(`  priorityFee:     ${priorityFeePerGas.toString()}`);
        console.log(`  maxFee:          ${maxFeePerGas.toString()}`);
        return;
      }

      console.log(
        `Replacing subscription ${existingSubscriptionId.toString()} to apply updated callback gas/fee settings.`
      );

      const cancelHash = await sdk.cancelSoliditySubscription(existingSubscriptionId);
      if (cancelHash instanceof Error) {
        throw cancelHash;
      }

      const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
      console.log(`  cancelled with tx: ${cancelHash}`);
      console.log(`  cancel status:     ${cancelReceipt.status}`);
    }
  }

  const txHash = await sdk.createSoliditySubscription(subscriptionData);
  if (txHash instanceof Error) {
    throw txHash;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  let subscriptionId: bigint | undefined;

  for (const log of receipt.logs) {
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

  if (!subscriptionId) {
    const maybeListMethod = (sdk as ReactivitySDK & {
      getAllSoliditySubscriptionsForOwner?: (
        owner: Address
      ) => Promise<Array<{ subscriptionId?: bigint; owner?: string; subscriptionData?: SoliditySubscriptionData }>>;
    }).getAllSoliditySubscriptionsForOwner;

    if (typeof maybeListMethod === "function") {
      const subscriptions = await maybeListMethod(account.address);
      const matched = subscriptions.find((candidate) => {
        if (!candidate?.subscriptionData) {
          return false;
        }

        return (
          candidate.subscriptionData.handlerContractAddress.toLowerCase() ===
            deployment.reactor!.address.toLowerCase() &&
          candidate.subscriptionData.emitter?.toLowerCase() === deployment.canvas!.address.toLowerCase()
        );
      });

      subscriptionId = matched?.subscriptionId;
    }
  }

  const nextDeployment = await upsertDeployment((current) => ({
    ...current,
    reactivity: {
      pixelPlacedTopic,
      subscriptionId: subscriptionId?.toString(),
      subscriptionTxHash: txHash
    }
  }));

  console.log("Subscription created:");
  console.log(`  txHash:          ${txHash}`);
  console.log(`  receipt status:  ${receipt.status}`);
  console.log(`  subscriptionId:  ${subscriptionId?.toString() ?? "not parsed from receipt"}`);
  console.log(`  emitter:         ${deployment.canvas.address}`);
  console.log(`  handler:         ${deployment.reactor.address}`);
  console.log(`  topic:           ${pixelPlacedTopic}`);
  console.log(`  gasLimit:        ${gasLimit.toString()}`);
  console.log(`  priorityFee:     ${priorityFeePerGas.toString()}`);
  console.log(`  maxFee:          ${maxFeePerGas.toString()}`);

  if (subscriptionId) {
    const subscriptionInfo = await sdk.getSubscriptionInfo(subscriptionId);
    console.log("  on-chain info:", subscriptionInfo);
  } else {
    console.log(
      "  note: receipt log parsing failed and this SDK build does not expose a verified owner-listing fallback. VERIFY AGAINST LATEST SOMNIA DOCS."
    );
  }

  console.log(
    "Funding note: current subscription-management docs say Shannon subscriptions require 32+ STT, while older tutorial text still says 32+ SOM. VERIFY AGAINST LATEST SOMNIA DOCS BEFORE MAINNET OR FINAL DEMO."
  );
  console.log(`Updated deployment manifest: ${nextDeployment.reactivity?.subscriptionId ?? "pending manual verification"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
