import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

export const addressSchema = z
  .string()
  .refine(isAddress, "invalid EVM address")
  .transform((value) => getAddress(value));
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);

const uint = (bits: number) =>
  z
    .bigint()
    .nonnegative()
    .max((1n << BigInt(bits)) - 1n);
const positiveUint = (bits: number) => uint(bits).positive();

export const buyInputSchema = z.object({
  vault: addressSchema,
  outcomeId: uint(256),
  desiredUnits: positiveUint(256),
  minimumUnits: positiveUint(256),
  maximumPayment: positiveUint(256),
  deadline: positiveUint(64),
});

export const permitTransferSchema = z.object({
  permitted: z.object({ token: addressSchema, amount: positiveUint(256) }),
  nonce: uint(256),
  deadline: positiveUint(256),
});

export const buyWithPermit2InputSchema = buyInputSchema.extend({
  owner: addressSchema,
  permit: permitTransferSchema,
  signature: z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
    .transform((value) => value as Hex),
});

export const createListingInputSchema = z.object({
  marketplace: addressSchema,
  vault: addressSchema,
  outcomeId: uint(256),
  amount: positiveUint(256),
  unitPrice: positiveUint(256),
  expiresAt: positiveUint(64),
});

export const fillListingInputSchema = z.object({
  marketplace: addressSchema,
  listingId: bytes32Schema,
  desiredUnits: positiveUint(256),
  minimumUnits: positiveUint(256),
  maximumGross: positiveUint(256),
  deadline: positiveUint(64),
});

export const fillListingWithPermit2InputSchema = fillListingInputSchema.extend({
  buyer: addressSchema,
  permit: permitTransferSchema,
  signature: z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
    .transform((value) => value as Hex),
});

export const createMarketInputSchema = z.object({
  factory: addressSchema,
  userSalt: bytes32Schema,
  params: z
    .strictObject({
      rulesHash: bytes32Schema,
      metadataURI: z.string().max(512),
      resolutionSourceHash: bytes32Schema,
      resolutionSourceURI: z.string().max(512),
      outcomeCount: z.number().int().min(2).max(32),
      closeAt: positiveUint(64),
      eventStartsAt: uint(64),
      outcomeDeadlineAt: positiveUint(64),
      creatorTreasury: addressSchema,
      deploymentMode: z.union([z.literal(0), z.literal(1)]),
      featureFlags: uint(256),
      creatorRakeBps: z.number().int().min(0).max(10_000),
      creatorC2CFeeBps: z.number().int().min(0).max(10_000),
      perUserPrimaryCap: positiveUint(128),
      marketPrimaryCap: positiveUint(128),
      minimumPrimaryUnits: positiveUint(128),
      minimumC2CUnits: positiveUint(128),
      creatorBond: positiveUint(128),
    })
    .refine(
      (value) =>
        value.outcomeDeadlineAt >= value.closeAt &&
        (value.eventStartsAt === 0n ||
          (value.eventStartsAt > value.closeAt &&
            value.eventStartsAt <= value.outcomeDeadlineAt)),
      { message: "invalid market event times", path: ["outcomeDeadlineAt"] },
    ),
});

type AddressOutput<T, K extends keyof T> = Omit<T, K> & { [P in K]: Address };

export type BuyInput = AddressOutput<z.output<typeof buyInputSchema>, "vault">;
export type BuyWithPermit2Input = AddressOutput<
  AddressOutput<z.output<typeof buyWithPermit2InputSchema>, "vault">,
  "owner"
>;
export type CreateListingInput = AddressOutput<
  AddressOutput<z.output<typeof createListingInputSchema>, "marketplace">,
  "vault"
>;
export type FillListingInput = AddressOutput<
  z.output<typeof fillListingInputSchema>,
  "marketplace"
>;
export type FillListingWithPermit2Input = AddressOutput<
  AddressOutput<
    z.output<typeof fillListingWithPermit2InputSchema>,
    "marketplace"
  >,
  "buyer"
>;
export type CreateMarketInput = z.output<typeof createMarketInputSchema>;
