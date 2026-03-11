import { useEffect, useRef, useCallback } from "react";
import { decodeEventLog, getAddress, type Address } from "viem";
import { readClient, reactivitySdk } from "../lib/clients";
import { canvasAddress, reactorAddress } from "../lib/config";
import { somniaPlaceAbi, somniaPlaceReactorAbi, pixelPlacedTopic } from "../lib/contracts";
const RECENT_ACTIVITY_LIMIT = 30;
const ACTIVITY_BLOCK_WINDOW = 1_000n;
const ACTIVITY_LOOKBACK_LIMIT = 25_000n;

export interface FeedEntry {
  id: number;
  timestamp: number;
  kind: "pixel" | "territory" | "pattern" | "penalty" | "decay";
  message: string;
}

export type FeedLoadState = "loading" | "ready" | "empty" | "error";

interface HistoricalActivityLog {
  address: Address;
  data: `0x${string}`;
  topics: readonly `0x${string}`[];
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function toMilliseconds(timestamp: bigint | number): number {
  return Number(timestamp) * 1000;
}

function isHistoricalActivityLog(
  log: {
    address: Address;
    data: `0x${string}`;
    topics: readonly `0x${string}`[];
    blockNumber: bigint | null;
    transactionIndex: number | null;
    logIndex: number | null;
  }
): log is HistoricalActivityLog {
  return (
    log.blockNumber !== null &&
    log.transactionIndex !== null &&
    log.logIndex !== null
  );
}

function compareHistoricalLogs(a: HistoricalActivityLog, b: HistoricalActivityLog): number {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber > b.blockNumber ? -1 : 1;
  }

  if (a.transactionIndex !== b.transactionIndex) {
    return a.transactionIndex > b.transactionIndex ? -1 : 1;
  }

  if (a.logIndex !== b.logIndex) {
    return a.logIndex > b.logIndex ? -1 : 1;
  }

  return 0;
}

function decodeHistoricalFeedEntry(
  log: HistoricalActivityLog,
  blockTimestamp: number
): Omit<FeedEntry, "id"> | null {
  try {
    if (log.address.toLowerCase() === canvasAddress.toLowerCase()) {
      const decoded = decodeEventLog({
        abi: somniaPlaceAbi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]]
      });

      if (decoded.eventName !== "PixelPlaced") {
        return null;
      }

      const placer = getAddress(decoded.args.placer as Address);
      const x = Number(decoded.args.x);
      const y = Number(decoded.args.y);
      const color = Number(decoded.args.color);

      return {
        kind: "pixel",
        timestamp: toMilliseconds(decoded.args.timestamp),
        message: `${shortAddress(placer)} placed pixel at [${x},${y}] color #${color}`
      };
    }

    const decoded = decodeEventLog({
      abi: somniaPlaceReactorAbi,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]]
    });

    if (decoded.eventName === "PixelDecayed") {
      const x = Number(decoded.args.x);
      const y = Number(decoded.args.y);

      return {
        kind: "decay",
        timestamp: toMilliseconds(decoded.args.timestamp),
        message: `Pixel at [${x},${y}] decayed`
      };
    }

    if (decoded.eventName === "TerritoryScored") {
      const player = getAddress(decoded.args.player as Address);
      const points = Number(decoded.args.pointsAwarded);
      const cluster = Number(decoded.args.clusterSize);

      return {
        kind: "territory",
        timestamp: blockTimestamp,
        message: `${shortAddress(player)} scored +${points} pts (cluster ${cluster})`
      };
    }

    if (decoded.eventName === "PatternRewarded") {
      const player = getAddress(decoded.args.player as Address);
      const points = Number(decoded.args.pointsAwarded);

      return {
        kind: "pattern",
        timestamp: blockTimestamp,
        message: `${shortAddress(player)} pattern bonus +${points} pts`
      };
    }

    if (decoded.eventName === "CooldownPenaltyApplied") {
      const player = getAddress(decoded.args.player as Address);
      const streak = Number(decoded.args.overwriteStreak);

      return {
        kind: "penalty",
        timestamp: blockTimestamp,
        message: `${shortAddress(player)} penalized (streak ${streak})`
      };
    }
  } catch (error) {
    console.warn("Failed to decode historical activity log", error);
  }

  return null;
}

