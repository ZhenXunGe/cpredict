import { createContext, useContext } from "react";
import type { ConnectedWallet } from "@privy-io/react-auth";
import type { EIP1193Provider } from "viem";
import type { AppAccount } from "../../../offchain/app-core/src/contracts.js";
import type { SiteApi } from "./api.js";

export interface WalletSession {
  identityKey: string | null;
  ready: boolean;
  authenticated: boolean;
  api: SiteApi;
  accounts: AppAccount[];
  account: AppAccount | null;
  wallets: ConnectedWallet[];
  opsRead: boolean;
  loading: boolean;
  error: unknown;
  login(): void;
  linkWallet(): void;
  logout(): Promise<void>;
  selectAccount(id: string): void;
  bindWallet(wallet: ConnectedWallet): Promise<AppAccount>;
  controller(account: AppAccount): Promise<EIP1193Provider>;
  exportController(): Promise<void>;
}

export const Session = createContext<WalletSession | null>(null);
export function useSession() {
  const value = useContext(Session);
  if (!value) throw new Error("wallet session is unavailable");
  return value;
}
export const WalletSessionTestProvider = Session.Provider;
