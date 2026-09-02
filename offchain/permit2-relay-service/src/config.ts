import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

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
const serviceHost = z.enum(["127.0.0.1", "::1", "0.0.0.0", "::"]);
const booleanString = z.enum(["true", "false"]);
const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const envSchema = z
  .object({
    CPREDICT_RELAY_HOST: serviceHost,
    CPREDICT_RELAY_CONTAINER_MODE: booleanString.default("false"),
    CPREDICT_RELAY_PORT: safeInteger.refine(
      (value) => value >= 1 && value <= 65_535,
    ),
    CPREDICT_RELAY_LOG_LEVEL: logLevelSchema,
    CPREDICT_RELAY_ADAPTER_MODULE: z
      .string()
      .url()
      .refine(
        (value) => new URL(value).protocol === "file:",
        "must be an absolute file URL",
      ),
    CPREDICT_RELAY_DATABASE_URL: z
      .string()
      .refine(
        (value) =>
          value.startsWith("postgres://") ||
          value.startsWith("postgresql://"),
        "must be a PostgreSQL URL",
      ),
    CPREDICT_RELAY_RPC_URL: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "must use HTTPS"),
    CPREDICT_RELAY_CHAIN_ID: z.literal("421614"),
    CPREDICT_RELAY_FACTORY_ADDRESS: addressSchema,
    CPREDICT_RELAY_PAYMENT_ASSET_ADDRESS: addressSchema,
    CPREDICT_RELAY_PERMIT2_ADDRESS: addressSchema,
    CPREDICT_RELAY_EXPECTED_SENDER: addressSchema,
    CPREDICT_RELAY_MAX_DEADLINE_SECONDS: safeInteger.refine(
      (value) => value >= 60 && value <= 900,
    ),
    CPREDICT_RELAY_MAX_GAS: positiveBigint.refine(
      (value) => value >= 100_000n && value <= 1_000_000n,
    ),
    CPREDICT_RELAY_MAX_TRANSACTION_FEE_WEI: positiveBigint.refine(
      (value) => value <= 10_000_000_000_000_000n,
    ),
  })
  .superRefine((value, context) => {
    const publicBind = ["0.0.0.0", "::"].includes(value.CPREDICT_RELAY_HOST);
    const containerMode = value.CPREDICT_RELAY_CONTAINER_MODE === "true";
    if (publicBind !== containerMode) {
      context.addIssue({
        code: "custom",
        path: ["CPREDICT_RELAY_CONTAINER_MODE"],
        message:
          "must be true exactly when binding a container wildcard address",
      });
    }
  });

export interface Permit2RelayServiceConfig {
  host: "127.0.0.1" | "::1" | "0.0.0.0" | "::";
  containerMode: boolean;
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
  adapterModule: string;
  databaseUrl: string;
  rpcUrl: string;
  chainId: 421_614;
  factory: Address;
  paymentToken: Address;
  permit2: Address;
  expectedSender: Address;
  maxDeadlineSeconds: number;
  maxGas: bigint;
  maxTransactionFee: bigint;
}

export function parsePermit2RelayServiceConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Permit2RelayServiceConfig {
  const allowedKeys = new Set(Object.keys(envSchema.shape));
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CPREDICT_RELAY_") && !allowedKeys.has(key)) {
      throw new Error(`unsupported relay environment variable: ${key}`);
    }
  }
  const parsed = envSchema.parse(environment);
  return {
    host: parsed.CPREDICT_RELAY_HOST,
    containerMode: parsed.CPREDICT_RELAY_CONTAINER_MODE === "true",
    port: parsed.CPREDICT_RELAY_PORT,
    logLevel: parsed.CPREDICT_RELAY_LOG_LEVEL,
    adapterModule: parsed.CPREDICT_RELAY_ADAPTER_MODULE,
    databaseUrl: parsed.CPREDICT_RELAY_DATABASE_URL,
    rpcUrl: parsed.CPREDICT_RELAY_RPC_URL,
    chainId: 421_614,
    factory: parsed.CPREDICT_RELAY_FACTORY_ADDRESS,
    paymentToken: parsed.CPREDICT_RELAY_PAYMENT_ASSET_ADDRESS,
    permit2: parsed.CPREDICT_RELAY_PERMIT2_ADDRESS,
    expectedSender: parsed.CPREDICT_RELAY_EXPECTED_SENDER,
    maxDeadlineSeconds: parsed.CPREDICT_RELAY_MAX_DEADLINE_SECONDS,
    maxGas: parsed.CPREDICT_RELAY_MAX_GAS,
    maxTransactionFee: parsed.CPREDICT_RELAY_MAX_TRANSACTION_FEE_WEI,
  };
}
