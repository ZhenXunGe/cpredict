import { z } from "zod";
import { address, hash, uint, signedAmount } from "./contracts.js";

export const factKind = z.enum([
  "market-created",
  "market-initialized",
  "market-metadata",
  "economic-snapshot",
  "primary-buy",
  "listing-created",
  "listing-filled",
  "listing-cancelled",
  "listing-returned",
  "market-resolved",
  "market-voided",
  "winner-claimed",
  "early-bird-claimed",
  "refunded",
  "timeout-funded",
  "timeout-claimed",
  "losing-burned",
  "remainder-assigned",
  "share-transfer",
  "payment-transfer",
  "bond-locked",
  "bond-credited",
  "bond-timeout-funded",
  "bond-claimed",
  "fee-accrued",
  "fee-claimed",
  "user-operation",
  "coverage-gap",
]);
export const ledgerFactSchema = z.strictObject({
  id: z.string().max(180),
  kind: factKind,
  blockNumber: uint,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),
  factIndex: z.number().int().nonnegative(),
  timestamp: uint,
  market: address.nullable(),
  owner: address.nullable(),
  counterparty: address.nullable(),
  outcomeId: uint.nullable(),
  listingId: hash.nullable(),
  units: uint.nullable(),
  amount: uint.nullable(),
  extra: z.record(z.string(), z.json()),
});
export type LedgerFact = z.infer<typeof ledgerFactSchema>;
export type FactKind = LedgerFact["kind"];
export const snapshotSchema = z.strictObject({
  environment: z.string(),
  deploymentId: z.string(),
  version: z.literal(1),
  epoch: uint,
  blockNumber: uint,
  blockHash: hash,
  timestamp: uint,
  coverageStart: uint.nullable(),
  complete: z.boolean(),
  status: z.enum(["shadow", "active"]),
});
export type LedgerSnapshot = z.infer<typeof snapshotSchema>;
export const lotSchema = z.strictObject({
  market: address,
  outcomeId: uint,
  units: uint,
  escrowUnits: uint,
  knownCost: uint,
  costComplete: z.boolean(),
});
export const pnlEntrySchema = z.strictObject({
  factId: z.string(),
  market: address,
  outcomeId: uint.nullable(),
  kind: factKind,
  timestamp: uint,
  amount: signedAmount.nullable(),
  proceeds: uint,
  allocatedCost: uint,
  complete: z.boolean(),
  reason: z.string().nullable(),
});
export const pnlSchema = z.strictObject({
  owner: address,
  realizedNet: signedAmount.nullable(),
  knownRealizedNet: signedAmount,
  complete: z.boolean(),
  missingReasons: z.array(z.string()),
  lots: z.array(lotSchema),
  entries: z.array(pnlEntrySchema),
  creatorIncome: uint,
  creatorClaimed: uint,
  bondLocked: uint,
  bondCredited: uint,
  bondClaimed: uint,
  bondSlashed: uint,
  paymentIn: uint,
  paymentOut: uint,
  gasCost: uint,
});
export type Pnl = z.infer<typeof pnlSchema>;
export const entitlementSchema = z.strictObject({
  id: z.string(),
  market: address.nullable(),
  kind: z.enum([
    "holding",
    "escrow",
    "winner",
    "early-bird",
    "refund",
    "timeout-bonus",
    "bond",
    "fees",
  ]),
  outcomeId: uint.nullable(),
  listingId: hash.nullable(),
  units: uint.nullable(),
  amount: uint.nullable(),
  status: z.enum([
    "conditional",
    "claimable",
    "executing",
    "claimed",
    "unknown",
  ]),
  reason: z.string().nullable(),
});
export type Entitlement = z.infer<typeof entitlementSchema>;
export const factsPageSchema = z.strictObject({
  items: z.array(ledgerFactSchema),
  nextCursor: z.string().nullable(),
  snapshot: snapshotSchema,
});
export const pnlResponseSchema = z.strictObject({
  pnl: pnlSchema,
  snapshot: snapshotSchema,
});
export const pnlFactResponseSchema = z.strictObject({
  items: z.array(pnlEntrySchema),
  snapshot: snapshotSchema,
});
export const entitlementsResponseSchema = z.strictObject({
  items: z.array(entitlementSchema),
  nextCursor: z.string().nullable(),
  snapshot: snapshotSchema,
});
