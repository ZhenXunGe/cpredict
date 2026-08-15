import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

const unsignedInteger = z.string().regex(/^(0|[1-9]\d*)$/);
const safeInteger = unsignedInteger
  .transform(Number)
  .refine(Number.isSafeInteger);
const address = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value))
  .refine((value) => value !== zeroAddress);
const logLevel = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);
const schema = z.object({
  CPREDICT_WORKER_HOST: z.enum(["127.0.0.1", "::1"]),
  CPREDICT_WORKER_PORT: safeInteger.refine(
    (value) => value >= 1 && value <= 65_535,
  ),
  CPREDICT_WORKER_LOG_LEVEL: logLevel,
  CPREDICT_WORKER_ADAPTER_MODULE: z
    .string()
    .url()
    .refine(
      (value) => new URL(value).protocol === "file:",
      "must be an absolute file URL",
    ),
  CPREDICT_WORKER_CHAIN_ID: safeInteger.refine((value) => value > 0),
  CPREDICT_WORKER_RPC_URL: z.string().url().refine(isSecureHttpUrl),
  CPREDICT_WORKER_DATABASE_URL: z.string().url().refine(isSecurePostgresUrl),
  CPREDICT_WORKER_EXPECTED_ACCOUNT: address,
  CPREDICT_WORKER_BOND_ESCROW: address,
  CPREDICT_WORKER_EXPOSURE_GUARD: address,
  CPREDICT_WORKER_INDEXER_URL: z.string().url().refine(isSecureHttpUrl),
  CPREDICT_WORKER_INDEXER_MAX_PAGES: safeInteger.refine(
    (value) => value >= 1 && value <= 1_000,
  ),
  CPREDICT_WORKER_INDEXER_TIMEOUT_MS: safeInteger.refine(
    (value) => value >= 500 && value <= 30_000,
  ),
});

export interface TerminalWorkerServiceConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  logLevel: z.infer<typeof logLevel>;
  adapterModule: string;
  chainId: number;
  rpcUrl: string;
  databaseUrl: string;
  expectedAccount: Address;
  bondEscrow: Address;
  exposureGuard: Address;
  indexerUrl: URL;
  indexerMaxPages: number;
  indexerTimeoutMs: number;
}

export function parseTerminalWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): TerminalWorkerServiceConfig {
  const allowed = new Set(Object.keys(schema.shape));
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CPREDICT_WORKER_") && !allowed.has(key)) {
      throw new Error(`unsupported worker environment variable: ${key}`);
    }
  }
  const parsed = schema.parse(environment);
  return {
    host: parsed.CPREDICT_WORKER_HOST,
    port: parsed.CPREDICT_WORKER_PORT,
    logLevel: parsed.CPREDICT_WORKER_LOG_LEVEL,
    adapterModule: parsed.CPREDICT_WORKER_ADAPTER_MODULE,
    chainId: parsed.CPREDICT_WORKER_CHAIN_ID,
    rpcUrl: parsed.CPREDICT_WORKER_RPC_URL,
    databaseUrl: parsed.CPREDICT_WORKER_DATABASE_URL,
    expectedAccount: parsed.CPREDICT_WORKER_EXPECTED_ACCOUNT,
    bondEscrow: parsed.CPREDICT_WORKER_BOND_ESCROW,
    exposureGuard: parsed.CPREDICT_WORKER_EXPOSURE_GUARD,
    indexerUrl: new URL(parsed.CPREDICT_WORKER_INDEXER_URL),
    indexerMaxPages: parsed.CPREDICT_WORKER_INDEXER_MAX_PAGES,
    indexerTimeoutMs: parsed.CPREDICT_WORKER_INDEXER_TIMEOUT_MS,
  };
}

function isSecureHttpUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopback(url.hostname))
  );
}

function isSecurePostgresUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    return false;
  return (
    isLoopback(url.hostname) ||
    ["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode") ?? "",
    )
  );
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
