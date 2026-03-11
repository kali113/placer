import {
  forwardRef,
  memo,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from "react";

import { pixelIndex } from "../lib/pixels";

export interface HoverCell {
  x: number;
  y: number;
}

export interface BoardCanvasHandle {
  replaceBoard: () => void;
  queueCellUpdate: (x: number, y: number) => void;
  invalidateOverlay: () => void;
}

interface BoardCanvasProps {
  boardRef: MutableRefObject<Uint8Array>;
  palette: readonly string[];
  boardWidth: number;
  boardHeight: number;
  hoverCell: HoverCell | null;
  txPending: boolean;
  heatmapEnabled: boolean;
  recentPixelsRef: MutableRefObject<Map<string, number>>;
  penalizedPixelsRef: MutableRefObject<Map<string, number>>;
  heatmapFadeMs: number;
  getNow: () => number;
  timeVersion: number;
  onHoverCellChange: (cell: HoverCell | null) => void;
  onPlaceCell: (cell: HoverCell) => void;
}

interface CanvasGeometry {
  cell: number;
  devicePixelRatio: number;
  surfaceWidth: number;
  surfaceHeight: number;
  boardOffsetX: number;
  boardOffsetY: number;
  boardPixelWidth: number;
  boardPixelHeight: number;
}

interface SurfaceSize {
  width: number;
  height: number;
}

export const BoardCanvas = memo(
  forwardRef<BoardCanvasHandle, BoardCanvasProps>(function BoardCanvas(
    {
      boardRef,
      palette,
      boardWidth,
      boardHeight,
      hoverCell,
      txPending,
      heatmapEnabled,
      recentPixelsRef,
      penalizedPixelsRef,
      heatmapFadeMs,
      getNow,
      timeVersion,
      onHoverCellChange,
      onPlaceCell
    },
    ref
  ) {
    const shellRef = useRef<HTMLDivElement | null>(null);
    const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const pendingCellsRef = useRef<Map<string, HoverCell>>(new Map());
    const hoverKeyRef = useRef<string | null>(null);
    const geometryRef = useRef<CanvasGeometry>({
      cell: 1,
      devicePixelRatio: 1,
      surfaceWidth: 1,
      surfaceHeight: 1,
      boardOffsetX: 0,
      boardOffsetY: 0,
      boardPixelWidth: boardWidth,
      boardPixelHeight: boardHeight
    });
    const fullRedrawRef = useRef(true);
    const baseFrameRef = useRef<number | null>(null);
    const overlayFrameRef = useRef<number | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const [surfaceSize, setSurfaceSize] = useState<SurfaceSize>({
      width: 1,
      height: 1
    });

    const syncCanvasResolution = useEffectEvent(
      (canvas: HTMLCanvasElement | null, surfaceWidth: number, surfaceHeight: number) => {
        if (!canvas) {
          return;
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(surfaceWidth * devicePixelRatio));
        canvas.height = Math.max(1, Math.floor(surfaceHeight * devicePixelRatio));
        canvas.style.width = "100%";
        canvas.style.height = "100%";
      }
    );

    const drawGrid = useEffectEvent(() => {
      const canvas = gridCanvasRef.current;
      if (!canvas) {
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const { devicePixelRatio, cell, surfaceWidth, surfaceHeight, boardOffsetX, boardOffsetY } =
        geometryRef.current;
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.clearRect(0, 0, surfaceWidth, surfaceHeight);
      context.imageSmoothingEnabled = false;

      if (cell < 6) {
        return;
      }

      context.strokeStyle = "rgba(255, 255, 255, 0.06)";
      context.lineWidth = 1;

      for (let x = 0; x <= boardWidth; x += 1) {
        const drawX = Math.floor(boardOffsetX + x * cell) + 0.5;
        context.beginPath();
        context.moveTo(drawX, boardOffsetY);
        context.lineTo(drawX, boardOffsetY + boardHeight * cell);
        context.stroke();
      }

      for (let y = 0; y <= boardHeight; y += 1) {
        const drawY = Math.floor(boardOffsetY + y * cell) + 0.5;
        context.beginPath();
        context.moveTo(boardOffsetX, drawY);
        context.lineTo(boardOffsetX + boardWidth * cell, drawY);
        context.stroke();
      }
    });

    const drawBoardCell = useEffectEvent((context: CanvasRenderingContext2D, x: number, y: number) => {
      const { cell, boardOffsetX, boardOffsetY } = geometryRef.current;
      const color = palette[boardRef.current[pixelIndex(x, y, boardWidth)]] ?? palette[0];
      context.fillStyle = color;
      context.fillRect(
        Math.floor(boardOffsetX + x * cell),
        Math.floor(boardOffsetY + y * cell),
        Math.ceil(cell),
        Math.ceil(cell)
      );
    });

    const drawBase = useEffectEvent(() => {
      const canvas = baseCanvasRef.current;
      if (!canvas) {
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const { devicePixelRatio, surfaceWidth, surfaceHeight } = geometryRef.current;
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.imageSmoothingEnabled = false;

      if (fullRedrawRef.current) {
        context.clearRect(0, 0, surfaceWidth, surfaceHeight);
        context.fillStyle = "#000";
        context.fillRect(0, 0, surfaceWidth, surfaceHeight);

        for (let y = 0; y < boardHeight; y += 1) {
          for (let x = 0; x < boardWidth; x += 1) {
            drawBoardCell(context, x, y);
          }
        }

        pendingCellsRef.current.clear();
        fullRedrawRef.current = false;
        return;
      }

      if (pendingCellsRef.current.size === 0) {
        return;
      }

      for (const cell of pendingCellsRef.current.values()) {
        drawBoardCell(context, cell.x, cell.y);
      }
      pendingCellsRef.current.clear();
    });

    const drawOverlay = useEffectEvent(() => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) {
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const { devicePixelRatio, cell, surfaceWidth, surfaceHeight, boardOffsetX, boardOffsetY } =
        geometryRef.current;
      const now = getNow();

      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.clearRect(0, 0, surfaceWidth, surfaceHeight);
      context.imageSmoothingEnabled = false;

      for (const [key, expiry] of penalizedPixelsRef.current) {
        if (now > expiry) {
          penalizedPixelsRef.current.delete(key);
        }
      }

      for (const [key, placedAt] of recentPixelsRef.current) {
        if (now - placedAt > heatmapFadeMs) {
          recentPixelsRef.current.delete(key);
        }
      }

      if (heatmapEnabled) {
        for (const [key, placedAt] of recentPixelsRef.current) {
          const age = now - placedAt;
          const [xValue, yValue] = key.split(":");
          const x = Number(xValue);
          const y = Number(yValue);
          const alpha = Math.max(0, 0.45 * (1 - age / heatmapFadeMs));
          const left = Math.floor(boardOffsetX + x * cell);
          const top = Math.floor(boardOffsetY + y * cell);
          const size = Math.ceil(cell);

          context.fillStyle = `rgba(255, 107, 53, ${alpha.toFixed(3)})`;
          context.fillRect(left, top, size, size);

          if (age < 5000 && cell >= 4) {
            const glowAlpha = Math.max(0, 0.3 * (1 - age / 5000));
            context.shadowColor = `rgba(255, 107, 53, ${glowAlpha.toFixed(3)})`;
            context.shadowBlur = cell * 1.5;
            context.fillStyle = `rgba(255, 107, 53, ${(glowAlpha * 0.3).toFixed(3)})`;
            context.fillRect(left, top, size, size);
            context.shadowColor = "transparent";
            context.shadowBlur = 0;
          }
        }
      }

      for (const [key, expiry] of penalizedPixelsRef.current) {
        const [xValue, yValue] = key.split(":");
        const x = Number(xValue);
        const y = Number(yValue);
        const remaining = expiry - now;
        const pulse = 0.15 + 0.25 * Math.abs(Math.sin((now / 300) * Math.PI));
        const fadeOut = Math.min(1, remaining / 2000);
        const left = Math.floor(boardOffsetX + x * cell);
        const top = Math.floor(boardOffsetY + y * cell);
        const size = Math.ceil(cell);

        context.fillStyle = `rgba(239, 71, 111, ${(pulse * fadeOut).toFixed(3)})`;
        context.fillRect(left, top, size, size);

        if (cell >= 4) {
          context.strokeStyle = `rgba(239, 71, 111, ${(0.6 * fadeOut).toFixed(3)})`;
          context.lineWidth = 1;
          context.strokeRect(left + 0.5, top + 0.5, size - 1, size - 1);
        }
      }

      if (hoverCell) {
        const left = Math.floor(boardOffsetX + hoverCell.x * cell);
        const top = Math.floor(boardOffsetY + hoverCell.y * cell);
        const size = Math.ceil(cell);

        context.strokeStyle = txPending ? "#ffd166" : "#f2f3ef";
        context.lineWidth = 2;
        context.strokeRect(left + 1, top + 1, size - 2, size - 2);
      }
    });

    const hasAnimatedOverlay = useEffectEvent(() => {
      const now = getNow();
      const hasPenalties = Array.from(penalizedPixelsRef.current.values()).some((expiry) => expiry > now);
      if (hasPenalties) {
        return true;
      }

      if (!heatmapEnabled) {
        return false;
      }

      return Array.from(recentPixelsRef.current.values()).some(
        (placedAt) => now - placedAt <= heatmapFadeMs
      );
    });

    const stopAnimationLoop = useEffectEvent(() => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    });

    const scheduleBaseDraw = useEffectEvent(() => {
      if (baseFrameRef.current !== null) {
        return;
      }

      baseFrameRef.current = window.requestAnimationFrame(() => {
        baseFrameRef.current = null;
        drawBase();
      });
    });

    const scheduleOverlayDraw = useEffectEvent(() => {
      if (overlayFrameRef.current !== null) {
        return;
      }

      overlayFrameRef.current = window.requestAnimationFrame(() => {
        overlayFrameRef.current = null;
        drawOverlay();
      });
    });

    const ensureAnimationLoop = useEffectEvent(() => {
      if (!hasAnimatedOverlay()) {
        stopAnimationLoop();
        return;
      }

      if (animationFrameRef.current !== null) {
        return;
      }

      const tick = () => {
        animationFrameRef.current = null;
        drawOverlay();

        if (hasAnimatedOverlay()) {
          animationFrameRef.current = window.requestAnimationFrame(tick);
        }
      };

      animationFrameRef.current = window.requestAnimationFrame(tick);
    });

    useImperativeHandle(
      ref,
      () => ({
        replaceBoard() {
          fullRedrawRef.current = true;
          pendingCellsRef.current.clear();
          scheduleBaseDraw();
          scheduleOverlayDraw();
          ensureAnimationLoop();
        },
        queueCellUpdate(x, y) {
          pendingCellsRef.current.set(`${x}:${y}`, { x, y });
          scheduleBaseDraw();
        },
        invalidateOverlay() {
          scheduleOverlayDraw();
          ensureAnimationLoop();
        }
      }),
      [ensureAnimationLoop, scheduleBaseDraw, scheduleOverlayDraw]
    );

    useEffect(() => {
      hoverKeyRef.current = hoverCell ? `${hoverCell.x}:${hoverCell.y}` : null;
      scheduleOverlayDraw();
      ensureAnimationLoop();
    }, [ensureAnimationLoop, heatmapEnabled, hoverCell, scheduleOverlayDraw, timeVersion, txPending]);

    useEffect(() => {
      if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
        return;
      }

      const cell = Math.min(surfaceSize.width / boardWidth, surfaceSize.height / boardHeight);
      const boardPixelWidth = cell * boardWidth;
      const boardPixelHeight = cell * boardHeight;

      geometryRef.current = {
        cell,
        devicePixelRatio: window.devicePixelRatio || 1,
        surfaceWidth: surfaceSize.width,
        surfaceHeight: surfaceSize.height,
        boardOffsetX: Math.floor((surfaceSize.width - boardPixelWidth) / 2),
        boardOffsetY: Math.floor((surfaceSize.height - boardPixelHeight) / 2),
        boardPixelWidth,
        boardPixelHeight
      };

      syncCanvasResolution(baseCanvasRef.current, surfaceSize.width, surfaceSize.height);
      syncCanvasResolution(gridCanvasRef.current, surfaceSize.width, surfaceSize.height);
      syncCanvasResolution(overlayCanvasRef.current, surfaceSize.width, surfaceSize.height);

      fullRedrawRef.current = true;
      drawGrid();
      scheduleBaseDraw();
      scheduleOverlayDraw();
      ensureAnimationLoop();
    }, [
      boardWidth,
      drawGrid,
      ensureAnimationLoop,
      scheduleBaseDraw,
      scheduleOverlayDraw,
      surfaceSize,
      syncCanvasResolution
    ]);

    useEffect(() => {
      const shell = shellRef.current;
      if (!shell) {
        return;
      }

      const commitSurfaceSize = (width: number, height: number) => {
        const nextWidth = Math.max(1, Math.floor(width));
        const nextHeight = Math.max(1, Math.floor(height));
        setSurfaceSize((current) => {
          if (current.width === nextWidth && current.height === nextHeight) {
            return current;
          }

          return {
            width: nextWidth,
            height: nextHeight
          };
        });
      };

      const measureShell = () => {
        const rect = shell.getBoundingClientRect();
        commitSurfaceSize(rect.width, rect.height);
      };

      measureShell();
      const frame = window.requestAnimationFrame(measureShell);
      let retries = 0;
      const retryTimer = window.setInterval(() => {
        retries += 1;
        measureShell();

        if (shell.clientWidth > 1 && shell.clientHeight > 1) {
          window.clearInterval(retryTimer);
          return;
        }

        if (retries >= 20) {
          window.clearInterval(retryTimer);
        }
      }, 100);

      const observer = new ResizeObserver((entries) => {
        const next = entries[0]?.contentRect;
        if (!next) {
          return;
        }

        commitSurfaceSize(next.width, next.height);
      });

      observer.observe(shell);
      window.addEventListener("resize", measureShell);

      return () => {
        window.cancelAnimationFrame(frame);
        window.clearInterval(retryTimer);
        window.removeEventListener("resize", measureShell);
        observer.disconnect();
      };
    }, []);

    useEffect(() => {
      return () => {
        if (baseFrameRef.current !== null) {
          window.cancelAnimationFrame(baseFrameRef.current);
        }
        if (overlayFrameRef.current !== null) {
          window.cancelAnimationFrame(overlayFrameRef.current);
        }
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
        }
      };
    }, []);

    const getCellFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>): HoverCell | null => {
      const { cell, boardOffsetX, boardOffsetY, boardPixelWidth, boardPixelHeight } =
        geometryRef.current;
      const localX = event.nativeEvent.offsetX - boardOffsetX;
      const localY = event.nativeEvent.offsetY - boardOffsetY;

      if (
        localX < 0 ||
        localY < 0 ||
        localX >= boardPixelWidth ||
        localY >= boardPixelHeight
      ) {
        return null;
      }

      const x = Math.floor(localX / cell);
      const y = Math.floor(localY / cell);

      if (x < 0 || x >= boardWidth || y < 0 || y >= boardHeight) {
        return null;
      }

      return { x, y };
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const cell = getCellFromPointer(event);
      const nextKey = cell ? `${cell.x}:${cell.y}` : null;

      if (hoverKeyRef.current === nextKey) {
        return;
      }

      hoverKeyRef.current = nextKey;
      onHoverCellChange(cell);
    };

    const handlePointerLeave = () => {
      if (hoverKeyRef.current === null) {
        return;
      }
      hoverKeyRef.current = null;
      onHoverCellChange(null);
    };

    const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0 || txPending) {
        return;
      }

      const cell = getCellFromPointer(event);
      if (cell) {
        onPlaceCell(cell);
      }
    };

    return (
      <div className="canvas-wrapper" ref={shellRef}>
        <div className="canvas-stack">
          <canvas className="canvas-layer canvas-layer-base" ref={baseCanvasRef} aria-hidden="true" />
          <canvas className="canvas-layer canvas-layer-grid" ref={gridCanvasRef} aria-hidden="true" />
          <canvas
            className="canvas-layer canvas-layer-overlay"
            ref={overlayCanvasRef}
            onContextMenu={(event) => event.preventDefault()}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerUp={handlePointerUp}
          />
        </div>
      </div>
    );
  })
);

BoardCanvas.displayName = "BoardCanvas";
