import { z } from "zod";
import { address, uint, hash } from "./contracts.js";
export const orderSchema = z.object({
  id: uint,
  market: address,
  owner: address,
  outcomeId: uint,
  side: z.enum(["bid", "ask"]),
  unitPrice: uint,
  expiresAt: uint,
  autoMatch: z.boolean(),
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
  enabled: z.boolean(),
  reason: z.string(),
  updatedAt: z.string().nullable(),
  transactions: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.string(),
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
