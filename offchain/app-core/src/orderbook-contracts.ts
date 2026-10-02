import { z } from "zod";
import { address, uint, hash } from "./contracts.js";
import { ledgerFactSchema, snapshotSchema } from "./ledger-contracts.js";

export const claimReceiptsSchema = z.object({
  items: z.array(
    z.object({
      fact: ledgerFactSchema,
      source: z.enum(["automatic", "manual", "direct", "unknown"]),
      marketQuestion: z.string().nullable(),
      actualGasCostWei: uint.nullable(),
      gasPayment: z.enum(["sponsored", "self-funded", "unknown"]),
    }),
  ),
  nextCursor: z.string().nullable(),
  snapshot: snapshotSchema,
});
export const sponsoredGasSchema = z.object({
  scope: z.literal("current-environment"),
  currency: z.literal("ETH"),
  knownActualWei: uint,
  totalActualWei: uint.nullable(),
  missingCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  shared: z.object({
    knownActualWei: uint,
    totalActualWei: uint.nullable(),
    missingCount: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      source: z.enum(["user-operation", "automation"]),
      transactionHash: hash,
      timestamp: z.string(),
      state: z.enum(["confirmed", "reverted"]),
      actualGasCostWei: uint.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  snapshot: snapshotSchema,
});
export const orderSchema = z.object({
  id: uint,
  market: address,
  owner: address,
  outcomeId: uint,
  side: z.enum(["bid", "ask"]),
  unitPrice: uint,
  expiresAt: uint,
  autoMatch: z.boolean(),
  allowPartialFills: z.boolean().optional(),
  remainingUnits: uint,
  lockedPayment: uint,
  active: z.boolean(),
});
export const orderPageSchema = z.object({
  items: z.array(orderSchema),
  totalLockedPayment: uint,
  nextCursor: uint.nullable(),
});
export const automaticClaimsStatusSchema = z.object({
  queue: z
    .object({
      state: z.enum([
        "idle",
        "discovering",
        "queued",
        "confirming",
        "paused",
        "unavailable",
      ]),
      readyCount: z.number().int().nonnegative(),
      inFlightCount: z.number().int().nonnegative(),
      deferredCount: z.number().int().nonnegative(),
      oldestQueuedAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .optional(),
  enabled: z.boolean(),
  reason: z.string(),
  updatedAt: z.string().nullable(),
  transactions: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.string(),
      effect: z.enum(["payout", "asset-return"]).optional(),
      context: z
        .object({
          market: address.nullable(),
          marketQuestion: z.string().nullable(),
          relatedMarkets: z
            .array(
              z.object({
                market: address,
                marketQuestion: z.string().nullable(),
              }),
            )
            .optional(),
          outcomeId: uint.nullable(),
          outcomeLabel: z.string().nullable(),
          amount: uint.nullable(),
          units: uint.nullable(),
        })
        .optional(),
      state: z.enum([
        "prepared",
        "broadcasting",
        "unknown",
        "confirmed",
        "reverted",
        "cancelled",
      ]),
      tx_hash: hash.nullable(),
      market: address.nullable(),
      amount: uint.nullable(),
      created_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
});
