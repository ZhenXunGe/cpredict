import { listingFeedbackResponse } from "./listing-feedback-fixture.js";
import { historyFeedbackResponse } from "./history-feedback-fixture.js";
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
const positionsTest = new URLSearchParams(location.search).has(
  "positions-test",
);
const timeoutFundingRole = new URLSearchParams(location.search).get(
  "timeout-funding",
);
const historyView = new URLSearchParams(location.search).has("historical-view");
const orderbookTest = new URLSearchParams(location.search).has(
  "orderbook-test",
);
const env = orderbookTest
  ? {
      ...ctEnv,
      deployment: {
        ...ctEnv.deployment,
        marketplaceVersion: "orderbook-v2" as const,
      },
      features: { ...ctEnv.features, automaticClaims: true },
    }
  : historyView
    ? {
        ...ctEnv,
        historical: true,
        quickTrading: undefined,
        features: { ...ctEnv.features, newExposure: false, faucet: false },
      }
    : usdc
      ? depositEnvironment
      : ctEnv;
const historicalEnv = {
  ...ctEnv,
  id: "ctusd-history",
  historical: true,
  deployment: {
    ...ctEnv.deployment,
    id: "historical-deployment",
    factory: A(99),
  },
  services: {
    app: "/historical/app",
    indexer: "/historical/indexer",
    metadata: "/historical/metadata",
    rpc: "/historical/rpc",
  },
  quickTrading: undefined,
  features: { ...ctEnv.features, newExposure: false, faucet: false },
};
const multipleFees = new URLSearchParams(location.search).has("multiple-fees");
const appAccount = usdc
  ? { ...ctAccount, environment: env.id, index: "1002" }
  : ctAccount;
const controllerWallet = fixtureWallet(appAccount.controller, "metamask"),
  fundingWallet = fixtureWallet(A(30), "rabby");

if (
  new URLSearchParams(location.search).has("entitlements-test") ||
  new URLSearchParams(location.search).has("creator-redirect")
) {
  // The regression test intercepts this local endpoint; no wallet is involved.
  UserOperationClient.prototype.submit = async function (
    intent,
    onRecord,
    onStage,
  ) {
    onStage("preparing");
    const response = await fetch(
      new URLSearchParams(location.search).has("creator-redirect")
        ? "/test/creator-submit"
        : "/test/entitlement-submit",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent }),
      },
    );
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

const timeoutScenario = new URLSearchParams(location.search).get(
  "timeout-test",
);
const creatorSummary = new URLSearchParams(location.search).get(
  "creator-summary",
);
const creatorResolved = ["resolved", "multi", "unavailable"].includes(
  creatorSummary ?? "",
);
const creatorPrincipals =
  creatorSummary === "zero"
    ? [0n, 0n]
    : creatorSummary === "multi"
      ? [1250000n, 2000000n, 3750000n]
      : [1250000n, 3750000n];
const now = Math.floor(Date.now() / 1000),
  close = timeoutScenario
    ? now -
      7200 +
      (timeoutScenario === "before"
        ? new URLSearchParams(location.search).has("timeout-countdown")
          ? 30
          : 1
        : 0)
    : now + 86400;
