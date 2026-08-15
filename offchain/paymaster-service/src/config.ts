import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import {
  MAX_PAYMASTER_POST_OP_GAS_LIMIT,
  MAX_PAYMASTER_VERIFICATION_GAS_LIMIT,
  MIN_PAYMASTER_POST_OP_GAS_LIMIT,
  MIN_PAYMASTER_VERIFICATION_GAS_LIMIT,
  type SponsorshipConfig,
} from "./sponsorship.js";

const addressSchema = z
  .string()
  .refine(isAddress, "must be an address")
  .transform((value) => getAddress(value))
  .refine((value) => value !== zeroAddress, "must not be the zero address");
const integerString = z.string().regex(/^\d+$/, "must be an unsigned integer");
const positiveBigint = integerString
  .transform(BigInt)
  .refine((value) => value > 0n, "must be positive");
const safeInteger = integerString
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a safe integer");
const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const envSchema = z.object({
  CPREDICT_PAYMASTER_HOST: z.enum(["127.0.0.1", "::1"]),
  CPREDICT_PAYMASTER_PORT: safeInteger.refine(
    (value) => value >= 1 && value <= 65_535,
  ),
  CPREDICT_PAYMASTER_LOG_LEVEL: logLevelSchema,
  CPREDICT_PAYMASTER_ADAPTER_MODULE: z
    .string()
    .url()
    .refine(
      (value) => new URL(value).protocol === "file:",
      "must be an absolute file URL",
    ),
  CPREDICT_PAYMASTER_CHAIN_ID: z.literal("84532"),
  CPREDICT_PAYMASTER_ENTRY_POINT: addressSchema,
  CPREDICT_PAYMASTER_ADDRESS: addressSchema,
  CPREDICT_PAYMASTER_EXPECTED_SIGNER: addressSchema,
  CPREDICT_PAYMASTER_POLICY_VERSION: safeInteger.refine(
    (value) => value >= 1 && value <= 0xffff_ffff,
  ),
  CPREDICT_PAYMASTER_VERIFICATION_GAS_LIMIT: positiveBigint.refine(
    (value) =>
      value >= MIN_PAYMASTER_VERIFICATION_GAS_LIMIT &&
      value <= MAX_PAYMASTER_VERIFICATION_GAS_LIMIT,
  ),
  CPREDICT_PAYMASTER_POST_OP_GAS_LIMIT: positiveBigint.refine(
    (value) =>
      value >= MIN_PAYMASTER_POST_OP_GAS_LIMIT &&
      value <= MAX_PAYMASTER_POST_OP_GAS_LIMIT,
  ),
  CPREDICT_PAYMASTER_VALIDITY_SECONDS: safeInteger.refine(
    (value) => value >= 60 && value <= 900,
  ),
  CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST: positiveBigint,
  CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY: positiveBigint,
  CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY: positiveBigint,
  CPREDICT_PAYMASTER_MAX_INIT_CODE_BYTES: safeInteger.refine(
    (value) => value >= 0 && value <= 65_536,
  ),
  CPREDICT_PAYMASTER_MAX_CALL_DATA_BYTES: safeInteger.refine(
    (value) => value >= 4 && value <= 65_536,
  ),
  CPREDICT_PAYMASTER_MIN_SPONSORED_LISTING_UNITS: positiveBigint.refine(
    (value) => value <= (1n << 128n) - 1n,
    "must fit uint128",
  ),
  CPREDICT_PAYMASTER_MAX_CREATE_LISTINGS_PER_USER_DAY: safeInteger.refine(
    (value) => value >= 0 && value <= 10_000,
  ),
  CPREDICT_PAYMASTER_MAX_CANCEL_LISTINGS_PER_USER_DAY: safeInteger.refine(
    (value) => value >= 0 && value <= 10_000,
  ),
});

export interface SponsorServiceConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
  adapterModule: string;
  expectedSigner: Address;
  sponsorship: SponsorshipConfig;
  policy: {
    maxCostPerRequest: bigint;
    maxInitCodeBytes: number;
    maxCallDataBytes: number;
    minSponsoredListingUnits: bigint;
    budgetLimits: {
      maxCostPerUserDay: bigint;
      maxCostGlobalDay: bigint;
      createListingPerUserDay: number;
      cancelListingPerUserDay: number;
    };
  };
}

export function parseSponsorServiceConfig(
  environment: Readonly<Record<string, string | undefined>>,
): SponsorServiceConfig {
  const allowedKeys = new Set(Object.keys(envSchema.shape));
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CPREDICT_PAYMASTER_") && !allowedKeys.has(key)) {
      throw new Error(`unsupported paymaster environment variable: ${key}`);
    }
  }
  const parsed = envSchema.parse(environment);
  if (
    parsed.CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST >
      parsed.CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY ||
    parsed.CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY >
      parsed.CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY
  ) {
    throw new RangeError(
      "paymaster cost limits must satisfy request <= user/day <= global/day",
    );
  }
  return {
    host: parsed.CPREDICT_PAYMASTER_HOST,
    port: parsed.CPREDICT_PAYMASTER_PORT,
    logLevel: parsed.CPREDICT_PAYMASTER_LOG_LEVEL,
    adapterModule: parsed.CPREDICT_PAYMASTER_ADAPTER_MODULE,
    expectedSigner: parsed.CPREDICT_PAYMASTER_EXPECTED_SIGNER,
    sponsorship: {
      chainId: 84_532,
      entryPoint: parsed.CPREDICT_PAYMASTER_ENTRY_POINT,
      paymaster: parsed.CPREDICT_PAYMASTER_ADDRESS,
      verificationGasLimit: parsed.CPREDICT_PAYMASTER_VERIFICATION_GAS_LIMIT,
      postOpGasLimit: parsed.CPREDICT_PAYMASTER_POST_OP_GAS_LIMIT,
      validitySeconds: parsed.CPREDICT_PAYMASTER_VALIDITY_SECONDS,
      policyVersion: parsed.CPREDICT_PAYMASTER_POLICY_VERSION,
    },
    policy: {
      maxCostPerRequest: parsed.CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST,
      maxInitCodeBytes: parsed.CPREDICT_PAYMASTER_MAX_INIT_CODE_BYTES,
      maxCallDataBytes: parsed.CPREDICT_PAYMASTER_MAX_CALL_DATA_BYTES,
      minSponsoredListingUnits:
        parsed.CPREDICT_PAYMASTER_MIN_SPONSORED_LISTING_UNITS,
      budgetLimits: {
        maxCostPerUserDay: parsed.CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY,
        maxCostGlobalDay: parsed.CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY,
        createListingPerUserDay:
          parsed.CPREDICT_PAYMASTER_MAX_CREATE_LISTINGS_PER_USER_DAY,
        cancelListingPerUserDay:
          parsed.CPREDICT_PAYMASTER_MAX_CANCEL_LISTINGS_PER_USER_DAY,
      },
    },
  };
}
