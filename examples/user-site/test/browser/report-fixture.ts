import { opsReportSchema } from "../../../../offchain/app-core/src/report-contracts.js";
import { env } from "../../../../offchain/app-core/test/fixtures.js";

export function reportFixture(start: string, end: string) {
  return opsReportSchema.parse({
    environment: env.id,
    deploymentId: env.deployment.id,
    window: { start, end, timeZone: "Asia/Shanghai", bounds: "[start,end)" },
    generatedAt: new Date().toISOString(),
    data: {
      indexedBlock: "100",
      indexedTimestamp: "1788970000",
      coverageComplete: true,
      epoch: "1",
    },
    funnel: {
      visitingSessions: 12,
      loginSubjects: 5,
      readyAccounts: 6,
      firstSuccessfulTradingAccounts: 3,
      claimingAccounts: 2,
      reinvestingAccounts: 1,
    },
    operations: {
      registered: 10,
      confirmed: 8,
      reverted: 1,
      unknown: 1,
      pending: 1,
    },
    trading: {
      activeAccounts: 3,
      activeAddresses: 4,
      primaryPayment: "100000000",
      c2cVolume: "48000000",
    },
    fees: {
      protocolAccrued: "250000",
      creatorAccrued: "250000",
      unknownAccrued: "0",
      claimed: "100000",
      claimable: "400000",
      asOfBlock: "100",
    },
    gas: {
      userOperationActualWei: "100000000000000",
      providerInvoices: [],
      providerBillingStatus: "unavailable",
    },
    budgets: [],
    weeklyBudget: null,
    services: {
      rpc: "available",
      chainHead: "102",
      indexDelayBlocks: "2",
      events: {},
      providerHardLimitUsd: null,
      providerHardLimitWei: "100000000000000000",
      providerHardLimitPeriodSeconds: 604800,
      providerSpendUsd: null,
      providerPolicyVerified: false,
    },
    notes: ["浏览器报表夹具，不是实际运营数据。"],
    providerManagement: {
      provider: "zerodev",
      source: "https://public-api.zerodev.app",
      projectId: "fixture-project",
      chainId: 421614,
      pollingSeconds: 300,
      staleAfterSeconds: 900,
      mappingStatus: "awaiting-real-response-contract",
      endpoints: [
        {
          endpoint: "statistics",
          lastAttemptAt: "2026-09-10T03:30:00.000Z",
          lastSuccessAt: "2026-09-10T03:00:00.000Z",
          requestedWindow: { start, end },
          dataWindow: { start, end },
          error: "rate-limited",
          stale: true,
        },
      ],
    },
  });
}
