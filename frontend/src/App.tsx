import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wallet, Activity, Trophy, Crosshair, Clock, Network,
  Map as MapIcon, Palette, Volume2, VolumeX, Users, Flame, Zap
} from "lucide-react";
import {
  createWalletClient,
  custom,
  decodeEventLog,
  getAddress,
  hexToBytes,
  type Address
} from "viem";

import { readClient, reactivitySdk } from "./lib/clients";
import { somniaShannon, somniaChainId, somniaExplorerUrl, somniaRpcUrl } from "./lib/chain";
import {
  pixelPlacedTopic,
  somniaPlaceAbi,
  somniaPlaceReactorAbi
} from "./lib/contracts";
import { decodePackedPixel, pixelIndex, type DecodedPixel } from "./lib/pixels";

/* ── EIP-6963 provider detection (MetaMask recommended approach) ───────── */

interface EIP6963ProviderInfo {
  rdns: string;
  uuid: string;
  name: string;
  icon: string;
}

interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

type EIP6963AnnounceProviderEvent = CustomEvent<EIP6963ProviderDetail>;

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": EIP6963AnnounceProviderEvent;
  }
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

/** All announced EIP-6963 providers, populated at module load. */
const eip6963Providers: EIP6963ProviderDetail[] = [];

window.addEventListener("eip6963:announceProvider", (event: EIP6963AnnounceProviderEvent) => {
  const detail = event.detail;
  if (eip6963Providers.some((p) => p.info.uuid === detail.info.uuid)) return;
  eip6963Providers.push(detail);
});

// Ask installed extensions to announce themselves.
window.dispatchEvent(new Event("eip6963:requestProvider"));

/**
 * Return the MetaMask provider using EIP-6963 `rdns` identification.
 * This is the MetaMask-recommended way to avoid Trust Wallet / Coinbase /
 * other extensions hijacking `window.ethereum`.
 */
function getProvider(): EIP1193Provider | null {
  // First: try EIP-6963 announced providers – match by rdns
  const metamask = eip6963Providers.find((p) => p.info.rdns === "io.metamask");
  if (metamask) return metamask.provider;

  // Fallback: any announced provider (user may only have one wallet)
  if (eip6963Providers.length > 0) return eip6963Providers[0].provider;

  return null;
}

/* ── Feed entry types ─────────────────────────────────────────────────── */

interface FeedEntry {
  id: number;
  timestamp: number;
  kind: "pixel" | "territory" | "pattern" | "penalty" | "decay";
  message: string;
}

let feedIdCounter = 0;
const MAX_FEED_ENTRIES = 50;

/* ── Sound engine (Web Audio API — no files needed) ───────────────────── */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

function playClickSound() {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.08);
  gain.gain.setValueAtTime(0.12, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.1);
}

function playScoreChime() {
  const ctx = getAudioContext();
  const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 arpeggio
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    const t = ctx.currentTime + i * 0.08;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
}

function playWarningBuzz() {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(150, ctx.currentTime);
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.25);
}

function playDecayWhoosh() {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.2);
}

/* ── Constants & palette ──────────────────────────────────────────────── */

interface LeaderboardEntry {
  address: Address;
  score: bigint;
  placements: bigint;
}

interface HoverCell {
  x: number;
  y: number;
}

const canvasAddress = import.meta.env.VITE_SOMNIA_PLACE_ADDRESS as Address | undefined;
const reactorAddress = import.meta.env.VITE_SOMNIA_REACTOR_ADDRESS as Address | undefined;
const boardWidth = Number(import.meta.env.VITE_CANVAS_WIDTH ?? 100);
const boardHeight = Number(import.meta.env.VITE_CANVAS_HEIGHT ?? 100);
const paletteSize = Number(import.meta.env.VITE_PALETTE_SIZE ?? 16);
const leaderboardLimit = 8n;

/** Heatmap glow fades after this many ms. */
const HEATMAP_FADE_MS = 60_000;

/** Penalty pulse duration in ms. */
const PENALTY_PULSE_MS = 10_000;

const palette = [
  "#101318",
  "#f2f3ef",
  "#ff6b35",
  "#ffd166",
  "#2ec4b6",
  "#1b9aaa",
  "#577590",
  "#ef476f",
  "#06d6a0",
  "#118ab2",
  "#073b4c",
  "#8ecae6",
  "#ffb703",
  "#fb8500",
  "#90be6d",
  "#8338ec"
].slice(0, paletteSize);

