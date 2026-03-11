import { useCallback, useRef } from "react";
import { hexToBytes } from "viem";

import { readClient } from "../lib/clients";
import { somniaPlaceAbi } from "../lib/contracts";
import { pixelIndex, type DecodedPixel } from "../lib/pixels";

const boardWidth = 100;
const boardHeight = 100;
const emptyBoard = new Uint8Array(boardWidth * boardHeight);
const canvasAddress = "0x199D3e126b2BE52954F5DFCc145463a96659cb19";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export const palette = [
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
];

export function useCanvasBoard() {
  const boardRef = useRef<Uint8Array>(emptyBoard.slice());
  const hoverCacheRef = useRef<Map<string, CacheEntry<DecodedPixel>>>(new Map());
  const recentPixelsRef = useRef<Map<string, number>>(new Map());
  const penalizedPixelsRef = useRef<Map<string, number>>(new Map());

  const hydrateBoard = useCallback(async () => {
    try {
      const canvasData = (await readClient.readContract({
        address: canvasAddress as `0x${string}`,
        abi: somniaPlaceAbi,
        functionName: "getCanvas"
      })) as `0x${string}`;

      boardRef.current = hexToBytes(canvasData);
      return true;
    } catch (error) {
      console.error("Failed to hydrate board", error);
      return false;
    }
  }, []);

  const updateBoardCell = useCallback((x: number, y: number, color: number) => {
    boardRef.current[pixelIndex(x, y, boardWidth)] = color;
  }, []);

  const getBoardColor = useCallback((x: number, y: number) => {
    return boardRef.current[pixelIndex(x, y, boardWidth)] ?? 0;
  }, []);

  const trackRecentPixel = useCallback((x: number, y: number, now = Date.now()) => {
    recentPixelsRef.current.set(`${x}:${y}`, now);
  }, []);

  const trackPenalizedPixel = useCallback(
    (x: number, y: number, durationMs: number, now = Date.now()) => {
      penalizedPixelsRef.current.set(`${x}:${y}`, now + durationMs);
    },
    []
  );

  return {
    boardRef,
    hydrateBoard,
    updateBoardCell,
    getBoardColor,
    hoverCacheRef,
    recentPixelsRef,
    penalizedPixelsRef,
    trackRecentPixel,
    trackPenalizedPixel,
    boardWidth,
    boardHeight
  };
}
