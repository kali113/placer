import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { SDK as StreamsSDK } from "@somnia-chain/streams";

import { upsertDeployment } from "./lib/deployments.js";
import { SHANNON_RPC_URL, requirePrivateKey, somniaShannon } from "./lib/somnia.js";

const pixelSchema = "uint16 x,uint16 y,uint8 color,address placer,uint64 timestamp";
const leaderboardSchema = "address player,uint256 score,uint256 placements";
const pixelEventId = "somnia-place.pixel.placed.v1";

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

  const sdk = new StreamsSDK({
    public: publicClient,
    wallet: walletClient
  });
  const streams = sdk.streams;

  const [protocolInfo, pixelSchemaId, leaderboardSchemaId, existingEventSchemas] = await Promise.all([
    streams.getSomniaDataStreamsProtocolInfo(),
    streams.computeSchemaId(pixelSchema),
    streams.computeSchemaId(leaderboardSchema),
    streams.getEventSchemasById([pixelEventId])
  ]);

  if (pixelSchemaId instanceof Error) {
    throw pixelSchemaId;
  }
  if (leaderboardSchemaId instanceof Error) {
    throw leaderboardSchemaId;
  }
  if (protocolInfo instanceof Error) {
    throw protocolInfo;
  }
  if (existingEventSchemas instanceof Error) {
    throw existingEventSchemas;
  }

  const registerSchemasTx = await streams.registerDataSchemas(
    [
      {
        schemaName: "somniaPlacePixel",
        schema: pixelSchema
      },
      {
        schemaName: "somniaPlaceLeaderboard",
        schema: leaderboardSchema
      }
    ],
    true
  );
  if (registerSchemasTx instanceof Error) {
    throw registerSchemasTx;
  }
  await publicClient.waitForTransactionReceipt({ hash: registerSchemasTx });

  if (existingEventSchemas.length === 0) {
    const registerEventTx = await streams.registerEventSchemas([
      {
        id: pixelEventId,
        schema: {
          eventTopic: "PixelPlacedStream(address,uint16,uint16,uint8,uint64)",
          params: [
            {
              name: "placer",
              paramType: "address",
              isIndexed: true
            },
            {
              name: "x",
              paramType: "uint16",
              isIndexed: false
            },
            {
              name: "y",
              paramType: "uint16",
              isIndexed: false
            },
            {
              name: "color",
              paramType: "uint8",
              isIndexed: false
            },
            {
              name: "timestamp",
              paramType: "uint64",
              isIndexed: false
            }
          ]
        }
      }
    ]);

    if (registerEventTx instanceof Error) {
      throw registerEventTx;
    }

    await publicClient.waitForTransactionReceipt({ hash: registerEventTx });
  }

  const nextDeployment = await upsertDeployment((current) => ({
    ...current,
    dataStreams: {
      protocolAddress: getAddress(protocolInfo.address as Address),
      pixelSchemaId,
      leaderboardSchemaId,
      pixelEventId,
      notes: [
        "Default UI path uses Streams subscribe() against canonical contract events, not this optional structured mirror.",
        "Structured mirror registration is in place, but Solidity-side atomic store+emit flow remains VERIFY AGAINST LATEST SOMNIA DOCS because current docs show TypeScript setAndEmitEvents() and a Solidity esstores() proxy pattern, not a verified Solidity setAndEmitEvents() example."
      ]
    }
  }));

  console.log("Somnia Data Streams setup complete:");
  console.log(`  protocol address:      ${protocolInfo.address}`);
  console.log(`  pixel schema id:       ${pixelSchemaId}`);
  console.log(`  leaderboard schema id: ${leaderboardSchemaId}`);
  console.log(`  event schema id:       ${pixelEventId}`);
  console.log(`  deployment manifest:   ${nextDeployment.dataStreams?.protocolAddress}`);
  console.log(
    "Default frontend path remains direct PixelPlaced subscription over WebSocket. Structured mirror publication is intentionally left as an opt-in extension point until the Solidity publisher path is re-verified."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
