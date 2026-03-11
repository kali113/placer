import { useState, useCallback, useEffect, useRef } from "react";
import { type Address } from "viem";

import { readClient } from "../lib/clients";
import { somniaPlaceAbi, somniaPlaceReactorAbi } from "../lib/contracts";

const canvasAddress = "0x199D3e126b2BE52954F5DFCc145463a96659cb19" as Address;
const reactorAddress = "0xf9CBa4cD9dfDd8dBE88C7345CCFb04495d13Bf1b" as Address;
const leaderboardLimit = 8n;

export interface LeaderboardEntry {
  address: Address;
  score: bigint;
  placements: bigint;
}

export function useGameStats(account: Address | null) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [uniqueBuilders, setUniqueBuilders] = useState<Set<string>>(new Set());
  const refreshTimerRef = useRef<number | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshInFlightRef = useRef(false);

  const refreshLeaderboard = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }

    refreshQueuedRef.current = false;
    refreshInFlightRef.current = true;

    try {
      const [players, scores] = (await readClient.readContract({
        address: reactorAddress,
        abi: somniaPlaceReactorAbi,
        functionName: "getTopPlayers",
        args: [leaderboardLimit]
      })) as [Address[], bigint[]];

      if (players.length === 0) {
        setLeaderboard([]);
        return;
      }

      const stats = await readClient.multicall({
        contracts: players.map((player) => ({
          address: canvasAddress,
          abi: somniaPlaceAbi,
          functionName: "getUserStats",
          args: [player]
        }))
      });

      const nextRows = players.map((player, index) => {
        const result = stats[index]?.result as [bigint, bigint] | undefined;
        return {
          address: player,
          score: scores[index],
          placements: result?.[0] ?? 0n
        };
      });

      setLeaderboard(nextRows);
    } catch (error) {
      console.error("Leaderboard error", error);
    } finally {
      refreshInFlightRef.current = false;

      if (refreshQueuedRef.current) {
        scheduleLeaderboardRefresh();
      }
    }
  }, []);

  const scheduleLeaderboardRefresh = useCallback(
    (delayMs = 250) => {
      refreshQueuedRef.current = true;

      if (refreshTimerRef.current !== null || refreshInFlightRef.current) {
        return;
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (refreshQueuedRef.current) {
          void refreshLeaderboard();
        }
      }, delayMs);
    },
    [refreshLeaderboard]
  );

  const refreshUserStats = useCallback(async (target: Address) => {
    try {
      const [, nextEligibleTime] = (await readClient.readContract({
        address: canvasAddress,
        abi: somniaPlaceAbi,
        functionName: "getUserStats",
        args: [target]
      })) as [bigint, bigint];

      setCooldownUntil(Number(nextEligibleTime) * 1000);
    } catch (error) {
      console.error("User stats error", error);
    }
  }, []);

  const hydrateBuilders = useCallback(async () => {
    try {
      const count = (await readClient.readContract({
        address: canvasAddress,
        abi: somniaPlaceAbi,
        functionName: "participantCount"
      })) as bigint;

      if (count > 0n) {
        const participants = (await readClient.readContract({
          address: canvasAddress,
          abi: somniaPlaceAbi,
          functionName: "getParticipants",
          args: [0n, count > 500n ? 500n : count]
        })) as Address[];

        setUniqueBuilders(new Set(participants.map((address) => address.toLowerCase())));
      }
    } catch (error) {
      console.warn("Builders hydrate error", error);
    }
  }, []);

  useEffect(() => {
    if (account) {
      void refreshUserStats(account);
    }
  }, [account, refreshUserStats]);

  useEffect(() => {
    scheduleLeaderboardRefresh(0);
    void hydrateBuilders();
  }, [hydrateBuilders, scheduleLeaderboardRefresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  return {
    leaderboard,
    refreshLeaderboard,
    scheduleLeaderboardRefresh,
    refreshUserStats,
    cooldownUntil,
    setCooldownUntil,
    uniqueBuilders,
    setUniqueBuilders
  };
}
