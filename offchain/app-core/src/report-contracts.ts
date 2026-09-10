import { z } from "zod";
import { address, hash, id, signedAmount, uint } from "./contracts.js";
import { snapshotSchema } from "./ledger-contracts.js";
export const leaderboardPeriodSchema = z
  .strictObject({
    id,
    startsAt: uint,
    endsAt: uint,
    publishedAt: uint,
    markets: z
      .array(z.strictObject({ market: address, startsAt: uint }))
      .min(1)
      .max(200),
  })
  .superRefine((v, c) => {
    if (
      BigInt(v.endsAt) <= BigInt(v.startsAt) ||
      BigInt(v.publishedAt) > BigInt(v.startsAt) ||
      v.markets.some(
        (m) =>
          BigInt(m.startsAt) < BigInt(v.startsAt) ||
          BigInt(m.startsAt) >= BigInt(v.endsAt) ||
          BigInt(m.startsAt) < BigInt(v.publishedAt),
      ) ||
      new Set(v.markets.map((m) => m.market.toLowerCase())).size !==
        v.markets.length
    )
      c.addIssue({
        code: "custom",
        message:
          "roster must be unique and published before the fixed scoring window",
      });
  });
export type LeaderboardPeriod = z.infer<typeof leaderboardPeriodSchema>;
export const leaderboardEntrySchema = z.strictObject({
  account: address,
  rank: z.number().int().positive(),
  realizedNet: signedAmount,
  marketCount: z.number().int().positive(),
});
export const leaderboardSnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  period: leaderboardPeriodSchema,
  version: z.number().int().positive(),
  statisticsVersion: z.literal("weighted-average-v1"),
  data: snapshotSchema,
  createdAt: z.string().datetime(),
  entries: z.array(leaderboardEntrySchema),
  excluded: z.array(
    z.strictObject({ account: address, reasons: z.array(z.string()) }),
  ),
  correction: z.string().nullable(),
});
export type LeaderboardSnapshot = z.infer<typeof leaderboardSnapshotSchema>;
export const leaderboardPageSchema = z.strictObject({
  periods: z.array(leaderboardPeriodSchema),
  snapshot: leaderboardSnapshotSchema.omit({ entries: true }).nullable(),
  items: z.array(leaderboardEntrySchema),
  nextCursor: z.string().nullable(),
  status: z.enum([
    "disabled",
    "awaiting-roster",
    "awaiting-snapshot",
    "available",
    "correction-pending",
  ]),
});
export const telemetrySchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  event: z.enum(["visit", "login", "account-ready"]),
  occurredAt: z.string().datetime(),
  accountId: z.string().uuid().optional(),
});
export const feedbackSchema = z.strictObject({
  id: z.string().uuid(),
  accountId: z.string().uuid().optional(),
  operationId: z.string().uuid().optional(),
  message: z
    .string()
    .trim()
    .min(8)
    .max(2000)
    .refine(
      (v) =>
        !/(?:\b(?:private[_ -]?key|access[_ -]?token|mnemonic|seed phrase)\b\s*[:=]|\b0x[\da-f]{128,}\b|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)/i.test(
          v,
        ),
      "feedback must not contain keys, tokens or executable signatures",
    ),
});
export const opsReportSchema = z.object({
  environment: z.string(),
  deploymentId: z.string(),
  window: z.object({
    start: z.string(),
    end: z.string(),
    timeZone: z.literal("Asia/Shanghai"),
    bounds: z.literal("[start,end)"),
  }),
  generatedAt: z.string(),
  data: z.object({
    indexedBlock: uint.nullable(),
    indexedTimestamp: uint.nullable(),
    coverageComplete: z.boolean(),
    epoch: uint.nullable(),
  }),
  funnel: z.object({
    visitingSessions: z.number(),
    loginSubjects: z.number(),
    readyAccounts: z.number(),
    firstSuccessfulTradingAccounts: z.number(),
    claimingAccounts: z.number(),
    reinvestingAccounts: z.number(),
  }),
  operations: z.object({
    registered: z.number(),
    confirmed: z.number(),
    reverted: z.number(),
    unknown: z.number(),
    pending: z.number(),
  }),
  trading: z.object({
    activeAccounts: z.number(),
    activeAddresses: z.number(),
    primaryPayment: uint,
    c2cVolume: uint,
  }),
  fees: z.object({
    protocolAccrued: uint,
    creatorAccrued: uint,
    unknownAccrued: uint,
    claimed: uint,
    claimable: uint.nullable(),
    asOfBlock: uint.nullable(),
  }),
  gas: z.object({
    userOperationActualWei: uint,
    providerInvoices: z.array(
      z.object({
        reference: z.string(),
        start: z.string(),
        end: z.string(),
        amount: z.string(),
        currency: z.string(),
      }),
    ),
    providerBillingStatus: z.enum(["unavailable", "imported"]),
  }),
  budgets: z.array(
    z.object({
      lane: z.enum(["exposure", "exit"]),
      reservedWei: uint,
      remainingWei: uint,
      operations: z.number(),
      remainingOperations: z.number(),
      resetsAt: z.string(),
    }),
  ),
  weeklyBudget: z
    .object({
      start: z.string().datetime(),
      end: z.string().datetime(),
      timeZone: z.literal("Asia/Shanghai"),
      weekStartsOn: z.literal("monday"),
      projectLimitWei: uint,
      lanes: z.array(
        z.object({
          lane: z.enum(["exposure", "exit"]),
          limitWei: uint,
          reservedWei: uint,
          remainingWei: uint,
        }),
      ),
    })
    .nullable(),
  services: z.object({
    rpc: z.enum(["available", "unavailable", "unknown"]),
    chainHead: uint.nullable(),
    indexDelayBlocks: uint.nullable(),
    events: z.record(z.string(), z.number()),
    providerHardLimitUsd: z.string().nullable(),
    providerHardLimitWei: uint.nullable(),
    providerHardLimitPeriodSeconds: z.number().int().positive().nullable(),
    providerSpendUsd: z.null(),
    providerPolicyVerified: z.literal(false),
  }),
  notes: z.array(z.string()),
});
export type OpsReport = z.infer<typeof opsReportSchema>;
