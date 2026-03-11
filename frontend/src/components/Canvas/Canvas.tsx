import React, {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MutableRefObject
} from "react";
import { Crosshair, Clock, Flame, Volume2, VolumeX } from "lucide-react";

import {
  BoardCanvas,
  type BoardCanvasHandle,
  type HoverCell
} from "../BoardCanvas";
import { Button } from "../UI/Button";
import { palette } from "../../hooks/useCanvasBoard";

export interface CanvasHandle {
  replaceBoard: () => void;
  queueCellUpdate: (x: number, y: number) => void;
  invalidateOverlay: () => void;
}

interface CanvasProps {
  boardRef: MutableRefObject<Uint8Array>;
  width: number;
  height: number;
  selectedColor: number;
  onColorSelect: (index: number) => void;
  onPixelPlace: (x: number, y: number) => void | Promise<void>;
  onHover: (x: number, y: number | null) => void;
  cooldownUntil: number;
  getNow: () => number;
  timeVersion: number;
  pendingCell: { x: number; y: number } | null;
  txPending: boolean;
  heatmapEnabled: boolean;
  onToggleHeatmap: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  recentPixels: Map<string, number>;
  penalizedPixels: Map<string, number>;
}

function useTicker(getNow: () => number, intervalMs: number, version: number) {
  const [now, setNow] = useState(() => getNow());

  useEffect(() => {
    setNow(getNow());
    const timer = window.setInterval(() => {
      setNow(getNow());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [getNow, intervalMs, version]);

  return now;
}

export const Canvas = memo(
  forwardRef<CanvasHandle, CanvasProps>(function Canvas(
    {
      boardRef,
      width,
      height,
      selectedColor,
      onColorSelect,
      onPixelPlace,
      onHover,
      cooldownUntil,
      getNow,
      timeVersion,
      pendingCell,
      txPending,
      heatmapEnabled,
      onToggleHeatmap,
      soundEnabled,
      onToggleSound,
      recentPixels,
      penalizedPixels
    },
    ref
  ) {
    const boardCanvasRef = useRef<BoardCanvasHandle | null>(null);
    const recentPixelsRef = useRef(recentPixels);
    const penalizedPixelsRef = useRef(penalizedPixels);
    const [hoverCell, setHoverCell] = useState<HoverCell | null>(null);
    const now = useTicker(getNow, 500, timeVersion);
    const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

    recentPixelsRef.current = recentPixels;
    penalizedPixelsRef.current = penalizedPixels;

    useImperativeHandle(
      ref,
      () => ({
        replaceBoard() {
          boardCanvasRef.current?.replaceBoard();
        },
        queueCellUpdate(x, y) {
          boardCanvasRef.current?.queueCellUpdate(x, y);
        },
        invalidateOverlay() {
          boardCanvasRef.current?.invalidateOverlay();
        }
      }),
      []
    );

    const handleHover = (cell: HoverCell | null) => {
      setHoverCell(cell);
      if (!cell) {
        onHover(0, null);
        return;
      }
      onHover(cell.x, cell.y);
    };

    const handlePlace = (cell: HoverCell) => {
      void onPixelPlace(cell.x, cell.y);
    };

    return (
      <div className="canvas-main-container">
        <div className="canvas-toolbar-glass">
          <div className="palette-grid-glass">
            {palette.map((color, index) => (
              <button
                key={color}
                className={`color-dot-glass ${selectedColor === index ? "active" : ""}`}
                style={{ backgroundColor: color }}
                onClick={() => onColorSelect(index)}
              />
            ))}
          </div>

          <div className="canvas-stats-glass">
            <div className="stat-item-glass">
              <Clock size={14} className="stat-icon" />
              <span className="stat-label">Cooldown:</span>
              <span className={`stat-value ${cooldownSeconds > 0 ? "warning" : "ready"}`}>
                {cooldownSeconds > 0 ? `${cooldownSeconds}s` : "READY"}
              </span>
            </div>
            <div className="stat-item-glass">
              <Crosshair size={14} className="stat-icon" />
              <span className="stat-label">Pending:</span>
              <span className="stat-value">
                {pendingCell ? `[${pendingCell.x}, ${pendingCell.y}]` : "None"}
              </span>
            </div>
          </div>

          <div className="canvas-toggles-glass">
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleSound}
              icon={soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleHeatmap}
              className={heatmapEnabled ? "active" : ""}
              icon={<Flame size={16} />}
            />
          </div>
        </div>

        <div className="canvas-frame-glass">
          <BoardCanvas
            ref={boardCanvasRef}
            boardRef={boardRef}
            palette={palette}
            boardWidth={width}
            boardHeight={height}
            hoverCell={hoverCell}
            txPending={txPending}
            heatmapEnabled={heatmapEnabled}
            recentPixelsRef={recentPixelsRef}
            penalizedPixelsRef={penalizedPixelsRef}
            heatmapFadeMs={60_000}
            getNow={getNow}
            timeVersion={timeVersion}
            onHoverCellChange={handleHover}
            onPlaceCell={handlePlace}
          />
        </div>
      </div>
    );
  })
);

Canvas.displayName = "Canvas";
