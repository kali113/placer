import { useCallback, useEffect, useRef, useState, useDeferredValue } from "react";
import { type Address } from "viem";

import { useWallet } from "./hooks/useWallet";
import { useCanvasBoard } from "./hooks/useCanvasBoard";
import {
  loadRecentActivityFeed,
  useReactivityStream,
  type FeedEntry,
  type FeedLoadState
} from "./hooks/useReactivityStream";
import { useGameStats } from "./hooks/useGameStats";

import { Layout } from "./components/Layout/Layout";
import { Navbar } from "./components/Navigation/Navbar";
import { Canvas, type CanvasHandle } from "./components/Canvas/Canvas";
import { Inspector } from "./components/Sidebar/Inspector";
import { Leaderboard } from "./components/Sidebar/Leaderboard";
import { ActivityLog } from "./components/Sidebar/ActivityLog";

import { readClient } from "./lib/clients";
import { canvasAddress, reactorAddress } from "./lib/config";
import { somniaPlaceAbi, somniaPlaceReactorAbi } from "./lib/contracts";
import { decodePackedPixel, type DecodedPixel } from "./lib/pixels";

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

interface OwnerScoreCacheEntry {
  expiresAt: number;
  value: bigint;
}

let audioCtx: AudioContext | null = null;

function normalizeDecodedPixel(pixel: DecodedPixel): DecodedPixel | null {
  if (
    pixel.owner === null &&
    pixel.lastUpdated === 0 &&
    pixel.overwriteCount === 0 &&
    pixel.flags === 0
  ) {
    return null;
  }

  return pixel;
}

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

function playSound(type: "click" | "score" | "warning" | "decay") {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  if (type === "click") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } else if (type === "score") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(659.25, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } else if (type === "warning") {
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } else {
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);
}