export async function loadRecentActivityFeed(
  limit = RECENT_ACTIVITY_LIMIT
): Promise<Array<Omit<FeedEntry, "id">>> {
  const latestBlock = await readClient.getBlockNumber();
  const entries: Array<Omit<FeedEntry, "id">> = [];
  const blockTimestampCache = new Map<string, number>();
  let toBlock = latestBlock;
  let scannedBlocks = 0n;

  while (entries.length < limit && scannedBlocks < ACTIVITY_LOOKBACK_LIMIT) {
    const remainingBlocks = ACTIVITY_LOOKBACK_LIMIT - scannedBlocks;
    const windowSize =
      remainingBlocks < ACTIVITY_BLOCK_WINDOW ? remainingBlocks : ACTIVITY_BLOCK_WINDOW;
    const fromBlock = toBlock > windowSize - 1n ? toBlock - (windowSize - 1n) : 0n;

    const [canvasLogs, reactorLogs] = await Promise.all([
      readClient.getLogs({ address: canvasAddress, fromBlock, toBlock }),
      readClient.getLogs({ address: reactorAddress, fromBlock, toBlock })
    ]);

    const logs = [...canvasLogs, ...reactorLogs]
      .filter(isHistoricalActivityLog)
      .sort(compareHistoricalLogs);

    const missingBlockNumbers = [
      ...new Set(
        logs
          .map((log) => log.blockNumber.toString())
          .filter((blockNumber) => !blockTimestampCache.has(blockNumber))
      )
    ];

    await Promise.all(
      missingBlockNumbers.map(async (blockNumber) => {
        const block = await readClient.getBlock({ blockNumber: BigInt(blockNumber) });
        blockTimestampCache.set(blockNumber, toMilliseconds(block.timestamp));
      })
    );

    for (const log of logs) {
      const blockTimestamp = blockTimestampCache.get(log.blockNumber.toString()) ?? Date.now();
      const entry = decodeHistoricalFeedEntry(log, blockTimestamp);
      if (!entry) {
        continue;
      }

      entries.push(entry);
      if (entries.length >= limit) {
        break;
      }
    }

    scannedBlocks += toBlock - fromBlock + 1n;
    if (fromBlock === 0n) {
      break;
    }
    toBlock = fromBlock - 1n;
  }

  return entries;
}

export function useReactivityStream(handlers: {
  onPixelPlaced: (x: number, y: number, color: number, placer: Address) => void;
  onPixelDecayed: (x: number, y: number, color: number) => void;
  onTerritoryScored: (player: Address, points: number, cluster: number) => void;
  onPatternRewarded: (player: Address, points: number) => void;
  onPenaltyApplied: (player: Address, penaltyUntil: number, pixelId: number, streak: number) => void;
}, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const handleCanvasStream = useCallback((packet: any) => {
    try {
      if (!packet.result.topics.length) return;
      const decoded = decodeEventLog({
        abi: somniaPlaceAbi,
        data: packet.result.data,
        topics: packet.result.topics
      });

      if (decoded.eventName === "PixelPlaced") {
        handlersRef.current.onPixelPlaced(
          Number(decoded.args.x),
          Number(decoded.args.y),
          Number(decoded.args.color),
          getAddress(decoded.args.placer as Address)
        );
      } else if (decoded.eventName === "PixelDecayed") {
        handlersRef.current.onPixelDecayed(
          Number(decoded.args.x),
          Number(decoded.args.y),
          Number(decoded.args.color)
        );
      }
    } catch (e) {
      console.error("Canvas stream error", e);
    }
  }, []);

  const handleReactorStream = useCallback((packet: any) => {
    try {
      if (!packet.result.topics.length) return;
      const decoded = decodeEventLog({
        abi: somniaPlaceReactorAbi,
        data: packet.result.data,
        topics: packet.result.topics
      });

      if (decoded.eventName === "PixelDecayed") {
        handlersRef.current.onPixelDecayed(
          Number(decoded.args.x),
          Number(decoded.args.y),
          Number(decoded.args.newColor)
        );
      } else if (decoded.eventName === "TerritoryScored") {
        handlersRef.current.onTerritoryScored(
          getAddress(decoded.args.player as Address),
          Number(decoded.args.pointsAwarded),
          Number(decoded.args.clusterSize)
        );
      } else if (decoded.eventName === "PatternRewarded") {
        handlersRef.current.onPatternRewarded(
          getAddress(decoded.args.player as Address),
          Number(decoded.args.pointsAwarded)
        );
      } else if (decoded.eventName === "CooldownPenaltyApplied") {
        handlersRef.current.onPenaltyApplied(
          getAddress(decoded.args.player as Address),
          Number(decoded.args.penaltyUntil),
          Number(decoded.args.pixelId),
          Number(decoded.args.overwriteStreak)
        );
      }
    } catch (e) {
      console.error("Reactor stream error", e);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const unsubscribers: Array<() => Promise<unknown>> = [];

    const start = async () => {
      const cSub = await reactivitySdk.subscribe({
        eventContractSources: [canvasAddress],
        topicOverrides: [pixelPlacedTopic],
        ethCalls: [],
        onData: (p) => !cancelled && handleCanvasStream(p),
        onError: (e) => console.error(e)
      });
      if (!(cSub instanceof Error)) unsubscribers.push(cSub.unsubscribe);

      const rSub = await reactivitySdk.subscribe({
        eventContractSources: [reactorAddress],
        ethCalls: [],
        onData: (p) => !cancelled && handleReactorStream(p),
        onError: (e) => console.error(e)
      });
      if (!(rSub instanceof Error)) unsubscribers.push(rSub.unsubscribe);
    };

    start();
    return () => {
      cancelled = true;
      unsubscribers.forEach(u => u());
    };
  }, [enabled, handleCanvasStream, handleReactorStream]);
}
