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
  requirePrivateKey,
  somniaShannon
} from "./lib/somnia.js";

const subscriptionCreatedEvent = parseAbiItem(
  "event SubscriptionCreated(uint256 indexed subscriptionId, address indexed owner, (bytes32[4] eventTopics, address origin, address caller, address emitter, address handlerContractAddress, bytes4 handlerFunctionSelector, uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit, bool isGuaranteed, bool isCoalesced) subscriptionData)"
);

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
  const subscriptionData: SoliditySubscriptionData = {
    handlerContractAddress: deployment.reactor.address,
    emitter: deployment.canvas.address,
    eventTopics: [pixelPlacedTopic],
    priorityFeePerGas: parseGwei("2"),
    maxFeePerGas: parseGwei("10"),
    gasLimit: 500_000n,
    isGuaranteed: true,
    isCoalesced: false
  };

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
