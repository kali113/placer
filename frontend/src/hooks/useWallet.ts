import { useState, useEffect, useCallback, useRef } from "react";
import { getAddress, type Address } from "viem";

import {
  somniaShannon,
  somniaChainId,
  somniaRpcUrl,
  somniaExplorerUrl
} from "../lib/chain";

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

interface WalletClientLike {
  account?: { address?: Address };
  writeContract: (parameters: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }) => Promise<`0x${string}`>;
}

type EIP6963AnnounceProviderEvent = CustomEvent<EIP6963ProviderDetail>;

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": EIP6963AnnounceProviderEvent;
  }
}

const eip6963Providers: EIP6963ProviderDetail[] = [];
let walletToolsPromise:
  | Promise<Pick<typeof import("viem"), "createWalletClient" | "custom">>
  | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event: EIP6963AnnounceProviderEvent) => {
    const detail = event.detail;
    if (eip6963Providers.some((provider) => provider.info.uuid === detail.info.uuid)) {
      return;
    }
    eip6963Providers.push(detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function getProvider(): EIP1193Provider | null {
  const metamask = eip6963Providers.find((provider) => provider.info.rdns === "io.metamask");
  if (metamask) {
    return metamask.provider;
  }
  return eip6963Providers[0]?.provider ?? null;
}

async function loadWalletTools() {
  walletToolsPromise ??= import("viem").then(({ createWalletClient, custom }) => ({
    createWalletClient,
    custom
  }));
  return walletToolsPromise;
}

export function useWallet() {
  const [account, setAccount] = useState<Address | null>(null);
  const [status, setStatus] = useState("Connect your wallet to start building.");
  const chainVerifiedRef = useRef(false);
  const walletClientRef = useRef<WalletClientLike | null>(null);

  const ensureSomniaWalletChain = useCallback(async () => {
    if (chainVerifiedRef.current) {
      return;
    }

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
            nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
            rpcUrls: [somniaRpcUrl],
            blockExplorerUrls: [somniaExplorerUrl]
          }
        ]
      });
    }

    chainVerifiedRef.current = true;
  }, []);

  const connectWallet = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setStatus("Install MetaMask to place pixels.");
      return;
    }

    try {
      await ensureSomniaWalletChain();
      const accounts = (await provider.request({
        method: "eth_requestAccounts"
      })) as string[];

      if (accounts.length > 0) {
        const nextAccount = getAddress(accounts[0] as Address);
        setAccount(nextAccount);
        setStatus("Connected to Somnia Shannon.");
      }
    } catch (error) {
      setStatus("Failed to connect wallet.");
      console.error(error);
    }
  }, [ensureSomniaWalletChain]);

  const getWalletClient = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !account) {
      return null;
    }

    const { createWalletClient, custom } = await loadWalletTools();

    if (!walletClientRef.current || walletClientRef.current.account?.address !== account) {
      walletClientRef.current = createWalletClient({
        account,
        chain: somniaShannon,
        transport: custom(provider)
      }) as WalletClientLike;
    }

    return walletClientRef.current;
  }, [account]);

  useEffect(() => {
    const provider = getProvider();
    const onAccountsChanged = (accounts: unknown) => {
      const next =
        Array.isArray(accounts) && accounts[0] ? getAddress(accounts[0] as Address) : null;

      setAccount(next);
      chainVerifiedRef.current = false;
      walletClientRef.current = null;
    };

    provider?.on?.("accountsChanged", onAccountsChanged);
    return () => provider?.removeListener?.("accountsChanged", onAccountsChanged);
  }, []);

  return { account, status, setStatus, connectWallet, getWalletClient, ensureSomniaWalletChain };
}
