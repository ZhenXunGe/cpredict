import {
  getAddress,
  hexToBigInt,
  isAddress,
  size,
  slice,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  SponsorPolicyDeniedError,
  type PackedUserOperationInput,
  type SponsorAccountAdapter,
  type SponsorOperationKind,
  type SponsorPolicyDecision,
} from "./types.js";

const hexSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => value as Hex);
const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const addressSchema = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value));
const bigintSchema = z.union([
  z.bigint(),
  z.string().regex(/^\d+$/).transform(BigInt),
]);
export const CREATE_LISTING_SELECTOR = toFunctionSelector(
  "createListing(address,uint256,uint256,uint256,uint64)",
);
export const CANCEL_LISTING_SELECTOR = toFunctionSelector(
  "cancelListing(bytes32)",
);

export const sponsorshipRequestSchema = z.object({
  chainId: z.literal(421_614),
  userOperation: z.object({
    sender: addressSchema,
    nonce: bigintSchema,
    initCode: hexSchema,
    callData: hexSchema,
    accountGasLimits: bytes32Schema,
    preVerificationGas: bigintSchema,
    gasFees: bytes32Schema,
    signature: hexSchema,
  }),
  requestedMaxCost: bigintSchema.refine(
    (value) => value > 0n,
    "must be positive",
  ),
});

export interface SponsorPolicyOptions {
  decoder: SponsorAccountAdapter;
  /** Every allowlisted selector must carry an explicit abuse-accounting class. */
  allowedTargets: ReadonlyMap<Address, ReadonlyMap<Hex, SponsorOperationKind>>;
  maxCostPerRequest: bigint;
  maxInitCodeBytes: number;
  maxCallDataBytes: number;
  minSponsoredListingUnits: bigint;
}

export class SponsorPolicy {
  constructor(private readonly options: SponsorPolicyOptions) {
    if (options.minSponsoredListingUnits <= 0n) {
      throw new TypeError("minimum sponsored listing units must be positive");
    }
    for (const selectors of options.allowedTargets.values()) {
      for (const [selector, operation] of selectors) {
        const canonical = canonicalOperation(selector);
        if (canonical !== operation) {
          throw new TypeError(
            "sponsored selector operation classification is inconsistent",
          );
        }
      }
    }
  }

  async ready(): Promise<void> {
    await this.options.decoder.ready();
  }

  async validate(
    userOperation: PackedUserOperationInput,
    requestedMaxCost: bigint,
  ): Promise<SponsorPolicyDecision> {
    if (
      requestedMaxCost <= 0n ||
      requestedMaxCost > this.options.maxCostPerRequest
    ) {
      throw new RangeError("requested sponsorship cost exceeds policy");
    }
    if (
      size(userOperation.initCode) > this.options.maxInitCodeBytes ||
      size(userOperation.callData) > this.options.maxCallDataBytes
    ) {
      throw new RangeError("user operation byte length exceeds policy");
    }
    const calls = await this.options.decoder.decode(userOperation);
    if (calls.length === 0 || calls.length > 8) {
      throw new SponsorPolicyDeniedError("unsupported call count");
    }
    const operationCounts = { createListing: 0, cancelListing: 0 };
    for (const call of calls) {
      if (call.value !== 0n || size(call.data) < 4) {
        throw new SponsorPolicyDeniedError("unsupported account call");
      }
      const selectors = this.options.allowedTargets.get(
        getAddress(call.target),
      );
      const selector = slice(call.data, 0, 4);
      const operation = selectors?.get(selector);
      if (operation === undefined) {
        throw new SponsorPolicyDeniedError(
          "target or selector is not sponsored",
        );
      }
      if (operation === "createListing") {
        if (size(call.data) !== 164) {
          throw new SponsorPolicyDeniedError(
            "malformed createListing calldata",
          );
        }
        const listingUnits = hexToBigInt(slice(call.data, 68, 100));
        if (listingUnits < this.options.minSponsoredListingUnits) {
          throw new SponsorPolicyDeniedError(
            "sponsored listing amount is below policy minimum",
          );
        }
        operationCounts.createListing += 1;
      }
      if (operation === "cancelListing") operationCounts.cancelListing += 1;
    }
    return { operationCounts };
  }
}

function canonicalOperation(selector: Hex): SponsorOperationKind {
  if (selector === CREATE_LISTING_SELECTOR) return "createListing";
  if (selector === CANCEL_LISTING_SELECTOR) return "cancelListing";
  return "other";
}
