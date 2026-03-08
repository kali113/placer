import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, Activity, Trophy, Crosshair, Clock, Network, Map as MapIcon, Palette } from "lucide-react";
import {
  createWalletClient,
  custom,
  decodeEventLog,
  getAddress,
  hexToBytes,
  type Address
} from "viem";

import { readClient, streamsSdk } from "./lib/clients";
import { somniaShannon, somniaChainId, somniaExplorerUrl, somniaRpcUrl } from "./lib/chain";
import {
  pixelPlacedTopic,
  somniaPlaceAbi,
  somniaPlaceReactorAbi
} from "./lib/contracts";
import { decodePackedPixel, pixelIndex, type DecodedPixel } from "./lib/pixels";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

interface LeaderboardEntry {
  address: Address;
  score: bigint;
  placements: bigint;
}

interface HoverCell {
  x: number;
  y: number;
}

interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  initialized: boolean;
}

const canvasAddress = import.meta.env.VITE_SOMNIA_PLACE_ADDRESS as Address | undefined;
const reactorAddress = import.meta.env.VITE_SOMNIA_REACTOR_ADDRESS as Address | undefined;
const boardWidth = Number(import.meta.env.VITE_CANVAS_WIDTH ?? 100);
const boardHeight = Number(import.meta.env.VITE_CANVAS_HEIGHT ?? 100);
const paletteSize = Number(import.meta.env.VITE_PALETTE_SIZE ?? 16);
const leaderboardLimit = 8n;

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

