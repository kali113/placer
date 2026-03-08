import { getAddress, type Address } from "viem";

const OWNER_MASK = (1n << 160n) - 1n;
const COLOR_MASK = 0xffn;

export interface DecodedPixel {
  color: number;
  owner: Address | null;
  lastUpdated: number;
  overwriteCount: number;
  flags: number;
}

export function pixelIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

export function decodePackedPixel(packed: bigint): DecodedPixel {
  const ownerRaw = (packed >> 8n) & OWNER_MASK;
  const owner =
    ownerRaw === 0n
      ? null
      : getAddress(`0x${ownerRaw.toString(16).padStart(40, "0")}` as Address);

  return {
    color: Number(packed & COLOR_MASK),
    owner,
    lastUpdated: Number((packed >> 168n) & ((1n << 64n) - 1n)),
    overwriteCount: Number((packed >> 232n) & ((1n << 16n) - 1n)),
    flags: Number((packed >> 248n) & 0xffn)
  };
}

