import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useExportWallet,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { arbitrumSepolia } from "viem/chains";
import {
  createWalletClient,
  custom,
  getAddress,
  type EIP1193Provider,
} from "viem";
import { z } from "zod";
import {
  accountSchema,
  address,
  bytes,
  AppError,
  environmentKey,
  sameAddress,
  type AppAccount,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
import { deriveAssetAddress } from "../../../offchain/app-core/src/kernel.js";
import { SiteApi } from "./api.js";
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
const Session = createContext<WalletSession | null>(null);
export function useSession() {
  const value = useContext(Session);
  if (!value) throw new Error("wallet session is unavailable");
  return value;
}
export function WalletProvider({
  environment,
  children,
}: {
  environment: Environment;
  children: ReactNode;
}) {
  return (
    <PrivyProvider
      appId={environment.privyAppId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        defaultChain: arbitrumSepolia,
        supportedChains: [arbitrumSepolia],
        ...(environment.walletConnectProjectId
          ? { walletConnectCloudProjectId: environment.walletConnectProjectId }
          : {}),
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          showWalletUIs: true,
        },
        appearance: {
          theme: "light",
          accentColor: "#1769e0",
          walletChainType: "ethereum-only",
          walletList: [
            "metamask",
            "detected_ethereum_wallets",
            "wallet_connect",
          ],
        },
      }}
    >
      <ConnectedSession environment={environment}>{children}</ConnectedSession>
    </PrivyProvider>
  );
}
function ConnectedSession({
  environment,
  children,
}: {
  environment: Environment;
  children: ReactNode;
}) {
  const privy = usePrivy(),
    { wallets, ready: walletsReady } = useWallets(),
    { exportWallet } = useExportWallet(),
    cache = useQueryClient();
  const api = useMemo(
    () => new SiteApi(environment, privy.getAccessToken),
    [environment, privy.getAccessToken],
  );
  const key = [
    environmentKey(environment),
    "accounts",
    privy.user?.id ?? null,
  ] as const;
  const query = useQuery({
    queryKey: key,
    enabled: privy.ready && privy.authenticated,
    queryFn: ({ signal }) =>
      api.request(
        "/v1/me/accounts",
        z.object({
          accounts: z.array(accountSchema),
          permissions: z.object({ opsRead: z.boolean() }),
        }),
        { auth: true, signal },
      ),
    retry: 1,
    staleTime: 15000,
  });
  const storageKey = `cpredict-account:${api.key}:${privy.user?.id ?? "anonymous"}`;
  const [selected, setSelected] = useState<string | null>(() =>
    sessionStorage.getItem(storageKey),
  );
  useEffect(() => {
    setSelected(sessionStorage.getItem(storageKey));
  }, [storageKey]);
  const accounts = query.data?.accounts ?? [],
    account = accounts.find((a) => a.id === selected) ?? accounts[0] ?? null;
  const controller = async (a: AppAccount) => {
    const wallet = wallets.find((w) => sameAddress(w.address, a.controller));
    if (!wallet) throw new AppError("controller_not_linked", 403);
    await wallet.switchChain(environment.deployment.chainId);
    const provider = await wallet.getEthereumProvider();
    const addresses = z
      .array(address)
      .parse(await provider.request({ method: "eth_accounts" }));
    if (!addresses.some((v) => sameAddress(v, a.controller)))
      throw new AppError("controller_not_linked", 403);
    return provider as EIP1193Provider;
  };
  const value: WalletSession = {
    identityKey: privy.user?.id ?? null,
    ready: privy.ready && walletsReady,
    authenticated: privy.authenticated,
    api,
    accounts,
    account,
    wallets,
    opsRead: query.data?.permissions.opsRead ?? false,
    loading: query.isFetching,
    error: query.error,
    login: () => privy.login(),
    linkWallet: () => privy.linkWallet(),
    logout: async () => {
      await cache.cancelQueries();
      cache.clear();
      setSelected(null);
      sessionStorage.removeItem(storageKey);
      await privy.logout();
    },
    selectAccount: (id) => {
      if (!accounts.some((a) => a.id === id))
        throw new AppError("account_not_found", 404);
      void cache.cancelQueries();
      setSelected(id);
      sessionStorage.setItem(storageKey, id);
    },
    controller,
    bindWallet: async (wallet) => {
      const control = getAddress(wallet.address),
        challenge = await api.request(
          "/v1/me/accounts/challenge",
          z.object({
            id: z.string().uuid(),
            message: z.string().max(8192),
            address,
            controller: address,
            expiresAt: z.string(),
          }),
          { auth: true, body: { controller: control } },
        );
      const derived = await deriveAssetAddress(
        api.publicClient(),
        control,
        environment,
      );
      if (
        !sameAddress(derived, challenge.address) ||
        !sameAddress(control, challenge.controller)
      )
        throw new AppError("account_derivation_mismatch", 409);
      await wallet.switchChain(environment.deployment.chainId);
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({
        account: control,
        chain: arbitrumSepolia,
        transport: custom(provider as EIP1193Provider),
      });
      const signature = bytes.parse(
        await client.signMessage({ message: challenge.message }),
      );
      const result = await api.request(
        "/v1/me/accounts",
        z.object({ account: accountSchema }),
        { auth: true, body: { challengeId: challenge.id, signature } },
      );
      await cache.invalidateQueries({ queryKey: key });
      setSelected(result.account.id);
      sessionStorage.setItem(storageKey, result.account.id);
      return result.account;
    },
    exportController: async () => {
      if (!account || account.walletKind !== "embedded")
        throw new AppError("embedded_wallet_required", 400);
      await exportWallet({ address: account.controller });
    },
  };
  return <Session.Provider value={value}>{children}</Session.Provider>;
}
export const WalletSessionTestProvider = Session.Provider;