function createInitialViewport(surfaceWidth: number, surfaceHeight: number): Viewport {
  const scale = Math.max(
    4,
    Math.floor(Math.min(surfaceWidth / boardWidth, surfaceHeight / boardHeight) * 0.8)
  );
  return {
    scale,
    offsetX: Math.floor((surfaceWidth - boardWidth * scale) / 2),
    offsetY: Math.floor((surfaceHeight - boardHeight * scale) / 2),
    initialized: true
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boardShellRef = useRef<HTMLDivElement | null>(null);
  const hoverCacheRef = useRef<Map<string, DecodedPixel>>(new Map());
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const virtualNowOffsetRef = useRef(0);

  const [surfaceSize, setSurfaceSize] = useState({ width: 960, height: 720 });
  const [viewport, setViewport] = useState<Viewport>({
    scale: 6,
    offsetX: 0,
    offsetY: 0,
    initialized: false
  });
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

  const deferredLeaderboard = useDeferredValue(leaderboard);
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));

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
    setStatus("Canvas hydrated. Waiting for live Shannon events.");
  });

  const ensureSomniaWalletChain = useEffectEvent(async () => {
    if (!window.ethereum) {
      throw new Error("No injected wallet found.");
    }

    const hexChainId = `0x${somniaChainId.toString(16)}`;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }]
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) {
        throw error;
      }

      await window.ethereum.request({
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
    if (!window.ethereum) {
      setStatus("Install an EVM wallet to place pixels.");
      return;
    }

    await ensureSomniaWalletChain();
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts"
    })) as string[];

    if (accounts.length === 0) {
      return;
    }

    const nextAccount = getAddress(accounts[0] as Address);
    setAccount(nextAccount);
    setStatus(`Connected ${shortAddress(nextAccount)} on Shannon.`);
    await refreshUserStats(nextAccount);
  });

  const placePixel = useEffectEvent(async (cell: HoverCell) => {
    if (!canvasAddress) {
      return;
    }
    if (!window.ethereum) {
      setStatus("Install an EVM wallet to place pixels.");
      return;
    }

    let currentAccount = account;
    if (!currentAccount) {
      await connectWallet();
      const accounts = (await window.ethereum.request({
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
        transport: custom(window.ethereum)
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

        if (account && placer.toLowerCase() === account.toLowerCase()) {
          void refreshUserStats(account);
        }
      }

      if (decoded.eventName === "PixelDecayed") {
        updateBoardCell(Number(decoded.args.x), Number(decoded.args.y), Number(decoded.args.color));
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
      }

      if (
        decoded.eventName === "TerritoryScored" ||
        decoded.eventName === "PatternRewarded" ||
        decoded.eventName === "CooldownPenaltyApplied"
      ) {
        void refreshLeaderboard();
      }

      if (decoded.eventName === "CooldownPenaltyApplied" && account) {
        const player = getAddress(decoded.args.player as Address);
        if (player.toLowerCase() === account.toLowerCase()) {
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
    if (!viewport.initialized) {
      setViewport(createInitialViewport(surfaceSize.width, surfaceSize.height));
    }
  }, [surfaceSize.height, surfaceSize.width, viewport.initialized]);

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

    window.ethereum?.on?.("accountsChanged", onAccountsChanged);
    return () => window.ethereum?.removeListener?.("accountsChanged", onAccountsChanged);
  }, [refreshUserStats]);

  useEffect(() => {
    if (!canvasAddress || !reactorAddress) {
      return;
    }

    let cancelled = false;
    const unsubscribers: Array<() => Promise<unknown>> = [];

    const startSubscriptions = async () => {
      const canvasSub = await streamsSdk.streams.subscribe({
        eventContractSources: [canvasAddress],
        topicOverrides: [pixelPlacedTopic],
        ethCalls: [],
        onData: (payload) => {
          if (!cancelled) {
            handleCanvasStream(payload);
          }
        },
        onError: (error) => console.error("Canvas stream error", error)
      });

      if (!(canvasSub instanceof Error)) {
        unsubscribers.push(canvasSub.unsubscribe);
      }

      const reactorSub = await streamsSdk.streams.subscribe({
        eventContractSources: [reactorAddress],
        ethCalls: [],
        onData: (payload) => {
          if (!cancelled) {
            handleReactorStream(payload);
          }
        },
        onError: (error) => console.error("Reactor stream error", error)
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
      return;
    }

    const cacheKey = `${hoverCell.x}:${hoverCell.y}`;
    const cached = hoverCacheRef.current.get(cacheKey);
    if (cached) {
      setHoverPixel(cached);
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

    const gradient = context.createLinearGradient(0, 0, surfaceSize.width, surfaceSize.height);
    gradient.addColorStop(0, "rgba(255, 107, 53, 0.16)");
    gradient.addColorStop(1, "rgba(27, 154, 170, 0.12)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, surfaceSize.width, surfaceSize.height);

    for (let y = 0; y < boardHeight; y += 1) {
      for (let x = 0; x < boardWidth; x += 1) {
        const color = palette[board[pixelIndex(x, y, boardWidth)]] ?? palette[0];
        context.fillStyle = color;
        context.fillRect(
          Math.floor(viewport.offsetX + x * viewport.scale),
          Math.floor(viewport.offsetY + y * viewport.scale),
          Math.ceil(viewport.scale),
          Math.ceil(viewport.scale)
        );
      }
    }

    if (viewport.scale >= 8) {
      context.strokeStyle = "rgba(255, 255, 255, 0.08)";
      context.lineWidth = 1;

      for (let x = 0; x <= boardWidth; x += 1) {
        const drawX = Math.floor(viewport.offsetX + x * viewport.scale) + 0.5;
        context.beginPath();
        context.moveTo(drawX, viewport.offsetY);
        context.lineTo(drawX, viewport.offsetY + boardHeight * viewport.scale);
        context.stroke();
      }

      for (let y = 0; y <= boardHeight; y += 1) {
        const drawY = Math.floor(viewport.offsetY + y * viewport.scale) + 0.5;
        context.beginPath();
        context.moveTo(viewport.offsetX, drawY);
        context.lineTo(viewport.offsetX + boardWidth * viewport.scale, drawY);
        context.stroke();
      }
    }

    if (hoverCell) {
      context.strokeStyle = txPending ? "#ffd166" : "#f2f3ef";
      context.lineWidth = 2;
      context.strokeRect(
        Math.floor(viewport.offsetX + hoverCell.x * viewport.scale) + 1,
        Math.floor(viewport.offsetY + hoverCell.y * viewport.scale) + 1,
        Math.max(2, Math.ceil(viewport.scale) - 2),
        Math.max(2, Math.ceil(viewport.scale) - 2)
      );
    }
  }, [board, hoverCell, surfaceSize.height, surfaceSize.width, txPending, viewport]);

  const getCellFromPointer = (clientX: number, clientY: number): HoverCell | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - viewport.offsetX) / viewport.scale);
    const y = Math.floor((clientY - rect.top - viewport.offsetY) / viewport.scale);

    if (x < 0 || x >= boardWidth || y < 0 || y >= boardHeight) {
      return null;
    }

    return { x, y };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      setViewport((current) => ({
        ...current,
        offsetX: panRef.current!.originX + (event.clientX - panRef.current!.startX),
        offsetY: panRef.current!.originY + (event.clientY - panRef.current!.startY)
      }));
      return;
    }

    setHoverCell(getCellFromPointer(event.clientX, event.clientY));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2 || event.shiftKey) {
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: viewport.offsetX,
        originY: viewport.offsetY
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }

    if (event.button !== 0 || txPending) {
      return;
    }

    const cell = getCellFromPointer(event.clientX, event.clientY);
    if (cell) {
      void placePixel(cell);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    setViewport((current) => {
      const zoomFactor = event.deltaY < 0 ? 1.14 : 0.88;
      const nextScale = clamp(current.scale * zoomFactor, 4, 42);
      const worldX = (pointerX - current.offsetX) / current.scale;
      const worldY = (pointerY - current.offsetY) / current.scale;

      return {
        ...current,
        scale: nextScale,
        offsetX: pointerX - worldX * nextScale,
        offsetY: pointerY - worldY * nextScale
      };
    });
  };

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
            </div>
          </div>

          <div className="canvas-wrapper" ref={boardShellRef}>
            <canvas
              ref={canvasRef}
              onContextMenu={(event) => event.preventDefault()}
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverCell(null)}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onWheel={handleWheel}
            />
          </div>
        </motion.section>

        <motion.aside 
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="sidebar"
        >
          <div className="panel">
            <div className="panel-header">
              <MapIcon size={18} className="panel-icon" />
              Hover Detail
            </div>
            
            <h2 className="mono" style={{ color: hoverCell ? "var(--text-primary)" : "var(--text-muted)", fontSize: "1.2rem" }}>
              {hoverCell ? `[${hoverCell.x}, ${hoverCell.y}]` : "[-- , --]"}
            </h2>
            
            <div className="data-grid">
              <div className="data-card">
                <span className="data-label">Color ID</span>
                <span className="data-value">{hoverPixel ? hoverPixel.color : "-"}</span>
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

          <div className="panel">
            <div className="panel-header">
              <Network size={18} className="panel-icon" />
              Live Feed
            </div>
            <ul className="list-basic">
              <li>Direct wallet writes to Canvas contract</li>
              <li>Reactivity scores & penalizes local play</li>
              <li>Streams pushes live WebSocket events</li>
            </ul>
          </div>
        </motion.aside>
      </main>
    </div>
  );
}
