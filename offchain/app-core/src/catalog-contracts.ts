import { z } from "zod";
import { address, hash, uint } from "./contracts.js";
import { snapshotSchema } from "./ledger-contracts.js";
export const marketSchema = z.object({
  chainId: z.number(),
  market: address,
  creator: address,
  creatorTreasury: address.nullable(),
  outcomeCount: z.number().int().nullable(),
  closeAt: uint.nullable(),
  createdAt: uint.nullable(),
  eventStartsAt: uint.nullable(),
  outcomeDeadlineAt: uint.nullable(),
  resolutionWindow: uint.nullable(),
  rulesHash: hash.nullable(),
  metadataUri: z.string().nullable(),
  resolutionSourceHash: hash.nullable(),
  resolutionSourceUri: z.string().nullable(),
  featureFlags: uint.nullable(),
  marketPrimaryCap: uint.nullable(),
  primaryFilledUnits: uint,
  primaryPayment: uint,
  creatorBond: uint,
  state: z.number().int(),
  voidReason: z.number().int(),
  winningOutcome: uint.nullable(),
  evidenceHash: hash.nullable(),
  createdBlock: uint,
  updatedBlock: uint,
  confirmationStatus: z.enum(["provisional", "confirmed"]),
  question: z.string().nullable().optional(),
});
export type Market = z.infer<typeof marketSchema>;
export const listingSchema = z.object({
  chainId: z.number(),
  listingId: hash,
  vault: address,
  seller: address,
  outcomeId: uint,
  remainingUnits: uint,
  unitPrice: uint,
  expiresAt: uint,
  active: z.boolean(),
  updatedBlock: uint,
});
export type Listing = z.infer<typeof listingSchema>;
export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().optional(),
    metadataPending: z.number().int().nonnegative().optional(),
    snapshot: snapshotSchema.optional(),
  });
