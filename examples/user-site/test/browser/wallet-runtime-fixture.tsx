// Browser-test supplier only; never included in the production entrypoints.
import { useState, type ReactNode } from "react";
import type { Environment } from "../../../../offchain/app-core/src/contracts.js";
import { SiteApi } from "../../src/api.js";
import { Session, type WalletSession } from "../../src/wallet-session.js";

export function ConnectedWalletProvider({
  environment,
  children,
}: {
  environment: Environment;
  children: ReactNode;
}) {
  const [authenticated, setAuthenticated] = useState(true);
  const [api] = useState(() => new SiteApi(environment, async () => "fixture"));
  const unavailable = (): never => {
    throw new Error("This fixture cannot sign or submit");
  };
  const session: WalletSession = {
    identityKey: authenticated ? "restored-test-user" : null,
    ready: true,
    authenticated,
    api,
    accounts: [],
    account: null,
    wallets: [],
    opsRead: false,
    loading: false,
    error: null,
    login: () => setAuthenticated(true),
    logout: async () => setAuthenticated(false),
    linkWallet: unavailable,
    connectFundingWallet: unavailable,
    selectAccount: unavailable,
    bindWallet: unavailable,
    controller: unavailable,
    exportController: unavailable,
  };
  return (
    <Session.Provider value={session}>
      <button
        style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1000 }}
        onClick={() => setAuthenticated(false)}
      >
        测试退出会话
      </button>
      {children}
    </Session.Provider>
  );
}
