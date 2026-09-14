// Browser-only fixture: real WebCrypto/IndexedDB and UI; operation transport is simulated.
// No login provider, real wallet, Paymaster or chain transaction is used here.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type PublicClient } from "viem";
import { z } from "zod";
import {
  A,
  H,
  env,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import {
  AppError,
  quickTradingConfigSchema,
  type BusinessIntent,
  type Operation,
} from "../../../../offchain/app-core/src/contracts.js";
import {
  tradingSessionSchema,
  type TradingSession,
} from "../../../../offchain/app-core/src/trading-session-contracts.js";
import {
  QuickTradingProvider,
  QuickTradingPanel,
  QuickTradingAuthorization,
  useQuickTrading,
} from "../../src/QuickTrading.js";
import {
  WalletSessionTestProvider,
  type WalletSession,
} from "../../src/wallet-session.js";
import { OperationProvider, useOperation } from "../../src/operations.js";
import { UserOperationClient } from "../../src/operation-client.js";
import { SiteApi } from "../../src/api.js";
import {
  clearUserTradingSessions,
  loadTradingSession,
  saveTradingSession,
  type BrowserTradingSession,
} from "../../src/trading-session-storage.js";
import { Button, ErrorNotice } from "../../src/ui.js";
import "../../src/site.css";

const environment = {
  ...env,
  quickTrading: quickTradingConfigSchema.parse({
    enabled: true,
    version: 1,
    policy: A(101),
    policyCodeHash: H(1),
    signer: A(102),
    signerCodeHash: H(2),
    paymaster: A(103),
  }),
};
const api = new SiteApi(environment, async () => "fixture-only");
const identity = "browser-fixture-user",
  metadataKey = "session-fixture-public-metadata";
const read = () =>
  JSON.parse(localStorage.getItem(metadataKey) ?? "[]") as TradingSession[];
const write = (records: TradingSession[]) =>
  localStorage.setItem(metadataKey, JSON.stringify(records));
let last: Operation | null = null;
api.request = async <T,>(path: string, schema: z.ZodType<T>) => {
  const records = read();
  let result: unknown;
  if (path === "/v1/trading-sessions/disable-all") {
    write(records.map((s) => ({ ...s, state: "disabled" })));
    result = { disabled: true };
  } else if (path.startsWith("/v1/trading-sessions?"))
    result = { items: records };
  else if (path.startsWith("/v1/trading-sessions/")) {
    const id = path.split("/")[3],
      s = records.find((s) => s.id === id);
    if (!s) throw new AppError("trading_session_not_found", 404);
    if (path.endsWith("/disable")) {
      s.state = "disabled";
      write(records);
      result = { session: s };
    } else result = { session: s, spent: "0", pending: "0", revoked: false };
  } else if (path.startsWith("/v1/operations/")) result = { operation: last };
  else throw new AppError("fixture_unsupported", 400);
  return schema.parse(result);
};
api.publicClient = () =>
  ({
    getBalance: async () => 10n ** 18n,
    readContract: async () => 0n,
  }) as unknown as PublicClient;
let localSigns = 0,
  controllerRequests = 0;
const counters = () => {
  document.documentElement.dataset.localSigns = String(localSigns);
  document.documentElement.dataset.controllerRequests =
    String(controllerRequests);
};
counters();
// Exercise the production confirmation UI and the real credential/expiry checks;
// signing transport itself is covered by operation-client tests and the Kernel fork.
UserOperationClient.prototype.submit = async function (
  intent,
  onRecord,
  onStage,
  gas,
) {
  const credential = (
    this as unknown as {
      sessionCredential?: (
        intent: BusinessIntent,
      ) => Promise<BrowserTradingSession>;
    }
  ).sessionCredential;
  onStage("preparing");
  if (credential) {
    if (gas?.payment === "self-funded")
      throw new AppError("trading_session_requires_sponsorship", 409);
    await credential(intent);
    localSigns++;
  } else controllerRequests++;
  counters();
  onStage("submitting");
  last = {
    ...operation,
    id: crypto.randomUUID(),
    intent,
    kind: intent.kind,
    state: "submitted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    gasPayment: gas?.payment ?? "sponsored",
    userOperationHash: H(20),
  };
  onRecord(last);
  return last;
};
async function seed() {
  const privateKey = generatePrivateKey(),
    signer = privateKeyToAccount(privateKey),
    now = Math.floor(Date.now() / 1000);
  const session = tradingSessionSchema.parse({
    id: crypto.randomUUID(),
    accountId: appAccount.id,
    account: appAccount.address,
    controller: appAccount.controller,
    environment: env.id,
    deploymentId: env.deployment.id,
    publicKey: signer.address,
    permissionId: "0x10203040",
    config: environment.quickTrading,
    perOperation: "100000000",
    total: "1000000000",
    validAfter: String(now),
    validUntil: String(now + 86400),
    createdAt: new Date().toISOString(),
    state: "active",
    authorizationHash: H(1),
  });
  write([...read(), session]);
  await saveTradingSession(identity, api, {
    session: { ...session, state: "prepared" },
    privateKey,
    enableSignature: "0x",
  });
  await saveTradingSession(identity, api, {
    session,
    privateKey,
    enableSignature: `0x${"11".repeat(65)}`,
  });
}
function Controls() {
  const quick = useQuickTrading()!,
    begin = useOperation(),
    [error, setError] = useState<unknown>(null);
  return (
    <main className="page stack">
      <h1>快捷交易浏览器验收夹具</h1>
      <p>真实浏览器存储与确认 UI，模拟交易传输。</p>
      <Button onClick={() => void seed().catch(setError)}>写入测试授权</Button>
      <Button
        onClick={() =>
          begin({
            intent: {
              kind: "buy",
              market: A(10),
              outcomeId: "0",
              units: "10000000",
              minUnits: "10000000",
              maxPayment: "10000000",
              deadline: "2000000000",
            },
            summary: [{ label: "购买金额", value: "10 ctUSD" }],
            feeNote: "测试买入",
          })
        }
      >
        购买 10 ctUSD
      </Button>
      <Button
        onClick={() =>
          void clearUserTradingSessions(identity, api)
            .then(() => quick.refresh())
            .catch(setError)
        }
      >
        退出并清理测试会话
      </Button>
      <output data-testid="restored">
        {quick.local ? "本地会话已恢复" : "无本地会话"}
      </output>
      <ErrorNotice error={error} />
      <QuickTradingPanel />
      <QuickTradingAuthorization />
    </main>
  );
}
const wallet: WalletSession = {
  identityKey: identity,
  ready: true,
  authenticated: true,
  api,
  accounts: [appAccount],
  account: {
    ...appAccount,
    walletKind:
      new URLSearchParams(location.search).get("wallet") === "embedded"
        ? "embedded"
        : "external",
  },
  wallets: [],
  opsRead: false,
  loading: false,
  error: null,
  login: () => {},
  linkWallet: () => {},
  connectFundingWallet: () => {},
  logout: () => clearUserTradingSessions(identity, api),
  selectAccount: () => {},
  bindWallet: async () => appAccount,
  controller: async () => {
    controllerRequests++;
    counters();
    throw new Error("fixture cannot request a real wallet");
  },
  exportController: async () => {},
};
// Public verification helpers return booleans only, never credentials.
Object.assign(window, {
  sessionStorageProof: async () => {
    const local = await loadTradingSession(identity, api, appAccount.id);
    const otherUser = await loadTradingSession(
      "other-user",
      api,
      appAccount.id,
    );
    const otherAccount = await loadTradingSession(
      identity,
      api,
      "20000000-0000-4000-8000-000000000001",
    );
    const changed = new SiteApi({ ...environment, id: "other-env" });
    const otherEnvironment = await loadTradingSession(
      identity,
      changed,
      appAccount.id,
    );
    return {
      restored: !!local,
      otherUser: !!otherUser,
      otherAccount: !!otherAccount,
      otherEnvironment: !!otherEnvironment,
    };
  },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <HashRouter>
      <WalletSessionTestProvider value={wallet}>
        <QuickTradingProvider>
          <OperationProvider>
            <Controls />
          </OperationProvider>
        </QuickTradingProvider>
      </WalletSessionTestProvider>
    </HashRouter>
  </QueryClientProvider>,
);
