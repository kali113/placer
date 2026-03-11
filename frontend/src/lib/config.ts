import { getAddress, type Address } from "viem";

const defaultSomniaRpcUrl = "https://dream-rpc.somnia.network";
const defaultSomniaWsUrl = "wss://dream-rpc.somnia.network/ws";
const defaultSomniaExplorerUrl = "https://shannon.somnia.network";
const defaultCanvasAddress = "0x199D3e126b2BE52954F5DFCc145463a96659cb19";
const defaultReactorAddress = "0xf9CBa4cD9dfDd8dBE88C7345CCFb04495d13Bf1b";

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const somniaChainId = parseNumber(import.meta.env.VITE_SOMNIA_CHAIN_ID, 50312);
export const somniaRpcUrl = import.meta.env.VITE_SOMNIA_RPC_URL || defaultSomniaRpcUrl;
export const somniaWsUrl = import.meta.env.VITE_SOMNIA_WS_URL || defaultSomniaWsUrl;
export const somniaExplorerUrl =
  import.meta.env.VITE_SOMNIA_EXPLORER_URL || defaultSomniaExplorerUrl;

export const canvasAddress = getAddress(
  import.meta.env.VITE_SOMNIA_PLACE_ADDRESS || defaultCanvasAddress
) as Address;
export const reactorAddress = getAddress(
  import.meta.env.VITE_SOMNIA_REACTOR_ADDRESS || defaultReactorAddress
) as Address;

export const boardWidth = parseNumber(import.meta.env.VITE_CANVAS_WIDTH, 100);
export const boardHeight = parseNumber(import.meta.env.VITE_CANVAS_HEIGHT, 100);