const rules = marketRulesSchema.parse({
  version: "cpredict-rules-v2",
  question: "本周公开测试能否完成全部退出场景？",
  outcomes: creatorSummary
    ? creatorSummary === "multi"
      ? ["甲", "乙", "丙"]
      : ["是", "否"]
    : ["能够完成", "尚未完成"],
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
  outcomeCount: rules.outcomes.length,
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
  state: creatorResolved ? 1 : 0,
  voidReason: 0,
  winningOutcome: creatorResolved
    ? creatorSummary === "multi"
      ? "2"
      : "1"
    : null,
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
  positionSettled = false;
  timeoutFundingReady = false;
  override async request<T>(
    path: string,
    schema: z.ZodType<T>,
    _options: Parameters<SiteApi["request"]>[2] = {},
  ): Promise<T> {
    if (
      orderbookTest &&
      (path.startsWith("/v2/orders") || path.startsWith("/v1/automatic-claims"))
    )
      return super.request(path, schema, _options);
    // Exercise the real HTTP/error boundary with intercepted local responses only.
    // This fixture still cannot sign or submit transactions.
    if (
      _options.service === "metadata" &&
      new URLSearchParams(location.search).has("rules-error")
    )
      return super.request(path, schema, _options);
    if (
      new URLSearchParams(location.search).has("creator-redirect") &&
      (path.startsWith("/v1/operations/") || path.startsWith("/v2/markets?"))
    )
      return super.request(path, schema, _options);
    if (
      new URLSearchParams(location.search).has("entitlements-test") &&
      /^\/v(?:1\/operations|2\/(?:entitlements|pnl))\b/.test(path)
    )
      return super.request(path, schema, _options);
    if (
      new URLSearchParams(location.search).has("history-test") &&
      /^\/v(?:1\/operations|2\/(?:activity|pnl|markets))\b/.test(path)
    )
      return super.request(path, schema, _options);
    const url = new URL(path, "http://fixture.invalid"),
      p = url.pathname;
    if (new URLSearchParams(location.search).has("listing-feedback")) {
      const feedback = listingFeedbackResponse(
        url,
        snapshot,
        market,
        new URLSearchParams(location.search).get("listing-feedback")!,
      );
      if (feedback !== undefined) return schema.parse(feedback);
    }
    if (new URLSearchParams(location.search).has("history-feedback")) {
      const feedback = historyFeedbackResponse(url, snapshot);
      if (feedback !== undefined) return schema.parse(feedback);
    }
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
    else if (p === "/v2/platform-fees")
      result = {
        accrued: "20000000",
        complete: !new URLSearchParams(location.search).has(
          "platform-fees-incomplete",
        ),
        snapshot,
      };
    else if (p === "/v2/markets") {
      const query = url.searchParams.get("q") ?? "",
        status = url.searchParams.get("status"),
        paginationTest = new URLSearchParams(location.search).has(
          "pagination-test",
        );
      result = {
        items:
          (!status || status === "open") && rules.question.includes(query)
            ? paginationTest
              ? Array.from({ length: 12 }, (_, index) => ({
                  ...market,
                  market: A(101 + index),
                  createdBlock: String(90 - index),
                }))
              : [market]
            : [],
        nextCursor: null,
        metadataPending: 0,
        snapshot,
      };
    } else if (p.startsWith("/v2/markets/")) {
      if (new URLSearchParams(location.search).has("delay-market-details"))
        await new Promise((resolve) => setTimeout(resolve, 1500));
      const requestedMarket = p.slice("/v2/markets/".length).toLowerCase();
      result =
        positionsTest && requestedMarket === A(102).toLowerCase()
          ? {
              ...market,
              market: A(102),
              state: this.positionSettled ? 1 : 0,
              question: "仍在进行的测试市场",
            }
          : positionsTest && requestedMarket === A(103).toLowerCase()
            ? {
                ...market,
                market: A(103),
                state: 2,
                voidReason: 3,
                question: "已作废的测试市场",
              }
            : positionsTest
              ? { ...market, state: 1, question: "已结算的测试市场" }
              : new URLSearchParams(location.search).has(
                    "multiple-owner-bids",
                  ) && requestedMarket === A(102).toLowerCase()
                ? {
                    ...market,
                    market: A(102),
                    question: "主播今晚直播间是否会超过30万人？",
                  }
                : { ...market, question: rules.question };
    } else if (p.startsWith("/v1/markets/")) {
      if (this.rulesFail) throw new AppError("rules_unverified", 409);
      result = rules;
    } else if (p === "/v1/listings")
      result = {
        items: new URLSearchParams(location.search).has("c2c-price")
          ? [
              {
                chainId: market.chainId,
                listingId: H(55),
                vault: A(101),
                seller: A(99),
                outcomeId: "1",
                remainingUnits: "10000000",
                unitPrice: new URLSearchParams(location.search).get(
                  "c2c-price",
                ),
                expiresAt: String(now + 86400),
                active: true,
                updatedBlock: "100",
              },
            ]
          : [],
        nextCursor: null,
        snapshot,
      };
    else if (p.startsWith("/v2/pnl/"))
      result = {
        pnl: {
          ...computePnl(A(11), [], { coverageComplete: true }),
          ...(positionsTest
            ? {
                lots: [
                  ...(new URLSearchParams(location.search).has("both-outcomes")
                    ? [
                        {
                          market: A(102),
                          outcomeId: "0",
                          units: "3000000",
                          escrowUnits: "0",
                          knownCost: "3000000",
                          costComplete: true,
                        },
                      ]
                    : []),
                  {
                    market: A(103),
                    outcomeId: "0",
                    units: "5000000",
                    escrowUnits: "0",
                    knownCost: "5000000",
                    costComplete: true,
                  },
                  {
                    market: A(101),
                    outcomeId: "0",
                    units: "10",
                    escrowUnits: "0",
                    knownCost: "1000000",
                    costComplete: true,
                  },
                  {
                    market: A(102),
                    outcomeId: "1",
                    units: "20",
                    escrowUnits: "0",
                    knownCost: "2000000",
                    costComplete: true,
                  },
                ],
              }
            : {}),
        },
        snapshot,
      };
    else if (p.startsWith("/v2/entitlements/"))
      result = {
        items: timeoutFundingRole
          ? [
              ...(timeoutFundingRole === "before-refund"
                ? [
                    {
                      id: "timeout-refund",
                      market: A(101),
                      kind: "refund",
                      outcomeId: null,
                      listingId: null,
                      units: "1000000",
                      amount: "1000000",
                      status: "claimable",
                      reason: "principal_first_then_timeout_compensation",
                    },
                  ]
                : []),
              {
                id: "timeout-funding",
                market: A(101),
                kind:
                  timeoutFundingRole === "creator" ? "bond" : "timeout-bonus",
                outcomeId: null,
                listingId: null,
                units: timeoutFundingRole === "creator" ? null : "1000000",
                amount:
                  timeoutFundingRole === "creator" || !this.timeoutFundingReady
                    ? "0"
                    : "2000000",
                status:
                  timeoutFundingRole === "creator"
                    ? this.timeoutFundingReady
                      ? "claimed"
                      : "conditional"
                    : this.timeoutFundingReady &&
                        timeoutFundingRole !== "before-refund"
                      ? "claimable"
                      : "conditional",
                reason:
                  timeoutFundingRole === "creator"
                    ? this.timeoutFundingReady
                      ? "bond_slashed_into_timeout_pool"
                      : "bond_slashed_pending_timeout_funding"
                    : this.timeoutFundingReady
                      ? timeoutFundingRole === "before-refund"
                        ? "refund_before_timeout_compensation"
                        : null
                      : timeoutFundingRole === "before-refund"
                        ? "refund_and_funding_before_timeout_compensation"
                        : "waiting_for_timeout_bond_funding",
              },
            ]
          : positionsTest
            ? [
                ...(new URLSearchParams(location.search).has("both-outcomes")
                  ? [
                      {
                        id: "open-holding-other-outcome",
                        market: A(102),
                        kind: "holding",
                        outcomeId: "0",
                        listingId: null,
                        units: "3000000",
                        amount: null,
                        status: "conditional",
                        reason: null,
                      },
                    ]
                  : []),
                {
                  id: "voided-holding",
                  market: A(103),
                  kind: "holding",
                  outcomeId: "0",
                  listingId: null,
                  units: "5000000",
                  amount: null,
                  status: "conditional",
                  reason: null,
                },
                {
                  id: "voided-refund",
                  market: A(103),
                  kind: "refund",
                  outcomeId: null,
                  listingId: null,
                  units: "5000000",
                  amount: "5000000",
                  status: "claimable",
                  reason: "principal_first_then_timeout_compensation",
                },
                {
                  id: "settled-holding",
                  market: A(101),
                  kind: "holding",
                  outcomeId: "0",
                  listingId: null,
                  units: "10",
                  amount: null,
                  status: "conditional",
                  reason: null,
                },
                {
                  id: "open-holding",
                  market: A(102),
                  kind: "holding",
                  outcomeId: "1",
                  listingId: null,
                  units: "20",
                  amount: null,
                  status: "conditional",
                  reason: null,
                },
                {
                  id: "settled-winner",
                  market: A(101),
                  kind: "winner",
                  outcomeId: "0",
                  listingId: null,
                  units: "10",
                  amount: "1000000",
                  status: "claimable",
                  reason: null,
                },
              ]
            : [
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
    else if (p === "/v2/leaderboards") {
      const named = new URLSearchParams(location.search).has("named-roster");
      const period = {
        id: "test-period",
        startsAt: "100",
        endsAt: "200",
        publishedAt: "50",
        markets: [{ market: A(101), startsAt: "100" }],
      };
      result = {
        periods: named ? [period] : [],
        snapshot: named
          ? {
              id: "50000000-0000-4000-8000-000000000001",
              period,
              version: 1,
              statisticsVersion: "weighted-average-v1",
              data: snapshot,
              createdAt: "2026-09-15T00:00:00.000Z",
              excluded: [],
              correction: null,
            }
          : null,
        items: [],
        nextCursor: null,
        status: named ? "available" : "awaiting-roster",
      };
    } else if (p === "/v1/ops/reports") {
      if (!this.admin) throw new AppError("ops_forbidden", 403);
      const report = reportFixture(
        url.searchParams.get("start")!,
        url.searchParams.get("end")!,
      );
      const feeCoverage = new URLSearchParams(location.search).get(
        "platform-fee-coverage",
      );
      if (feeCoverage === "partial")
        report.fees.platformLifetime!.complete = false;
      if (feeCoverage === "unavailable") report.fees.platformLifetime = null;
      result = report;
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
      blockNumber,
    }: {
      address?: string;
      functionName: string;
      args?: unknown[];
      blockNumber?: bigint;
    }) => {
      if (functionName === "listings")
        return [A(101), A(99), 0n, 1500000n, 1999999999n, 1, false];
      if (this.slow) await new Promise((r) => setTimeout(r, 600));
      if (
        creatorSummary &&
        ["totalPrincipal", "principalByOutcome"].includes(functionName) &&
        blockNumber !== 100n
      )
        throw new AppError("fixture_requires_same_block");
      if (functionName === "principalByOutcome") {
        if (creatorSummary === "unavailable")
          throw new AppError("service_unavailable", 503);
        return creatorSummary ? creatorPrincipals[Number(args?.[0])] : 0n;
      }
      const feeScenario = new URLSearchParams(location.search).get("fee-test");
      if (
        feeScenario === "unavailable" &&
        ["economics", "protocolShareBps", "platformC2CFeeBps"].includes(
          functionName,
        )
      )
        throw new AppError("fixture_fees_unavailable");
      const timeoutVoided =
        timeoutScenario === "voided" ||
        document.documentElement.dataset.testTimeoutVoided === "1";
      const values: Record<string, unknown> = {
        perUserPrimaryCap: new URLSearchParams(location.search).has("cap-test")
          ? 10000000n
          : 100000000n,
        marketPrimaryCap: 1000000000n,
        cumulativePrimaryBought:
          new URLSearchParams(location.search).get("cap-test") ===
          "account-full"
            ? 10000000n
            : 0n,
        earlyBirdEnabled: true,
        supportsPerMarketPlatformFees: !new URLSearchParams(
          location.search,
        ).has("old-factory"),
        name: "USD Coin",
        decimals: 6,
        DOMAIN_SEPARATOR:
          "0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb",
        RECEIVE_WITH_AUTHORIZATION_TYPEHASH: RECEIVE_TYPEHASH,
        economics: {
          creatorRakeBps: 100,
          protocolShareBps: 500,
          earlyBirdShareBps: 100,
          platformC2CFeeBps: feeScenario === "zero" ? 0 : 25,
          creatorC2CFeeBps: 25,
          protocolTreasury: A(6),
        },
        marketState: timeoutVoided
          ? this.environment.deployment.protocolVersion === "legacy-v1"
            ? 3
            : 2
          : creatorResolved
            ? 1
            : 0,
        voidReason: timeoutVoided ? 3 : 0,
        winningOutcome: creatorResolved
          ? creatorSummary === "multi"
            ? 2
            : 1
          : 0,
        closeAt: BigInt(close),
        resolutionDeadline: BigInt(close + 7200),
        minimumPrimaryUnits: 10000n,
        minimumC2CUnits: 10000n,
        totalPrincipal:
          new URLSearchParams(location.search).get("cap-test") === "market-full"
            ? 1000000000n
            : creatorSummary
              ? creatorPrincipals.reduce((a, b) => a + b, 0n)
              : 0n,
        config: A(77),
        resolutionWindow: 3600n,
        creationFee: 2000000n,
        protocolShareBps: 2000,
        platformC2CFeeBps: feeScenario === "zero" ? 0 : 50,
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
      if (
        functionName === "balanceOf" &&
        address?.toLowerCase() ===
          this.environment.deployment.paymentToken.toLowerCase() &&
        new URLSearchParams(location.search).has("low-asset-balance")
      )
        return 500000n;
      if (
        functionName === "balanceOf" &&
        new URLSearchParams(location.search).has("no-shares")
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
  const [cache] = useState(() => {
      const value = createSiteQueryClient();
      if (multipleFees)
        value.setQueryData(["site-config"], {
          version: 1,
          defaultEnvironment: env.id,
          environments: [env],
          historicalEnvironments: [historicalEnv],
        });
      return value;
    }),
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
            [
              "entitlements-test",
              "history-test",
              "creator-redirect",
              "orderbook-test",
            ].some((key) => new URLSearchParams(location.search).has(key))
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
      opsRead: !new URLSearchParams(location.search).has("ordinary-creator"),
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
            {timeoutFundingRole && (
              <button
                onClick={() => {
                  api.timeoutFundingReady = true;
                  void cache.invalidateQueries();
                }}
              >
                补偿池已注入（夹具）
              </button>
            )}
            {positionsTest && (
              <button
                onClick={() => {
                  api.positionSettled = true;
                }}
              >
                结算夹具市场
              </button>
            )}
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
                element={
                  <SiteLayout
                    environments={multipleFees ? [env, historicalEnv] : [env]}
                  />
                }
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
