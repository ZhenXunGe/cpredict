// Development/test entry only. This file is not a production build input and cannot sign or submit.
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";
import type { PublicClient } from "viem";
import {
  A,
  H,
  env as ctEnv,
  appAccount as ctAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import {
  AppError,
  operationSchema,
  type Deposit,
  type Operation,
} from "../../../../offchain/app-core/src/contracts.js";
import { RECEIVE_TYPEHASH } from "../../../../offchain/app-core/src/usdc.js";
import {
  depositEnvironment,
  fixtureDeposit,
  fixtureWallet,
  fundingState,
  disconnectFunding,
} from "./deposit-fixture.js";
import { computePnl } from "../../../../offchain/app-core/src/pnl.js";
import {
  encodeMarketRules,
  marketRulesSchema,
} from "../../../../offchain/sdk/src/market-rules.js";
import { createSiteQueryClient, SiteLayout } from "../../src/App.js";
import { SiteApi } from "../../src/api.js";
import {
  WalletSessionTestProvider,
  type WalletSession,
} from "../../src/wallets.js";
import { OperationProvider } from "../../src/operations.js";
import { UserOperationClient } from "../../src/operation-client.js";
import { ENTRY_POINT } from "../../../../offchain/app-core/src/kernel.js";
import { MarketsPage } from "../../src/pages/Markets.js";
import { MarketDetailPage } from "../../src/pages/MarketDetail.js";
import { AssetsPage } from "../../src/pages/Assets.js";
import { EntitlementsPage } from "../../src/pages/Entitlements.js";
import { HistoryPage } from "../../src/pages/History.js";
import { HelpPage } from "../../src/pages/Help.js";
import {
  CreatorPage,
  CreateMarketPage,
  CreatorMarketPage,
} from "../../src/pages/Creator.js";
import {
  LeaderboardPage,
  OpsPage,
  FeedbackPage,
} from "../../src/pages/Reports.js";
import "../../src/site.css";
import { reportFixture } from "./report-fixture.js";

const usdc = new URLSearchParams(location.search).get("usdc") === "1";
const env = usdc ? depositEnvironment : ctEnv;
const appAccount = usdc
  ? { ...ctAccount, environment: env.id, index: "1002" }
  : ctAccount;
const controllerWallet = fixtureWallet(appAccount.controller, "metamask"),
  fundingWallet = fixtureWallet(A(30), "rabby");

if (new URLSearchParams(location.search).has("entitlements-test")) {
  // The regression test intercepts this local endpoint; no wallet is involved.
  UserOperationClient.prototype.submit = async function (
    intent,
    onRecord,
    onStage,
  ) {
    onStage("preparing");
    const response = await fetch("/test/entitlement-submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    const record = operationSchema.parse(await response.json());
    onRecord(record);
    return record;
  };
}

let gasFixtureOperation: Operation | null = null;
if (new URLSearchParams(location.search).has("gas-test")) {
  // Test-only simulation of the client boundary. No provider, signing or chain send.
  document.documentElement.dataset.testGasSignatures = "0";
  UserOperationClient.prototype.submit = async function (
    intent,
    onRecord,
    onStage,
    gas,
  ) {
    onStage("preparing");
    if (gas?.payment !== "self-funded")
      throw new AppError("sponsorship_weekly_budget_exhausted", 429);
    gasFixtureOperation = {
      ...operation,
      id: crypto.randomUUID(),
      intent,
      kind: intent.kind,
      gasPayment: "self-funded",
    };
    onRecord(gasFixtureOperation);
    onStage("reviewing-gas");
    await gas.confirm!({ cost: 80000000000000n, balance: 5000000000000000n });
    onStage("awaiting-signature");
    document.documentElement.dataset.testGasSignatures = "1";
    onStage("submitting");
    gasFixtureOperation = {
      ...gasFixtureOperation,
      state: "submitted",
      userOperationHash: H(200),
    };
    onRecord(gasFixtureOperation);
    return gasFixtureOperation;
  };
}

const now = Math.floor(Date.now() / 1000),
  close = now + 86400;
const rules = marketRulesSchema.parse({
  version: "cpredict-rules-v2",
  question: "本周公开测试能否完成全部退出场景？",
  outcomes: ["能够完成", "尚未完成"],
  closeAt: close,
  eventStartsAt: close + 1,
  outcomeDeadlineAt: close + 3600,
  resolutionDeadlineAt: close + 7200,
  resolutionSource: "https://example.com/test-evidence",
  resolutionCriteria: "按预先公布的测试记录核对完整退出流程。",
  cancellationPolicy: "缺少有效测试记录时由创建者按规则作废。",
});
const rulesHash = encodeMarketRules(rules).rulesHash;
const snapshot = {
  environment: env.id,
  deploymentId: env.deployment.id,
  version: 1,
  epoch: "1",
  blockNumber: "100",
  blockHash: H(100),
  timestamp: String(now),
  coverageStart: "1",
  complete: true,
  status: "shadow",
};
const market = {
  chainId: 421614,
  market: A(101),
  creator: appAccount.address,
  creatorTreasury: appAccount.address,
  outcomeCount: 2,
  closeAt: String(close),
  createdAt: String(now - 3600),
  eventStartsAt: String(close + 1),
  outcomeDeadlineAt: String(close + 3600),
  resolutionWindow: "3600",
  rulesHash,
  metadataUri: `https://example.com/v1/markets/${rulesHash}/rules.json`,
  resolutionSourceHash: H(90),
  resolutionSourceUri: rules.resolutionSource,
  featureFlags: "1",
  marketPrimaryCap: "1000000000",
  primaryFilledUnits: "0",
  primaryPayment: "0",
  creatorBond: "10000000",
  state: 0,
  voidReason: 0,
  winningOutcome: null,
  evidenceHash: null,
  createdBlock: "90",
  updatedBlock: "100",
  confirmationStatus: "confirmed",
  question: rules.question,
};
const accounts = [
  appAccount,
  {
    ...appAccount,
    id: "10000000-0000-4000-8000-000000000002",
    controller: A(20),
    address: A(21),
    walletKind: "embedded" as const,
  },
];
class FixtureApi extends SiteApi {
  deposit: Deposit | null = new URLSearchParams(location.search).has("deposit")
    ? {
        ...fixtureDeposit(appAccount),
        ...(new URLSearchParams(location.search).get("deposit") === "unknown"
          ? {
              state: "unknown" as const,
              operationId: operation.id,
              userOperationHash: H(40),
              reason: "provider_result_unknown",
            }
          : {}),
      }
    : null;
  admin = new URLSearchParams(location.search).get("admin") === "1";
  rulesFail = false;
  slow = false;
  pending = false;
  override async request<T>(
    path: string,
    schema: z.ZodType<T>,
    _options: Parameters<SiteApi["request"]>[2] = {},
  ): Promise<T> {
    // Exercise the real HTTP/error boundary with intercepted local responses only.
    // This fixture still cannot sign or submit transactions.
    if (
      _options.service === "metadata" &&
      new URLSearchParams(location.search).has("rules-error")
    )
      return super.request(path, schema, _options);
    if (
      new URLSearchParams(location.search).has("entitlements-test") &&
      /^\/v(?:1\/operations|2\/(?:entitlements|pnl))\b/.test(path)
    )
      return super.request(path, schema, _options);
    const url = new URL(path, "http://fixture.invalid"),
      p = url.pathname;
    if (this.slow) await new Promise((r) => setTimeout(r, 600));
    let result: unknown;
    if (p.startsWith("/v1/operations/") && gasFixtureOperation) {
      if (p.endsWith("/cancel"))
        gasFixtureOperation = { ...gasFixtureOperation, state: "cancelled" };
      result = { operation: gasFixtureOperation };
    } else if (p === "/v1/deposits/prepare") {
      const input = z
        .object({
          accountId: z.string(),
          source: z.string(),
          amount: z.string(),
        })
        .parse(_options.body);
      this.deposit = fixtureDeposit(
        accounts.find((a) => a.id === input.accountId)!,
        input.source as `0x${string}`,
        input.amount,
      );
      result = { deposit: this.deposit };
    } else if (p === "/v1/deposits")
      result = {
        items:
          this.deposit?.accountId === url.searchParams.get("accountId") &&
          this.deposit.state !== "cancelled"
            ? [this.deposit]
            : [],
        nextCursor: null,
      };
    else if (p.startsWith("/v1/deposits/")) {
      if (!this.deposit) throw new AppError("deposit_not_found", 404);
      if (p.endsWith("/cancel"))
        this.deposit = {
          ...this.deposit,
          state: "cancelled",
          reason: "user_cancelled",
        };
      result = { deposit: this.deposit };
    } else if (p === "/v1/feedback")
      result = {
        accepted: true,
        id: z.object({ id: z.string().uuid() }).parse(_options.body).id,
      };
    else if (p === "/v1/telemetry") result = { accepted: true };
    else if (p === "/v2/sync-status")
      result = {
        chainHead: "102",
        applicationConfirmedBlock: "100",
        indexedBlock: "100",
        safeBlock: "98",
        finalizedBlock: null,
        snapshot,
      };
    else if (p === "/v2/markets") {
      const query = url.searchParams.get("q") ?? "",
        status = url.searchParams.get("status");
      result = {
        items:
          (!status || status === "open") && rules.question.includes(query)
            ? [market]
            : [],
        nextCursor: null,
        metadataPending: 0,
        snapshot,
      };
    } else if (p.startsWith("/v2/markets/")) result = market;
    else if (p.startsWith("/v1/markets/")) {
      if (this.rulesFail) throw new AppError("rules_unverified", 409);
      result = rules;
    } else if (p === "/v1/listings")
      result = { items: [], nextCursor: null, snapshot };
    else if (p.startsWith("/v2/pnl/"))
      result = {
        pnl: computePnl(A(11), [], { coverageComplete: true }),
        snapshot,
      };
    else if (p.startsWith("/v2/entitlements/"))
      result = {
        items: [
          {
            id: "early",
            market: A(101),
            kind: "early-bird",
            outcomeId: null,
            listingId: null,
            units: "0",
            amount: "5000000",
            status: "claimable",
            reason: null,
          },
          {
            id: "fees",
            market: null,
            kind: "fees",
            outcomeId: null,
            listingId: null,
            units: null,
            amount: "0",
            status: "claimed",
            reason: null,
          },
        ],
        nextCursor: null,
        snapshot,
      };
    else if (p.startsWith("/v2/activity/"))
      result = { items: [], nextCursor: null, snapshot };
    else if (p === "/v1/operations")
      result = {
        items:
          this.pending && url.searchParams.get("accountId") === appAccount.id
            ? [
                {
                  ...operation,
                  kind: "claim-early-bird",
                  intent: { kind: "claim-early-bird", market: A(101) },
                  state: "unknown",
                  userOperationHash: H(40),
                  reason: "provider_result_unknown",
                },
              ]
            : [],
        nextCursor: null,
      };
    else if (p.startsWith("/v1/operations/"))
      result = {
        operation: {
          ...operation,
          kind: "claim-early-bird",
          intent: { kind: "claim-early-bird", market: A(101) },
          state: "unknown",
          userOperationHash: H(40),
          reason: "provider_result_unknown",
        },
      };
    else if (p === "/v2/leaderboards")
      result = {
        periods: [],
        snapshot: null,
        items: [],
        nextCursor: null,
        status: "awaiting-roster",
      };
    else if (p === "/v1/ops/reports") {
      if (!this.admin) throw new AppError("ops_forbidden", 403);
      result = reportFixture(
        url.searchParams.get("start")!,
        url.searchParams.get("end")!,
      );
    } else if (p === "/v1/ops/feedback") {
      if (!this.admin) throw new AppError("ops_forbidden", 403);
      const second = Boolean(url.searchParams.get("cursor")),
        id = url.searchParams.get("id");
      const record = {
        id: second
          ? "30000000-0000-4000-8000-000000000002"
          : "30000000-0000-4000-8000-000000000001",
        accountId: appAccount.id,
        operationId: operation.id,
        message: second
          ? "第二条测试反馈：领取完成后余额等待同步。"
          : "第一条测试反馈：<script>浏览器必须按文本显示</script>",
        receivedAt: "2026-09-10T03:00:00.000Z",
      };
      result = {
        environment: env.id,
        deploymentId: env.deployment.id,
        snapshotAt: "2026-09-10T04:00:00.000Z",
        items: !id || id === record.id ? [record] : [],
        nextCursor: second || id ? null : "fixture-cursor",
      };
    } else throw new AppError("fixture_does_not_submit", 403);
    return schema.parse(result);
  }
  override publicClient(): PublicClient {
    const readContract = async ({
      address,
      functionName,
      args,
    }: {
      address?: string;
      functionName: string;
      args?: unknown[];
    }) => {
      if (this.slow) await new Promise((r) => setTimeout(r, 600));
      const values: Record<string, unknown> = {
        name: "USD Coin",
        decimals: 6,
        DOMAIN_SEPARATOR:
          "0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb",
        RECEIVE_WITH_AUTHORIZATION_TYPEHASH: RECEIVE_TYPEHASH,
        economics: {
          creatorRakeBps: 100,
          protocolShareBps: 500,
          earlyBirdShareBps: 100,
          platformC2CFeeBps: 25,
          creatorC2CFeeBps: 25,
          protocolTreasury: A(6),
        },
        marketState: 0,
        voidReason: 0,
        winningOutcome: 0,
        closeAt: BigInt(close),
        resolutionDeadline: BigInt(close + 7200),
        minimumPrimaryUnits: 10000n,
        minimumC2CUnits: 10000n,
        totalPrincipal: 0n,
        config: A(77),
        resolutionWindow: 3600n,
        creationFee: 2000000n,
        maxFullMarketCap: 1000000000n,
        maxCloneMarketCap: 1000000000n,
        maxPerUserPrimaryCap: 100000000n,
        maxCreatorRakeBps: 1000,
        maxCreatorC2CFeeBps: 1000,
      };
      if (
        functionName === "balanceOf" &&
        address?.toLowerCase() === ENTRY_POINT.address.toLowerCase()
      )
        return 0n;
      if (functionName === "balanceOf")
        return String(args?.[0]).toLowerCase() === A(21).toLowerCase()
          ? 2000000000n
          : 1000000000n;
      if (functionName in values) return values[functionName];
      throw new AppError("fixture_rpc_not_implemented");
    };
    return {
      readContract,
      getBalance: async () => 5000000000000000n,
      getChainId: async () => 421614,
      getCode: async () => "0x6000",
      getBlock: async () => ({
        number: 100n,
        timestamp: BigInt(now),
        hash: H(100),
      }),
    } as unknown as PublicClient;
  }
}
function Fixture() {
  const [cache] = useState(createSiteQueryClient),
    [api] = useState(
      () =>
        new FixtureApi(
          new URLSearchParams(location.search).get("legacy") === "1"
            ? {
                ...env,
                deployment: { ...env.deployment, protocolVersion: "legacy-v1" },
              }
            : env,
          async () =>
            new URLSearchParams(location.search).has("entitlements-test")
              ? "fixture-token"
              : null,
        ),
    ),
    [logged, setLogged] = useState(true),
    [selected, setSelected] = useState(0),
    [failure, setFailure] = useState(false),
    [slow, setSlow] = useState(false),
    [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false),
    [rejectFunding, setRejectFunding] = useState(false);
  const value = useMemo<WalletSession>(
    () => ({
      identityKey: logged ? "did:privy:fixture" : null,
      ready: true,
      authenticated: logged,
      api,
      accounts: logged ? accounts : [],
      account: logged ? accounts[selected]! : null,
      wallets: usdc
        ? [controllerWallet, ...(connected ? [fundingWallet] : [])]
        : [],
      opsRead: true,
      loading: false,
      error: null,
      login: () => setLogged(true),
      linkWallet: () => {},
      connectFundingWallet: () => {
        fundingState.disconnected = false;
        setConnected(true);
      },
      logout: async () => {
        setLogged(false);
        cache.clear();
      },
      selectAccount: (id) => {
        void cache.cancelQueries();
        setSelected(accounts.findIndex((a) => a.id === id));
      },
      bindWallet: async () => {
        throw new AppError("fixture_does_not_sign");
      },
      controller: async () => {
        throw new AppError("fixture_does_not_sign");
      },
      exportController: async () => {
        throw new AppError("fixture_does_not_export");
      },
    }),
    [logged, selected, api, cache, connected],
  );
  return (
    <QueryClientProvider client={cache}>
      <style>
        {"@media(min-width:851px){.fixture-controls{margin-left:224px}}"}
      </style>
      <HashRouter>
        <WalletSessionTestProvider value={value}>
          <div
            className="fixture-controls"
            style={{
              position: "relative",
              zIndex: 1,
              padding: "8px 16px",
              background: "#fff4dc",
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <strong>浏览器夹具 · 无真实资金或签名</strong>
            {usdc && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={rejectFunding}
                    onChange={(e) => {
                      fundingState.reject = e.target.checked;
                      setRejectFunding(e.target.checked);
                    }}
                  />
                  资金钱包拒签
                </label>
                <button onClick={() => setTimeout(disconnectFunding, 1000)}>
                  1 秒后断开资金钱包
                </button>
                <button
                  onClick={() => {
                    api.environment.features.gaslessDeposit = false;
                    void cache.invalidateQueries();
                    setConnected((v) => !v);
                  }}
                >
                  关闭入金开关
                </button>
              </>
            )}
            <button
              onClick={() => {
                setLogged(!logged);
                cache.clear();
              }}
            >
              {logged ? "夹具退出" : "夹具登录"}
            </button>
            <button onClick={() => setSelected(1 - selected)}>
              切换夹具账户
            </button>
            <button
              onClick={() => setTimeout(() => setSelected((v) => 1 - v), 3000)}
            >
              3 秒后切换账户
            </button>
            <label>
              <input
                type="checkbox"
                checked={failure}
                onChange={(e) => {
                  api.rulesFail = e.target.checked;
                  setFailure(e.target.checked);
                  void cache.resetQueries({ queryKey: [api.key, "rules"] });
                }}
              />
              规则读取失败
            </label>
            <label>
              <input
                type="checkbox"
                checked={slow}
                onChange={(e) => {
                  api.slow = e.target.checked;
                  setSlow(e.target.checked);
                }}
              />
              延迟响应
            </label>
            <label>
              <input
                type="checkbox"
                checked={pending}
                onChange={(e) => {
                  api.pending = e.target.checked;
                  setPending(e.target.checked);
                  void cache.invalidateQueries();
                }}
              />
              存在未知操作
            </label>
          </div>
          <OperationProvider>
            <Routes>
              <Route
                path="/"
                element={<Navigate to={`/${env.id}/markets`} replace />}
              />
              <Route
                path={`/${env.id}`}
                element={<SiteLayout environments={[env]} />}
              >
                <Route path="markets" element={<MarketsPage />} />
                <Route path="markets/:market" element={<MarketDetailPage />} />
                <Route path="assets" element={<AssetsPage />} />
                <Route path="entitlements" element={<EntitlementsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="creator" element={<CreatorPage />} />
                <Route path="creator/new" element={<CreateMarketPage />} />
                <Route path="creator/:market" element={<CreatorMarketPage />} />
                <Route path="leaderboard" element={<LeaderboardPage />} />
                <Route path="ops" element={<OpsPage />} />
                <Route path="help" element={<HelpPage />} />
                <Route path="feedback" element={<FeedbackPage />} />
              </Route>
            </Routes>
          </OperationProvider>
        </WalletSessionTestProvider>
      </HashRouter>
    </QueryClientProvider>
  );
}
const appRoot =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = appRoot;
appRoot.render(<Fixture />);
