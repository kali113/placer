/**
 * Schedule an on-chain cron job using Somnia Reactivity.
 *
 * This triggers the Reactor's `_onEvent` handler at a future timestamp,
 * enabling hourly canvas snapshot / round transitions without manual
 * intervention or off-chain cron infrastructure.
 *
 * Usage:
 *   tsx scripts/scheduleCronRound.ts            # default: 1 hour from now
 *   tsx scripts/scheduleCronRound.ts --delay 30 # 30 minutes from now
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  SDK as ReactivitySDK,
} from "@somnia-chain/reactivity";

import { readDeployment } from "./lib/deployments.js";
import { SHANNON_RPC_URL, requirePrivateKey, somniaShannon } from "./lib/somnia.js";

async function main(): Promise<void> {
  const deployment = await readDeployment();
  if (!deployment.reactor?.address) {
    throw new Error("Missing deployed reactor address. Run scripts/deploy.ts first.");
  }

  // Parse --delay <minutes> from args (default 60)
  let delayMinutes = 60;
  const delayIdx = process.argv.indexOf("--delay");
  if (delayIdx !== -1 && process.argv[delayIdx + 1]) {
    delayMinutes = Number(process.argv[delayIdx + 1]);
    if (!Number.isFinite(delayMinutes) || delayMinutes < 1) {
      throw new Error("--delay must be a positive number of minutes");
    }
  }

  const privateKey = requirePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: somniaShannon,
    transport: http(SHANNON_RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: somniaShannon,
    transport: http(SHANNON_RPC_URL),
  });
  const sdk = new ReactivitySDK({
    public: publicClient,
    wallet: walletClient,
  });

  const targetTimestampMs = Date.now() + delayMinutes * 60 * 1000;

  console.log(`Scheduling on-chain cron job:`);
  console.log(`  handler:   ${deployment.reactor.address}`);
  console.log(`  delay:     ${delayMinutes} minutes`);
  console.log(`  target:    ${new Date(targetTimestampMs).toISOString()}`);

  const txHash = await sdk.scheduleOnchainCronJob({
    timestampMs: targetTimestampMs,
    handlerContractAddress: deployment.reactor.address,
    priorityFeePerGas: parseGwei("2"),
    maxFeePerGas: parseGwei("10"),
    gasLimit: 500_000n,
    isGuaranteed: true,
    isCoalesced: false,
  });

  if (txHash instanceof Error) {
    throw txHash;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log(`Cron job scheduled:`);
  console.log(`  txHash:  ${txHash}`);
  console.log(`  status:  ${receipt.status}`);
  console.log(`  fires:   ${new Date(targetTimestampMs).toISOString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