export default function App() {
  const { account, status, setStatus, connectWallet, getWalletClient } = useWallet();
  const {
    boardRef,
    hydrateBoard,
    updateBoardCell,
    getBoardColor,
    boardWidth,
    boardHeight,
    hoverCacheRef,
    recentPixelsRef,
    penalizedPixelsRef,
    trackRecentPixel,
    trackPenalizedPixel
  } = useCanvasBoard();
  const {
    leaderboard,
    scheduleLeaderboardRefresh,
    refreshUserStats,
    cooldownUntil,
    setCooldownUntil,
    uniqueBuilders,
    setUniqueBuilders
  } = useGameStats(account);

  const canvasRef = useRef<CanvasHandle | null>(null);
  const hoverRequestsRef = useRef<Map<string, Promise<DecodedPixel | null>>>(new Map());
  const ownerScoreCacheRef = useRef<Map<string, OwnerScoreCacheEntry>>(new Map());
  const ownerScoreRequestsRef = useRef<Map<string, Promise<bigint>>>(new Map());
  const latestHoverKeyRef = useRef<string | null>(null);
  const virtualNowOffsetRef = useRef(0);
  const soundEnabledRef = useRef(false);
  const feedIdRef = useRef(0);

  const [selectedColor, setSelectedColor] = useState(2);
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [pendingCell, setPendingCell] = useState<{ x: number; y: number } | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [feedState, setFeedState] = useState<FeedLoadState>("loading");
  const [hoverCoord, setHoverCoord] = useState<{ x: number; y: number | null }>({
    x: 0,
    y: null
  });
  const [hoverColorId, setHoverColorId] = useState<number | null>(null);
  const [hoverPixel, setHoverPixel] = useState<DecodedPixel | null>(null);
  const [hoverOwnerScore, setHoverOwnerScore] = useState<bigint | null>(null);
  const [timeVersion, setTimeVersion] = useState(0);
  const [streamEnabled, setStreamEnabled] = useState(false);

  const deferredLeaderboard = useDeferredValue(leaderboard);
  const getNow = useCallback(() => Date.now() + virtualNowOffsetRef.current, []);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const pushFeed = useCallback(
    (kind: FeedEntry["kind"], message: string) => {
      const entry: FeedEntry = {
        id: ++feedIdRef.current,
        timestamp: getNow(),
        kind,
        message
      };

      setFeedState("ready");
      setFeed((current) => [entry, ...current].slice(0, 50));
    },
    [getNow]
  );

  const loadOwnerScore = useCallback(
    async (owner: Address) => {
      const key = owner.toLowerCase();
      const cached = ownerScoreCacheRef.current.get(key);
      const now = getNow();

      if (cached && cached.expiresAt > now) {
        return cached.value;
      }

      const inFlight = ownerScoreRequestsRef.current.get(key);
      if (inFlight) {
        return inFlight;
      }

      const request = readClient
        .readContract({
          address: reactorAddress,
          abi: somniaPlaceReactorAbi,
          functionName: "scores",
          args: [owner]
        })
        .then((score) => {
          const value = score as bigint;
          ownerScoreCacheRef.current.set(key, {
            expiresAt: getNow() + 5_000,
            value
          });
          return value;
        })
        .finally(() => {
          ownerScoreRequestsRef.current.delete(key);
        });

      ownerScoreRequestsRef.current.set(key, request);
      return request;
    },
    [getNow]
  );

  const refreshHoveredOwnerScore = useCallback(
    async (owner: Address, hoverKey: string) => {
      try {
        const score = await loadOwnerScore(owner);
        if (latestHoverKeyRef.current === hoverKey) {
          setHoverOwnerScore(score);
        }
      } catch {
        if (latestHoverKeyRef.current === hoverKey) {
          setHoverOwnerScore(null);
        }
      }
    },
    [loadOwnerScore]
  );

  const getHoverPixel = useCallback(
    async (x: number, y: number, cacheKey: string) => {
      const cached = hoverCacheRef.current.get(cacheKey);
      if (cached && cached.expiresAt > getNow()) {
        return cached.value;
      }

      const inFlight = hoverRequestsRef.current.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }

      const request = readClient
        .readContract({
          address: canvasAddress,
          abi: somniaPlaceAbi,
          functionName: "getPixelPacked",
          args: [x, y]
        })
        .then((packed) => {
          const decoded = normalizeDecodedPixel(decodePackedPixel(packed as bigint));
          hoverCacheRef.current.set(cacheKey, {
            expiresAt: getNow() + 15_000,
            value: decoded
          });
          return decoded;
        })
        .finally(() => {
          hoverRequestsRef.current.delete(cacheKey);
        });

      hoverRequestsRef.current.set(cacheKey, request);
      return request;
    },
    [getNow, hoverCacheRef]
  );

  const queueBoardCell = useCallback((x: number, y: number) => {
    canvasRef.current?.queueCellUpdate(x, y);
  }, []);

  const invalidateOverlay = useCallback(() => {
    canvasRef.current?.invalidateOverlay();
  }, []);

  useReactivityStream({
    onPixelPlaced: (x, y, color, placer) => {
      const hoverKey = `${x}:${y}`;
      const nextPixel: DecodedPixel = {
        color,
        owner: placer,
        lastUpdated: Math.floor(getNow() / 1000),
        overwriteCount: 0,
        flags: 0
      };

      updateBoardCell(x, y, color);
      queueBoardCell(x, y);
      trackRecentPixel(x, y, getNow());
      invalidateOverlay();

      hoverCacheRef.current.set(hoverKey, {
        expiresAt: getNow() + 15_000,
        value: nextPixel
      });

      pushFeed("pixel", `${placer.slice(0, 6)}…${placer.slice(-4)} placed pixel at [${x},${y}] color #${color}`);

      if (soundEnabledRef.current) {
        playSound("click");
      }

      setUniqueBuilders((current) => {
        const next = new Set(current);
        next.add(placer.toLowerCase());
        return next;
      });

      if (latestHoverKeyRef.current === hoverKey) {
        setHoverColorId(color);
        setHoverPixel(nextPixel);
        setHoverOwnerScore(null);
        void refreshHoveredOwnerScore(placer, hoverKey);
      }

      if (account && placer.toLowerCase() === account.toLowerCase()) {
        void refreshUserStats(account);
      }
    },
    onPixelDecayed: (x, y, color) => {
      const hoverKey = `${x}:${y}`;
      updateBoardCell(x, y, color);
      queueBoardCell(x, y);
      invalidateOverlay();
      hoverCacheRef.current.delete(hoverKey);

      if (latestHoverKeyRef.current === hoverKey) {
        setHoverColorId(color);
        setHoverPixel(null);
        setHoverOwnerScore(null);
      }

      pushFeed("decay", `Pixel at [${x},${y}] decayed`);

      if (soundEnabledRef.current) {
        playSound("decay");
      }
    },
    onTerritoryScored: (player, points, cluster) => {
      ownerScoreCacheRef.current.delete(player.toLowerCase());
      pushFeed(
        "territory",
        `${player.slice(0, 6)}…${player.slice(-4)} scored +${points} pts (cluster ${cluster})`
      );
      if (soundEnabledRef.current) {
        playSound("score");
      }
      scheduleLeaderboardRefresh();

      const hoverKey = latestHoverKeyRef.current;
      if (hoverKey && hoverPixel?.owner?.toLowerCase() === player.toLowerCase()) {
        setHoverOwnerScore(null);
        void refreshHoveredOwnerScore(player, hoverKey);
      }
    },
    onPatternRewarded: (player, points) => {
      ownerScoreCacheRef.current.delete(player.toLowerCase());
      pushFeed("pattern", `${player.slice(0, 6)}…${player.slice(-4)} pattern bonus +${points} pts`);
      if (soundEnabledRef.current) {
        playSound("score");
      }
      scheduleLeaderboardRefresh();

      const hoverKey = latestHoverKeyRef.current;
      if (hoverKey && hoverPixel?.owner?.toLowerCase() === player.toLowerCase()) {
        setHoverOwnerScore(null);
        void refreshHoveredOwnerScore(player, hoverKey);
      }
    },
    onPenaltyApplied: (player, until, pixelId, streak) => {
      pushFeed("penalty", `${player.slice(0, 6)}…${player.slice(-4)} penalized (streak ${streak})`);
      trackPenalizedPixel(pixelId % boardWidth, Math.floor(pixelId / boardWidth), 10_000, getNow());
      invalidateOverlay();
      scheduleLeaderboardRefresh();

      if (soundEnabledRef.current) {
        playSound("warning");
      }

      if (account && player.toLowerCase() === account.toLowerCase()) {
        setCooldownUntil(until * 1000);
      }
    }
  }, { enabled: streamEnabled });

  const placePixel = useCallback(
    async (x: number, y: number) => {
      if (txPending) {
        return;
      }

      const client = await getWalletClient();
      if (!client || !account) {
        return;
      }

      try {
        setTxPending(true);
        setPendingCell({ x, y });
        setStatus(`Submitting pixel at ${x},${y}…`);

        const hash = await client.writeContract({
          address: canvasAddress,
          abi: somniaPlaceAbi,
          functionName: "placePixel",
          args: [x, y, selectedColor]
        });

        await readClient.waitForTransactionReceipt({ hash });

        updateBoardCell(x, y, selectedColor);
        queueBoardCell(x, y);
        hoverCacheRef.current.delete(`${x}:${y}`);

        setStatus(`Pixel confirmed at ${x},${y}.`);

        setUniqueBuilders((current) => {
          const next = new Set(current);
          next.add(account.toLowerCase());
          return next;
        });

        void refreshUserStats(account);
        scheduleLeaderboardRefresh(0);
      } catch (error) {
        setStatus((error as Error).message || "Placement failed.");
      } finally {
        setTxPending(false);
        setPendingCell(null);
      }
    },
    [
      account,
      getWalletClient,
      queueBoardCell,
      refreshUserStats,
      scheduleLeaderboardRefresh,
      selectedColor,
      setStatus,
      setUniqueBuilders,
      txPending,
      updateBoardCell,
      hoverCacheRef
    ]
  );

  useEffect(() => {
    void hydrateBoard().then((success) => {
      if (!success) {
        return;
      }

      canvasRef.current?.replaceBoard();
      setStatus("Canvas hydrated. Ready.");
    });
  }, [hydrateBoard, setStatus]);

  useEffect(() => {
    let cancelled = false;

    void loadRecentActivityFeed()
      .then((entries) => {
        if (cancelled) {
          return;
        }

        setFeedState(entries.length > 0 ? "ready" : "empty");
        if (entries.length === 0) {
          setStreamEnabled(true);
          return;
        }

        setFeed((current) => {
          const merged = [...current];
          const seen = new Set(current.map((entry) => `${entry.kind}|${entry.timestamp}|${entry.message}`));

          for (const entry of entries) {
            const key = `${entry.kind}|${entry.timestamp}|${entry.message}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            merged.push({ ...entry, id: ++feedIdRef.current });
          }

          return merged.sort((left, right) => right.timestamp - left.timestamp).slice(0, 50);
        });

        setStreamEnabled(true);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.error("Recent activity load failed", error);
        setFeedState("error");
        setStreamEnabled(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hoverCoord.y === null) {
      latestHoverKeyRef.current = null;
      setHoverColorId(null);
      setHoverPixel(null);
      setHoverOwnerScore(null);
      return;
    }

    const hoverKey = `${hoverCoord.x}:${hoverCoord.y}`;
    latestHoverKeyRef.current = hoverKey;
    setHoverColorId(getBoardColor(hoverCoord.x, hoverCoord.y));

    const cached = hoverCacheRef.current.get(hoverKey);
    if (cached && cached.expiresAt > getNow()) {
      setHoverPixel(cached.value);
      if (cached.value?.owner) {
        setHoverOwnerScore(null);
        void refreshHoveredOwnerScore(cached.value.owner, hoverKey);
      } else {
        setHoverOwnerScore(null);
      }
      return;
    }

    setHoverPixel(null);
    setHoverOwnerScore(null);

    const timer = window.setTimeout(() => {
      void getHoverPixel(hoverCoord.x, hoverCoord.y!, hoverKey)
        .then((pixel) => {
          if (latestHoverKeyRef.current !== hoverKey) {
            return;
          }

          setHoverPixel(pixel);
          if (pixel?.owner) {
            setHoverOwnerScore(null);
            void refreshHoveredOwnerScore(pixel.owner, hoverKey);
          } else {
            setHoverOwnerScore(null);
          }
        })
        .catch((error) => {
          console.error("Hover pixel read failed", error);
        });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [getBoardColor, getHoverPixel, getNow, hoverCoord, hoverCacheRef, refreshHoveredOwnerScore]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        mode: txPending ? "placing" : "ready",
        board: {
          origin: "top-left",
          axes: { x: "right", y: "down" },
          width: boardWidth,
          height: boardHeight,
          hovered: hoverCoord.y === null ? null : { x: hoverCoord.x, y: hoverCoord.y },
          selectedColor,
          pendingCell
        },
        wallet: {
          account,
          cooldownSeconds: Math.max(0, Math.ceil((cooldownUntil - getNow()) / 1000))
        },
        leaderboard: deferredLeaderboard.slice(0, 5).map((entry) => ({
          address: entry.address,
          score: entry.score.toString(),
          placements: entry.placements.toString()
        })),
        status
      });

    window.advanceTime = (ms: number) => {
      virtualNowOffsetRef.current += ms;
      setTimeVersion((value) => value + 1);
      canvasRef.current?.invalidateOverlay();
    };

    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [
    account,
    boardHeight,
    boardWidth,
    cooldownUntil,
    deferredLeaderboard,
    getNow,
    hoverCoord,
    pendingCell,
    selectedColor,
    status,
    txPending
  ]);

  const handleHover = useCallback((x: number, y: number | null) => {
    setHoverCoord({ x, y });
  }, []);

  const toggleHeatmap = useCallback(() => {
    setHeatmapEnabled((value) => !value);
    canvasRef.current?.invalidateOverlay();
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((value) => !value);
  }, []);

  return (
    <Layout
      header={
        <Navbar
          account={account}
          status={status}
          builderCount={uniqueBuilders.size}
          onConnect={connectWallet}
        />
      }
      main={
        <Canvas
          ref={canvasRef}
          boardRef={boardRef}
          width={boardWidth}
          height={boardHeight}
          selectedColor={selectedColor}
          onColorSelect={setSelectedColor}
          onPixelPlace={placePixel}
          onHover={handleHover}
          cooldownUntil={cooldownUntil}
          getNow={getNow}
          timeVersion={timeVersion}
          pendingCell={pendingCell}
          txPending={txPending}
          heatmapEnabled={heatmapEnabled}
          onToggleHeatmap={toggleHeatmap}
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
          recentPixels={recentPixelsRef.current}
          penalizedPixels={penalizedPixelsRef.current}
        />
      }
      sidebar={
        <>
          <Inspector
            x={hoverCoord.x}
            y={hoverCoord.y}
            colorId={hoverColorId}
            pixel={hoverPixel}
            ownerScore={hoverOwnerScore}
          />
          <Leaderboard entries={deferredLeaderboard} />
          <ActivityLog feed={feed} state={feedState} />
        </>
      }
    />
  );
}