const emptyBoard = new Uint8Array(boardWidth * boardHeight);

function shortAddress(address: Address | null | undefined): string {
  if (!address) {
    return "Unclaimed";
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return "never";
  }
  return new Date(timestamp * 1000).toLocaleString();
}

function timeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/* ── Feed entry icon mapping ──────────────────────────────────────────── */

const feedKindIcons: Record<FeedEntry["kind"], string> = {
  pixel: "px",
  territory: "ts",
  pattern: "pt",
  penalty: "!!",
  decay: "dc"
};

const feedKindColors: Record<FeedEntry["kind"], string> = {
  pixel: "var(--accent-color)",
  territory: "var(--success)",
  pattern: "#ffd166",
  penalty: "#ef476f",
  decay: "var(--text-muted)"
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boardShellRef = useRef<HTMLDivElement | null>(null);
  const feedListRef = useRef<HTMLUListElement | null>(null);
  const hoverCacheRef = useRef<Map<string, DecodedPixel>>(new Map());
  const virtualNowOffsetRef = useRef(0);
  const soundEnabledRef = useRef(false);

  /* Recent pixel timestamps for heatmap (key = "x:y", value = Date.now()) */
  const recentPixelsRef = useRef<Map<string, number>>(new Map());

  /* Penalized pixel coords for cooldown pulse (key = "x:y", value = expiry Date.now()) */
  const penalizedPixelsRef = useRef<Map<string, number>>(new Map());

  const [surfaceSize, setSurfaceSize] = useState({ width: 960, height: 720 });
  const [board, setBoard] = useState<Uint8Array>(emptyBoard);
  const [account, setAccount] = useState<Address | null>(null);
  const [selectedColor, setSelectedColor] = useState(2);
  const [status, setStatus] = useState("Hydrating on-chain canvas...");
  const [hoverCell, setHoverCell] = useState<HoverCell | null>(null);
  const [hoverPixel, setHoverPixel] = useState<DecodedPixel | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [txPending, setTxPending] = useState(false);
  const [pendingCell, setPendingCell] = useState<HoverCell | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  /* Feature 1: Live Activity Feed */
  const [feed, setFeed] = useState<FeedEntry[]>([]);

  /* Feature 2: Sound toggle */
  const [soundEnabled, setSoundEnabled] = useState(false);

  /* Feature 3: Heatmap toggle */
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);

  /* Feature 4: Unique active builders */
  const [uniqueBuilders, setUniqueBuilders] = useState<Set<string>>(new Set());

  /* Feature 5: Player profile — score for hovered pixel owner */
  const [hoverOwnerScore, setHoverOwnerScore] = useState<bigint | null>(null);

  const deferredLeaderboard = useDeferredValue(leaderboard);
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));

  // Keep the ref in sync for use inside sound functions called from useEffectEvent
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const pushFeedEntry = useCallback((kind: FeedEntry["kind"], message: string) => {
    const entry: FeedEntry = {
      id: ++feedIdCounter,
      timestamp: Date.now(),
      kind,
      message
    };
    setFeed((prev) => {
      const next = [entry, ...prev];
      return next.length > MAX_FEED_ENTRIES ? next.slice(0, MAX_FEED_ENTRIES) : next;
    });
  }, []);

  const refreshLeaderboard = useEffectEvent(async () => {
    if (!reactorAddress || !canvasAddress) {
      return;
    }

    const [players, scores] = (await readClient.readContract({
      address: reactorAddress,
      abi: somniaPlaceReactorAbi,
      functionName: "getTopPlayers",
      args: [leaderboardLimit]
    })) as [Address[], bigint[]];

    if (players.length === 0) {
      startTransition(() => setLeaderboard([]));
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

    startTransition(() => setLeaderboard(nextRows));
  });

  const refreshUserStats = useEffectEvent(async (target: Address) => {
    if (!canvasAddress) {
      return;
    }

    const [, nextEligibleTime] = (await readClient.readContract({
      address: canvasAddress,
      abi: somniaPlaceAbi,
      functionName: "getUserStats",
      args: [target]
    })) as [bigint, bigint];

    setCooldownUntil(Number(nextEligibleTime) * 1000);
  });

  const updateBoardCell = useEffectEvent((x: number, y: number, color: number) => {
    startTransition(() => {
      setBoard((current) => {
        const next = current.slice();
        next[pixelIndex(x, y, boardWidth)] = color;
        return next;
      });
    });
  });

  const hydrateBoard = useEffectEvent(async () => {
    if (!canvasAddress) {
      setStatus("Missing VITE_SOMNIA_PLACE_ADDRESS");
      return;
    }

    const canvasData = (await readClient.readContract({
      address: canvasAddress,
      abi: somniaPlaceAbi,
      functionName: "getCanvas"
    })) as `0x${string}`;

    const boardBytes = hexToBytes(canvasData);
    startTransition(() => setBoard(boardBytes));

    // Feature 4: Pre-populate builder count from on-chain participant list
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

        setUniqueBuilders(new Set(participants.map((a) => a.toLowerCase())));
      }
    } catch (err) {
      console.warn("Failed to fetch participant list", err);
    }

    setStatus("Canvas hydrated. Waiting for live Shannon events.");
  });

  const ensureSomniaWalletChain = useEffectEvent(async () => {
    const provider = getProvider();
    if (!provider) {
      throw new Error("No injected wallet found. Install MetaMask.");
    }

    const hexChainId = `0x${somniaChainId.toString(16)}`;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }]
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) {
        throw error;
      }

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexChainId,
            chainName: "Somnia Testnet",
            nativeCurrency: {
              name: "STT",
              symbol: "STT",
              decimals: 18
            },
            rpcUrls: [somniaRpcUrl],
            blockExplorerUrls: [somniaExplorerUrl]
          }
        ]
      });
    }
  });

  const connectWallet = useEffectEvent(async () => {
    const provider = getProvider();
    if (!provider) {
      setStatus("Install MetaMask to place pixels.");
      return;
    }

    await ensureSomniaWalletChain();
    const accounts = (await provider.request({
      method: "eth_requestAccounts"
    })) as string[];

    if (accounts.length === 0) {
      return;
    }

    const nextAccount = getAddress(accounts[0] as Address);
    setAccount(nextAccount);
    setStatus(`Connected ${shortAddress(nextAccount)} on Shannon.`);

    // Feature 4: Add connected account to builders set
    setUniqueBuilders((prev) => {
      const key = nextAccount.toLowerCase();
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    await refreshUserStats(nextAccount);
  });

  const placePixel = useEffectEvent(async (cell: HoverCell) => {
    if (!canvasAddress) {
      return;
    }
    const provider = getProvider();
    if (!provider) {
      setStatus("Install MetaMask to place pixels.");
      return;
    }

    let currentAccount = account;
    if (!currentAccount) {
      await connectWallet();
      const accounts = (await provider.request({
        method: "eth_accounts"
      })) as string[];
      currentAccount = accounts[0] ? getAddress(accounts[0] as Address) : null;
    }

    if (!currentAccount) {
      return;
    }

    try {
      await ensureSomniaWalletChain();

      const walletClient = createWalletClient({
        account: currentAccount,
        chain: somniaShannon,
        transport: custom(provider)
      });

      setTxPending(true);
      setPendingCell(cell);
      setStatus(`Submitting pixel at ${cell.x},${cell.y}…`);

      const hash = await walletClient.writeContract({
        address: canvasAddress,
        abi: somniaPlaceAbi,
        functionName: "placePixel",
        args: [cell.x, cell.y, selectedColor]
      });

      const receipt = await readClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Transaction reverted.");
      }

      // Optimistically update the board so the pixel appears immediately
      updateBoardCell(cell.x, cell.y, selectedColor);

      // Feature 4: Optimistically add current user to builders
      setUniqueBuilders((prev) => {
        const key = currentAccount!.toLowerCase();
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });

      setStatus(
        `Pixel confirmed at ${cell.x},${cell.y}. Explorer: ${somniaExplorerUrl}/tx/${hash}`
      );
      hoverCacheRef.current.delete(`${cell.x}:${cell.y}`);
      await Promise.all([refreshUserStats(currentAccount), refreshLeaderboard()]);
    } catch (error) {
      setStatus((error as Error).message || "Pixel placement failed.");
    } finally {
      setTxPending(false);
      setPendingCell(null);
    }
  });

  const handleCanvasStream = useEffectEvent((packet: { result: { topics: `0x${string}`[]; data: `0x${string}` } }) => {
    try {
      if (packet.result.topics.length === 0) {
        return;
      }

      const decoded = decodeEventLog({
        abi: somniaPlaceAbi,
        data: packet.result.data,
        topics: packet.result.topics as [`0x${string}`, ...`0x${string}`[]]
      });

      if (decoded.eventName === "PixelPlaced") {
        const x = Number(decoded.args.x);
        const y = Number(decoded.args.y);
        const color = Number(decoded.args.color);
        const timestamp = Number(decoded.args.timestamp);
        const placer = getAddress(decoded.args.placer as Address);

        hoverCacheRef.current.set(`${x}:${y}`, {
          color,
          owner: placer,
          lastUpdated: timestamp,
          overwriteCount: 0,
          flags: 0
        });

        updateBoardCell(x, y, color);

        // Feature 1: Push to activity feed
        pushFeedEntry("pixel", `${shortAddress(placer)} placed pixel at [${x},${y}] color #${color}`);

        // Feature 2: Sound effect
        if (soundEnabledRef.current) {
          playClickSound();
        }

        // Feature 3: Track recent pixel for heatmap
        recentPixelsRef.current.set(`${x}:${y}`, Date.now());

        // Feature 4: Track unique builder
        setUniqueBuilders((prev) => {
          if (prev.has(placer.toLowerCase())) return prev;
          const next = new Set(prev);
          next.add(placer.toLowerCase());
          return next;
        });

        if (account && placer.toLowerCase() === account.toLowerCase()) {
          void refreshUserStats(account);
        }
      }

      if (decoded.eventName === "PixelDecayed") {
        const x = Number(decoded.args.x);
        const y = Number(decoded.args.y);
        const color = Number(decoded.args.color);
        updateBoardCell(x, y, color);

        // Feature 1: Feed
        pushFeedEntry("decay", `Pixel at [${x},${y}] decayed`);

        // Feature 2: Sound
        if (soundEnabledRef.current) {
          playDecayWhoosh();
        }
      }
    } catch (error) {
      console.error("Failed to decode canvas stream payload", error);
    }
  });

  const handleReactorStream = useEffectEvent((packet: { result: { topics: `0x${string}`[]; data: `0x${string}` } }) => {
    try {
      if (packet.result.topics.length === 0) {
        return;
      }

      const decoded = decodeEventLog({
        abi: somniaPlaceReactorAbi,
        data: packet.result.data,
        topics: packet.result.topics as [`0x${string}`, ...`0x${string}`[]]
      });

      if (decoded.eventName === "PixelDecayed") {
        const x = Number(decoded.args.x);
        const y = Number(decoded.args.y);
        const color = Number(decoded.args.newColor);
        hoverCacheRef.current.delete(`${x}:${y}`);
        updateBoardCell(x, y, color);

        pushFeedEntry("decay", `Reactor decayed pixel at [${x},${y}]`);
        if (soundEnabledRef.current) playDecayWhoosh();
      }

      if (decoded.eventName === "TerritoryScored") {
        const player = getAddress(decoded.args.player as Address);
        const pts = Number(decoded.args.pointsAwarded);
        const cluster = Number(decoded.args.clusterSize);
        pushFeedEntry("territory", `${shortAddress(player)} scored +${pts} pts (cluster ${cluster})`);

        if (soundEnabledRef.current) playScoreChime();
        void refreshLeaderboard();
      }

      if (decoded.eventName === "PatternRewarded") {
        const player = getAddress(decoded.args.player as Address);
        const pts = Number(decoded.args.pointsAwarded);
        pushFeedEntry("pattern", `${shortAddress(player)} pattern bonus +${pts} pts`);

        if (soundEnabledRef.current) playScoreChime();
        void refreshLeaderboard();
      }

      if (decoded.eventName === "CooldownPenaltyApplied") {
        const player = getAddress(decoded.args.player as Address);
        const streak = Number(decoded.args.overwriteStreak);
        pushFeedEntry("penalty", `${shortAddress(player)} penalized (streak ${streak})`);

        if (soundEnabledRef.current) playWarningBuzz();

        // Feature 6: Track penalized pixel for cooldown pulse
        const pixelId = Number(decoded.args.pixelId);
        const px = pixelId % boardWidth;
        const py = Math.floor(pixelId / boardWidth);
        penalizedPixelsRef.current.set(`${px}:${py}`, Date.now() + PENALTY_PULSE_MS);

        void refreshLeaderboard();

        if (account && player.toLowerCase() === account.toLowerCase()) {
          setCooldownUntil(Number(decoded.args.penaltyUntil) * 1000);
        }
      }
    } catch (error) {
      console.error("Failed to decode reactor stream payload", error);
    }
  });

  useEffect(() => {
    const shell = boardShellRef.current;
    if (!shell) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (!next) {
        return;
      }

      setSurfaceSize({
        width: Math.max(320, Math.floor(next.width)),
        height: Math.max(320, Math.floor(next.height))
      });
    });

    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void hydrateBoard();
    void refreshLeaderboard();
  }, [hydrateBoard, refreshLeaderboard]);

  useEffect(() => {
    if (account) {
      void refreshUserStats(account);
    }
  }, [account, refreshUserStats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(Date.now() + virtualNowOffsetRef.current);
    }, 500);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onAccountsChanged = (accounts: unknown) => {
      const next = Array.isArray(accounts) && accounts[0] ? getAddress(accounts[0] as Address) : null;
      setAccount(next);
      if (next) {
        void refreshUserStats(next);
      }
    };

    const provider = getProvider();
    provider?.on?.("accountsChanged", onAccountsChanged);
    return () => provider?.removeListener?.("accountsChanged", onAccountsChanged);
  }, [refreshUserStats]);

  useEffect(() => {
    if (!canvasAddress || !reactorAddress) {
      return;
    }

    let cancelled = false;
    const unsubscribers: Array<() => Promise<unknown>> = [];

    const startSubscriptions = async () => {
      // Canvas events via Somnia Reactivity SDK (off-chain WebSocket mode)
      const canvasSub = await reactivitySdk.subscribe({
        eventContractSources: [canvasAddress],
        topicOverrides: [pixelPlacedTopic],
        ethCalls: [],
        onData: (payload) => {
          if (!cancelled) {
            handleCanvasStream(payload);
          }
        },
        onError: (error) => console.error("Canvas reactivity subscription error", error)
      });

      if (!(canvasSub instanceof Error)) {
        unsubscribers.push(canvasSub.unsubscribe);
      }

      // Reactor events via Somnia Reactivity SDK (off-chain WebSocket mode)
      const reactorSub = await reactivitySdk.subscribe({
        eventContractSources: [reactorAddress],
        ethCalls: [],
        onData: (payload) => {
          if (!cancelled) {
            handleReactorStream(payload);
          }
        },
        onError: (error) => console.error("Reactor reactivity subscription error", error)
      });

      if (!(reactorSub instanceof Error)) {
        unsubscribers.push(reactorSub.unsubscribe);
      }
    };

    void startSubscriptions();

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        void unsubscribe();
      }
    };
  }, [handleCanvasStream, handleReactorStream]);

  useEffect(() => {
    if (!hoverCell || !canvasAddress) {
      setHoverPixel(null);
      setHoverOwnerScore(null);
      return;
    }

    const cacheKey = `${hoverCell.x}:${hoverCell.y}`;
    const cached = hoverCacheRef.current.get(cacheKey);
    if (cached) {
      setHoverPixel(cached);
      // Feature 5: Fetch score for hovered pixel owner
      if (cached.owner && reactorAddress) {
        void readClient
          .readContract({
            address: reactorAddress,
            abi: somniaPlaceReactorAbi,
            functionName: "scores",
            args: [cached.owner]
          })
          .then((score) => setHoverOwnerScore(score as bigint))
          .catch(() => setHoverOwnerScore(null));
      } else {
        setHoverOwnerScore(null);
      }
      return;
    }

    const timer = window.setTimeout(() => {
      void readClient
        .readContract({
          address: canvasAddress,
          abi: somniaPlaceAbi,
          functionName: "getPixelPacked",
          args: [hoverCell.x, hoverCell.y]
        })
        .then((packed) => {
          const decoded = decodePackedPixel(packed as bigint);
          hoverCacheRef.current.set(cacheKey, decoded);
          setHoverPixel(decoded);

          // Feature 5: Fetch score for hovered pixel owner
          if (decoded.owner && reactorAddress) {
            void readClient
              .readContract({
                address: reactorAddress,
                abi: somniaPlaceReactorAbi,
                functionName: "scores",
                args: [decoded.owner]
              })
              .then((score) => setHoverOwnerScore(score as bigint))
              .catch(() => setHoverOwnerScore(null));
          } else {
            setHoverOwnerScore(null);
          }
        })
        .catch((error) => console.error("Failed to fetch hover pixel", error));
    }, 80);

    return () => window.clearTimeout(timer);
  }, [hoverCell]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        mode: txPending ? "placing" : "ready",
        board: {
          origin: "top-left",
          axes: { x: "right", y: "down" },
          width: boardWidth,
          height: boardHeight,
          hovered: hoverCell,
          selectedColor,
          pendingCell
        },
        wallet: {
          account,
          cooldownSeconds
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
      setClock(Date.now() + virtualNowOffsetRef.current);
    };

    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [
    account,
    cooldownSeconds,
    deferredLeaderboard,
    hoverCell,
    pendingCell,
    selectedColor,
    status,
    txPending
  ]);

  /* ── Canvas rendering (with heatmap + cooldown pulse overlays) ──────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(surfaceSize.width * devicePixelRatio);
    canvas.height = Math.floor(surfaceSize.height * devicePixelRatio);
    canvas.style.width = `${surfaceSize.width}px`;
    canvas.style.height = `${surfaceSize.height}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, surfaceSize.width, surfaceSize.height);
    context.imageSmoothingEnabled = false;

    // Fill background
    context.fillStyle = "#000";
    context.fillRect(0, 0, surfaceSize.width, surfaceSize.height);

    // Uniform square cells: pick the smaller axis so pixels are perfect squares
    const cell = Math.min(surfaceSize.width / boardWidth, surfaceSize.height / boardHeight);
    const gridW = cell * boardWidth;
    const gridH = cell * boardHeight;
    const padX = Math.floor((surfaceSize.width - gridW) / 2);
    const padY = Math.floor((surfaceSize.height - gridH) / 2);

    const now = Date.now();

    // Draw pixels
    for (let y = 0; y < boardHeight; y += 1) {
      for (let x = 0; x < boardWidth; x += 1) {
        const color = palette[board[pixelIndex(x, y, boardWidth)]] ?? palette[0];
        context.fillStyle = color;
        context.fillRect(
          Math.floor(padX + x * cell),
          Math.floor(padY + y * cell),
          Math.ceil(cell),
          Math.ceil(cell)
        );
      }
    }

    // Feature 3: Heatmap glow overlay
    if (heatmapEnabled) {
      for (const [key, placedAt] of recentPixelsRef.current) {
        const age = now - placedAt;
        if (age > HEATMAP_FADE_MS) {
          recentPixelsRef.current.delete(key);
          continue;
        }

        const [xStr, yStr] = key.split(":");
        const hx = Number(xStr);
        const hy = Number(yStr);
        const alpha = Math.max(0, 0.45 * (1 - age / HEATMAP_FADE_MS));

        const cx = Math.floor(padX + hx * cell);
        const cy = Math.floor(padY + hy * cell);
        const cs = Math.ceil(cell);

        // Additive glow
        context.fillStyle = `rgba(255, 107, 53, ${alpha.toFixed(3)})`;
        context.fillRect(cx, cy, cs, cs);

        // Outer glow when very recent
        if (age < 5000 && cell >= 4) {
          const glowAlpha = Math.max(0, 0.3 * (1 - age / 5000));
          context.shadowColor = `rgba(255, 107, 53, ${glowAlpha.toFixed(3)})`;
          context.shadowBlur = cell * 1.5;
          context.fillStyle = `rgba(255, 107, 53, ${(glowAlpha * 0.3).toFixed(3)})`;
          context.fillRect(cx, cy, cs, cs);
          context.shadowColor = "transparent";
          context.shadowBlur = 0;
        }
      }
    }

    // Feature 6: Cooldown pulse overlay for penalized pixels
    for (const [key, expiry] of penalizedPixelsRef.current) {
      if (now > expiry) {
        penalizedPixelsRef.current.delete(key);
        continue;
      }

      const [xStr, yStr] = key.split(":");
      const px = Number(xStr);
      const py = Number(yStr);

      const remaining = expiry - now;
      // Pulsing effect — oscillate alpha using sine wave
      const pulse = 0.15 + 0.25 * Math.abs(Math.sin((now / 300) * Math.PI));
      const fadeOut = Math.min(1, remaining / 2000); // fade in last 2s

      const cx = Math.floor(padX + px * cell);
      const cy = Math.floor(padY + py * cell);
      const cs = Math.ceil(cell);

      context.fillStyle = `rgba(239, 71, 111, ${(pulse * fadeOut).toFixed(3)})`;
      context.fillRect(cx, cy, cs, cs);

      // Red border pulse
      if (cell >= 4) {
        context.strokeStyle = `rgba(239, 71, 111, ${(0.6 * fadeOut).toFixed(3)})`;
        context.lineWidth = 1;
        context.strokeRect(cx + 0.5, cy + 0.5, cs - 1, cs - 1);
      }
    }

    // Draw grid lines when cells are large enough
    if (cell >= 6) {
      context.strokeStyle = "rgba(255, 255, 255, 0.06)";
      context.lineWidth = 1;

      for (let x = 0; x <= boardWidth; x += 1) {
        const drawX = Math.floor(padX + x * cell) + 0.5;
        context.beginPath();
        context.moveTo(drawX, padY);
        context.lineTo(drawX, padY + gridH);
        context.stroke();
      }

      for (let y = 0; y <= boardHeight; y += 1) {
        const drawY = Math.floor(padY + y * cell) + 0.5;
        context.beginPath();
        context.moveTo(padX, drawY);
        context.lineTo(padX + gridW, drawY);
        context.stroke();
      }
    }

    // Hover highlight
    if (hoverCell) {
      const hx = Math.floor(padX + hoverCell.x * cell);
      const hy = Math.floor(padY + hoverCell.y * cell);
      const hs = Math.ceil(cell);

      context.strokeStyle = txPending ? "#ffd166" : "#f2f3ef";
      context.lineWidth = 2;
      context.strokeRect(hx + 1, hy + 1, hs - 2, hs - 2);
    }
  }, [board, hoverCell, surfaceSize.height, surfaceSize.width, txPending, heatmapEnabled, clock]);

  const getCellFromPointer = (clientX: number, clientY: number): HoverCell | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const cell = Math.min(rect.width / boardWidth, rect.height / boardHeight);
    const gridW = cell * boardWidth;
    const gridH = cell * boardHeight;
    const padX = (rect.width - gridW) / 2;
    const padY = (rect.height - gridH) / 2;

    const x = Math.floor((clientX - rect.left - padX) / cell);
    const y = Math.floor((clientY - rect.top - padY) / cell);

    if (x < 0 || x >= boardWidth || y < 0 || y >= boardHeight) {
      return null;
    }

    return { x, y };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    setHoverCell(getCellFromPointer(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || txPending) {
      return;
    }

    const cell = getCellFromPointer(event.clientX, event.clientY);
    if (cell) {
      void placePixel(cell);
    }
  };

  /* Auto-scroll feed list when new entries arrive */
  useEffect(() => {
    const el = feedListRef.current;
    if (el && el.scrollTop < 60) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [feed]);

  return (
    <div className="app-shell">
      <motion.header 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="header-glass"
      >
        <div className="brand-title">
          <div className="brand-dot" />
          SomniaPlace <span style={{ color: "var(--text-secondary)", fontWeight: 400, fontSize: "0.9rem" }}>Canvas</span>
        </div>
        
        <div className="header-actions">
          {/* Feature 4: Multi-user indicator */}
          <div className="multi-user-badge">
            <Users size={14} />
            <span>{uniqueBuilders.size} builder{uniqueBuilders.size !== 1 ? "s" : ""}</span>
          </div>

          <div className="status-indicator">
            <Activity size={14} className="panel-icon" />
            <span>{status.length > 30 ? `${status.substring(0, 30)}...` : status}</span>
          </div>
          
          <button className={`wallet-btn ${!account ? 'outline' : ''}`} onClick={() => void connectWallet()}>
            <Wallet size={16} />
            {account ? shortAddress(account) : "Connect"}
          </button>
        </div>
      </motion.header>

      <main className="main-grid">
        <motion.section 
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="canvas-container"
        >
          <div className="toolbar">
            <div className="palette-wrap">
              <Palette size={16} color="var(--text-secondary)" />
              <div className="palette-colors">
                {palette.map((swatch, index) => (
                  <button
                    key={swatch}
                    aria-label={`Color ${index}`}
                    className={index === selectedColor ? "color-swatch active" : "color-swatch"}
                    style={{ backgroundColor: swatch }}
                    onClick={() => setSelectedColor(index)}
                  />
                ))}
              </div>
            </div>

            <div className="toolbar-info">
              <div className="toolbar-info-row">
                <Clock size={14} />
                <span>Cooldown:</span>
                <strong>{cooldownSeconds > 0 ? `${cooldownSeconds}s` : "READY"}</strong>
              </div>
              <div className="toolbar-info-row">
                <Crosshair size={14} />
                <span>Pending:</span>
                <strong>
                  {pendingCell ? `${pendingCell.x},${pendingCell.y}` : txPending ? "WAITING" : "NONE"}
                </strong>
              </div>

              {/* Feature 2 + 3: Toggle buttons */}
              <div className="toolbar-toggles">
                <button
                  className={`toggle-btn ${soundEnabled ? "active" : ""}`}
                  onClick={() => setSoundEnabled((v) => !v)}
                  title={soundEnabled ? "Mute sounds" : "Enable sounds"}
                >
                  {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
                </button>
                <button
                  className={`toggle-btn ${heatmapEnabled ? "active" : ""}`}
                  onClick={() => setHeatmapEnabled((v) => !v)}
                  title={heatmapEnabled ? "Hide heatmap" : "Show heatmap"}
                >
                  <Flame size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="canvas-wrapper" ref={boardShellRef}>
            <canvas
              ref={canvasRef}
              onContextMenu={(event) => event.preventDefault()}
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverCell(null)}
              onPointerUp={handlePointerUp}
            />
          </div>
        </motion.section>

        <motion.aside 
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="sidebar"
        >
          {/* Feature 5: Enhanced Hover Detail / Player Profile */}
          <div className="panel">
            <div className="panel-header">
              <MapIcon size={18} className="panel-icon" />
              Pixel Detail
            </div>
            
            <h2 className="mono" style={{ color: hoverCell ? "var(--text-primary)" : "var(--text-muted)", fontSize: "1.2rem" }}>
              {hoverCell ? `[${hoverCell.x}, ${hoverCell.y}]` : "[-- , --]"}
            </h2>
            
            <div className="data-grid">
              <div className="data-card">
                <span className="data-label">Color ID</span>
                <span className="data-value">
                  {hoverPixel ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        className="data-color-dot"
                        style={{ backgroundColor: palette[hoverPixel.color] ?? palette[0] }}
                      />
                      {hoverPixel.color}
                    </span>
                  ) : "-"}
                </span>
              </div>
              <div className="data-card">
                <span className="data-label">Owner</span>
                <span className="data-value">{shortAddress(hoverPixel?.owner)}</span>
              </div>
              <div className="data-card">
                <span className="data-label">Updated</span>
                <span className="data-value" style={{ fontSize: "0.8rem" }}>{hoverPixel ? formatTimestamp(hoverPixel.lastUpdated) : "-"}</span>
              </div>
              <div className="data-card">
                <span className="data-label">Overwrites</span>
                <span className="data-value">{hoverPixel?.overwriteCount ?? "-"}</span>
              </div>
              <div className="data-card full-width">
                <span className="data-label">Owner Score</span>
                <span className="data-value">
                  {hoverPixel?.owner ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Trophy size={12} color="var(--warning)" />
                      {hoverOwnerScore !== null ? `${hoverOwnerScore.toString()} pts` : "..."}
                    </span>
                  ) : "-"}
                </span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <Trophy size={18} className="panel-icon" />
              Top Builders
            </div>
            
            {deferredLeaderboard.length === 0 ? (
              <div className="empty-state">Board is live and ready.</div>
            ) : (
              <ul className="leaderboard">
                <AnimatePresence>
                  {deferredLeaderboard.map((entry, index) => (
                    <motion.li 
                      key={entry.address}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="leaderboard-item"
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={`lb-rank top-${index + 1}`}>#{index + 1}</span>
                        <span className="lb-address">{shortAddress(entry.address)}</span>
                      </div>
                      <div className="lb-stats">
                        <span className="lb-score">{entry.score.toString()} pts</span>
                        <span className="lb-placements">{entry.placements.toString()} pixels</span>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>

          {/* Feature 1: Live Activity Feed */}
          <div className="panel feed-panel">
            <div className="panel-header">
              <Zap size={18} className="panel-icon" />
              Live Activity
              {feed.length > 0 && <span className="feed-count">{feed.length}</span>}
            </div>

            {feed.length === 0 ? (
              <div className="empty-state">Waiting for Reactivity events...</div>
            ) : (
              <ul className="feed-list" ref={feedListRef}>
                <AnimatePresence initial={false}>
                  {feed.slice(0, 20).map((entry) => (
                    <motion.li
                      key={entry.id}
                      initial={{ opacity: 0, x: -10, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="feed-item"
                    >
                      <span
                        className="feed-badge"
                        style={{ background: feedKindColors[entry.kind] }}
                      >
                        {feedKindIcons[entry.kind]}
                      </span>
                      <span className="feed-msg">{entry.message}</span>
                      <span className="feed-time">{timeAgo(Date.now() - entry.timestamp)}</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </motion.aside>
      </main>
    </div>
  );
}
