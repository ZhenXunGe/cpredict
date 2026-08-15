import type { Address, Hex } from "viem";

export interface PackedUserOperationInput {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  signature: Hex;
}

export interface DecodedAccountCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/**
 * Abuse-sensitive operation classes. Every sponsored selector must be classified explicitly;
 * `other` is still allowlisted, but does not consume a listing-operation quota.
 */
export type SponsorOperationKind = "createListing" | "cancelListing" | "other";

export interface SponsorOperationCounts {
  createListing: number;
  cancelListing: number;
}

export interface SponsorOperationLimits {
  createListingPerUserDay: number;
  cancelListingPerUserDay: number;
}

export interface SponsorBudgetLimits extends SponsorOperationLimits {
  maxCostPerUserDay: bigint;
  maxCostGlobalDay: bigint;
}

export interface SponsorPolicyDecision {
  operationCounts: SponsorOperationCounts;
}

export interface AccountCallDecoder {
  decode(
    userOperation: PackedUserOperationInput,
  ): Promise<readonly DecodedAccountCall[]>;
}

export interface SponsorAccountAdapter extends AccountCallDecoder {
  ready(): Promise<void>;
}

/** Production implementations must keep key material inside KMS/HSM. */
export interface SponsorSigner {
  ready(): Promise<void>;
  address(): Promise<Address>;
  signDigest(digest: Hex): Promise<Hex>;
}

/** Auth is intentionally injected; production should verify short-lived backend-issued credentials. */
export interface SponsorIdentity {
  subject: string;
}

export interface SponsorAuthorizer {
  ready(): Promise<void>;
  authorize(
    authorizationHeader: string | undefined,
  ): Promise<SponsorIdentity | null>;
}

export interface SponsorBudgetRequest {
  subject: string;
  sender: Address;
  maxCost: bigint;
  validUntil: number;
  /** UTC day number (`floor(unixSeconds / 86400)`) used by the durable atomic store. */
  policyDay: number;
  operationCounts: SponsorOperationCounts;
  limits: SponsorBudgetLimits;
}

export interface SponsorBudgetLease {
  commit(): Promise<void>;
  release(): Promise<void>;
}

/** Production implementations must reserve atomically in a durable shared datastore. */
export interface SponsorBudgetStore {
  ready(): Promise<void>;
  reserve(request: SponsorBudgetRequest): Promise<SponsorBudgetLease>;
}

export class SponsorPolicyDeniedError extends Error {
  constructor(message = "sponsorship denied by policy") {
    super(message);
    this.name = "SponsorPolicyDeniedError";
  }
}

export class SponsorBudgetExceededError extends Error {
  constructor(message = "sponsorship budget exceeded") {
    super(message);
    this.name = "SponsorBudgetExceededError";
  }
}
