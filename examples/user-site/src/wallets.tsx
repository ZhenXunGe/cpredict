import {
  Component,
  lazy,
  memo,
  Suspense,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Environment } from "../../../offchain/app-core/src/contracts.js";
import { SiteApi } from "./api.js";
import { Session, useSession, type WalletSession } from "./wallet-session.js";

export {
  useSession,
  WalletSessionTestProvider,
  type WalletSession,
} from "./wallet-session.js";

// Load the supplier only after configuration selects an actual environment.
// Session ownership and the supplier's login/restore behavior stay together.
const ConnectedWalletProvider = lazy(() =>
  import("./connected-wallets.js").then((module) => ({
    default: module.ConnectedWalletProvider,
  })),
);

class WalletRuntimeBoundary extends Component<
  { children: ReactNode; onUnavailable(): void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onUnavailable();
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wallet-load-notice" role="alert">
        <span>钱包连接暂时未就绪，你可以继续浏览市场。</span>
        <button
          className="button button-secondary"
          onClick={() => window.location.reload()}
        >
          刷新重试
        </button>
      </div>
    );
  }
}

function publishUnavailable(): never {
  throw new Error("钱包服务尚未就绪，请稍后重试");
}

function SessionRelay({
  publish,
}: {
  publish: (value: WalletSession) => void;
}) {
  const session = useSession();
  useLayoutEffect(() => publish(session), [publish, session]);
  return null;
}

// Keep the supplier mounted independently of public content. Memoization also
// prevents publishing a session from rendering the supplier again in a loop.
const WalletRuntime = memo(function WalletRuntime({
  environment,
  publish,
}: {
  environment: Environment;
  publish: (value: WalletSession) => void;
}) {
  return (
    <Suspense fallback={null}>
      <ConnectedWalletProvider environment={environment}>
        <SessionRelay publish={publish} />
      </ConnectedWalletProvider>
    </Suspense>
  );
});

export function WalletProvider({
  environment,
  children,
}: {
  environment: Environment;
  children: ReactNode;
}) {
  const [connected, publish] = useState<WalletSession | null>(null);
  const browsing = useMemo<WalletSession>(
    () => ({
      identityKey: null,
      ready: false,
      authenticated: false,
      api: new SiteApi(environment),
      accounts: [],
      account: null,
      wallets: [],
      opsRead: false,
      loading: true,
      error: null,
      login: publishUnavailable,
      linkWallet: publishUnavailable,
      connectFundingWallet: publishUnavailable,
      logout: publishUnavailable,
      selectAccount: publishUnavailable,
      bindWallet: publishUnavailable,
      controller: publishUnavailable,
      exportController: publishUnavailable,
    }),
    [environment],
  );
  return (
    <Session.Provider value={connected ?? browsing}>
      {children}
      <WalletRuntimeBoundary onUnavailable={() => publish(null)}>
        <WalletRuntime environment={environment} publish={publish} />
      </WalletRuntimeBoundary>
    </Session.Provider>
  );
}
