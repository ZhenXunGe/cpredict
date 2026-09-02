import type { Address, Hex } from "viem";
import type { Permit2RelayBuyInput } from "../../sdk/src/permit2-relay.js";

export interface RelayTransactionRequest {
  chainId: number;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Production implementations must keep transaction signing inside KMS/HSM. */
export interface Permit2RelaySender {
  ready(): Promise<void>;
  address(): Promise<Address>;
  sendTransaction(request: RelayTransactionRequest): Promise<Hex>;
}

export interface Permit2RelayChain {
  ready(): Promise<void>;
  prepare(
    input: Permit2RelayBuyInput,
    sender: Address,
  ): Promise<RelayTransactionRequest>;
}

export type RelayIntentReservation =
  | { kind: "acquired"; markSubmitted(hash: Hex): Promise<void> }
  | { kind: "pending" }
  | { kind: "submitted"; hash: Hex };

/** Production implementations must reserve atomically in durable shared storage. */
export interface Permit2RelayIntentStore {
  ready(): Promise<void>;
  find(
    intentId: Hex,
  ): Promise<{ state: "pending" } | { state: "submitted"; hash: Hex } | null>;
  reserve(input: {
    intentId: Hex;
    owner: Address;
    vault: Address;
    permitNonce: bigint;
    expiresAt: bigint;
  }): Promise<RelayIntentReservation>;
}

export class Permit2RelayPolicyDeniedError extends Error {
  override readonly name = "Permit2RelayPolicyDeniedError";

  constructor(message = "Permit2 relay denied by policy") {
    super(message);
  }
}
