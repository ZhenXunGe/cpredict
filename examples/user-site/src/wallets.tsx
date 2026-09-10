import { lazy, Suspense, type ReactNode } from "react";
import type { Environment } from "../../../offchain/app-core/src/contracts.js";
import { Loading } from "./ui.js";

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

export function WalletProvider({
  environment,
  children,
}: {
  environment: Environment;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<Loading label="正在加载钱包服务" />}>
      <ConnectedWalletProvider environment={environment}>
        {children}
      </ConnectedWalletProvider>
    </Suspense>
  );
}
