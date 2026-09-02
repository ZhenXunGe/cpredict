import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  buyWithPermit2InputSchema,
  type BuyWithPermit2Input,
} from "./schemas.js";

const decimalString = z.string().regex(/^\d+$/, "must be an unsigned integer");
const addressString = z
  .string()
  .refine(isAddress, "invalid EVM address")
  .transform((value) => getAddress(value));
const hexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .transform((value) => value as Hex);

export interface Permit2RelayBuyInput extends BuyWithPermit2Input {
  chainId: bigint;
  factory: Address;
  permit2: Address;
}

export const permit2RelayBuyWireSchema = z.object({
  chainId: decimalString.transform(BigInt),
  factory: addressString,
  permit2: addressString,
  vault: addressString,
  owner: addressString,
  outcomeId: decimalString.transform(BigInt),
  desiredUnits: decimalString.transform(BigInt),
  minimumUnits: decimalString.transform(BigInt),
  maximumPayment: decimalString.transform(BigInt),
  deadline: decimalString.transform(BigInt),
  permit: z.object({
    permitted: z.object({
      token: addressString,
      amount: decimalString.transform(BigInt),
    }),
    nonce: decimalString.transform(BigInt),
    deadline: decimalString.transform(BigInt),
  }),
  signature: hexSchema,
});

export const permit2RelaySubmissionSchema = z.object({
  intentId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value as Hex),
  transactionHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value as Hex),
  status: z.literal("submitted"),
  idempotent: z.boolean(),
});

export type Permit2RelaySubmission = z.output<
  typeof permit2RelaySubmissionSchema
>;

export interface Permit2BuyRelayer {
  relayBuy(input: Permit2RelayBuyInput): Promise<Permit2RelaySubmission>;
}

export class Permit2RelayOutcomeUnknownError extends Error {
  override readonly name = "Permit2RelayOutcomeUnknownError";

  constructor(message = "Permit2 relay submission outcome is unknown") {
    super(message);
  }
}

export function normalizePermit2RelayBuyInput(
  input: Permit2RelayBuyInput,
): Permit2RelayBuyInput {
  const buy = buyWithPermit2InputSchema.parse(input);
  if (input.chainId <= 0n) throw new RangeError("chainId must be positive");
  return {
    ...buy,
    chainId: input.chainId,
    factory: getAddress(input.factory),
    permit2: getAddress(input.permit2),
  };
}

export function permit2RelayIntentId(input: Permit2RelayBuyInput): Hex {
  const value = normalizePermit2RelayBuyInput(input);
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "uint256 chainId, address factory, address permit2, address vault, address owner, uint256 outcomeId, uint256 desiredUnits, uint256 minimumUnits, uint256 maximumPayment, uint64 deadline, address token, uint256 permitAmount, uint256 permitNonce, uint256 permitDeadline, bytes signature",
      ),
      [
        value.chainId,
        value.factory,
        value.permit2,
        value.vault,
        value.owner,
        value.outcomeId,
        value.desiredUnits,
        value.minimumUnits,
        value.maximumPayment,
        value.deadline,
        value.permit.permitted.token,
        value.permit.permitted.amount,
        value.permit.nonce,
        value.permit.deadline,
        value.signature,
      ],
    ),
  );
}

export function serializePermit2RelayBuyInput(input: Permit2RelayBuyInput) {
  const value = normalizePermit2RelayBuyInput(input);
  return {
    chainId: value.chainId.toString(),
    factory: value.factory,
    permit2: value.permit2,
    vault: value.vault,
    owner: value.owner,
    outcomeId: value.outcomeId.toString(),
    desiredUnits: value.desiredUnits.toString(),
    minimumUnits: value.minimumUnits.toString(),
    maximumPayment: value.maximumPayment.toString(),
    deadline: value.deadline.toString(),
    permit: {
      permitted: {
        token: value.permit.permitted.token,
        amount: value.permit.permitted.amount.toString(),
      },
      nonce: value.permit.nonce.toString(),
      deadline: value.permit.deadline.toString(),
    },
    signature: value.signature,
  };
}

export function createHttpPermit2BuyRelayer(options: {
  baseUrl: string | URL;
  fetcher?: typeof fetch;
}): Permit2BuyRelayer {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = new URL(
    "v1/permit2-buys",
    ensureTrailingSlash(options.baseUrl),
  );
  return {
    async relayBuy(input) {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(serializePermit2RelayBuyInput(input)),
        credentials: "same-origin",
        redirect: "error",
      });
      if (response.status === 409 || response.status === 503) {
        throw new Permit2RelayOutcomeUnknownError();
      }
      if (!response.ok) {
        throw new Error(`Permit2 relay HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new TypeError("Permit2 relay response is not JSON");
      }
      return permit2RelaySubmissionSchema.parse(await response.json());
    },
  };
}

function ensureTrailingSlash(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
