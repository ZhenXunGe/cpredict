import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
  type Account,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ARBITRUM_SEPOLIA_CHAIN_ID, type RuntimeConfig } from "./config.js";

export interface WalletProviderInfo {
  uuid: string;
  name: string;
  icon: string | null;
  rdns: string;
}

export interface DiscoveredWallet {
  info: WalletProviderInfo;
  provider: EIP1193Provider;
}

interface Eip6963AnnounceDetail {
  info: WalletProviderInfo;
  provider: EIP1193Provider;
}

export interface ConnectedWallet {
  provider: DiscoveredWallet;
  account: Account;
  address: Address;
  chainId: number;
  walletClient: WalletClient;
}

export const arbitrumSepolia = defineChain({
  id: ARBITRUM_SEPOLIA_CHAIN_ID,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] },
  },
  blockExplorers: {
    default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" },
  },
  testnet: true,
});

export function createProtocolPublicClient(config: RuntimeConfig): PublicClient {
  return createPublicClient({
    chain: arbitrumSepolia,
    transport: http(config.chain.rpcPath, {
      retryCount: 1,
      timeout: 15_000,
    }),
    batch: { multicall: true },
  });
}

export function discoverWallets(onUpdate: (wallets: DiscoveredWallet[]) => void): () => void {
  const discovered = new Map<string, DiscoveredWallet>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963AnnounceDetail>).detail;
    if (!isProviderDetail(detail)) return;
    discovered.set(detail.info.uuid, { info: detail.info, provider: detail.provider });
    onUpdate([...discovered.values()]);
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  const legacy = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (legacy !== undefined && ![...discovered.values()].some((wallet) => wallet.provider === legacy)) {
    discovered.set("legacy-window-ethereum", {
      info: {
        uuid: "legacy-window-ethereum",
        name: "Browser Wallet",
        icon: null,
        rdns: "legacy.window.ethereum",
      },
      provider: legacy,
    });
    onUpdate([...discovered.values()]);
  }
  return () => window.removeEventListener("eip6963:announceProvider", announce);
}

export function watchWallet(
  connected: ConnectedWallet,
  onAccountChanged: (address: Address | null) => void,
  onChainChanged: (chainId: number) => void,
): () => void {
  type ObservableProvider = EIP1193Provider & {
    on?: (event: string, listener: (value: unknown) => void) => void;
    removeListener?: (event: string, listener: (value: unknown) => void) => void;
  };
  const provider = connected.provider.provider as ObservableProvider;
  const accountsChanged = (value: unknown) => {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      onAccountChanged(null);
      return;
    }
    try { onAccountChanged(getAddress(value[0])); } catch { onAccountChanged(null); }
  };
  const chainChanged = (value: unknown) => {
    if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) {
      onChainChanged(Number.parseInt(value, 16));
    }
  };
  provider.on?.("accountsChanged", accountsChanged);
  provider.on?.("chainChanged", chainChanged);
  return () => {
    provider.removeListener?.("accountsChanged", accountsChanged);
    provider.removeListener?.("chainChanged", chainChanged);
  };
}

export async function connectWallet(wallet: DiscoveredWallet): Promise<ConnectedWallet> {
  const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("wallet returned no account");
  }
  const address = getAddress(accounts[0]);
  const account = { address, type: "json-rpc" } as const satisfies Account;
  const chainId = await readProviderChainId(wallet.provider);
  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: custom(wallet.provider),
  });
  return { provider: wallet, account, address, chainId, walletClient };
}

export async function switchToArbitrumSepolia(provider: EIP1193Provider): Promise<number> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${ARBITRUM_SEPOLIA_CHAIN_ID.toString(16)}` }],
    });
  } catch (error: unknown) {
    if (!isUnknownChainError(error)) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${ARBITRUM_SEPOLIA_CHAIN_ID.toString(16)}`,
          chainName: "Arbitrum Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
          blockExplorerUrls: ["https://sepolia.arbiscan.io"],
        },
      ],
    });
  }
  return readProviderChainId(provider);
}

export async function readProviderChainId(provider: EIP1193Provider): Promise<number> {
  const value = await provider.request({ method: "eth_chainId" });
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("wallet returned invalid chain id");
  }
  return Number.parseInt(value, 16);
}

function isProviderDetail(value: unknown): value is Eip6963AnnounceDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Partial<Eip6963AnnounceDetail>;
  return (
    typeof detail.info?.uuid === "string" &&
    typeof detail.info.name === "string" &&
    typeof detail.info.rdns === "string" &&
    typeof detail.provider?.request === "function"
  );
}

function isUnknownChainError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 4902
  );
}
