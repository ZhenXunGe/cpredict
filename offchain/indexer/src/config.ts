import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

const unsignedInteger = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be an unsigned integer");
const safeInteger = unsignedInteger
  .transform(Number)
  .refine(Number.isSafeInteger, "must be safe");
const address = z
  .string()
  .refine(isAddress, "must be an address")
  .transform((value) => getAddress(value))
  .refine((value) => value !== zeroAddress, "must not be zero");
const loopbackHost = z.enum(["127.0.0.1", "::1"]);
const logLevel = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const schema = z
  .object({
    CPREDICT_INDEXER_HOST: loopbackHost,
    CPREDICT_INDEXER_PORT: safeInteger.refine(
      (value) => value >= 1 && value <= 65_535,
    ),
    CPREDICT_INDEXER_LOG_LEVEL: logLevel,
    CPREDICT_INDEXER_CHAIN_ID: safeInteger.refine((value) => value > 0),
    CPREDICT_INDEXER_RPC_URL: z
      .string()
      .url()
      .refine(isSecureServiceUrl, "must use HTTPS or loopback HTTP"),
    CPREDICT_INDEXER_DATABASE_URL: z
      .string()
      .url()
      .refine(isSecurePostgresUrl, "must use secure PostgreSQL"),
    CPREDICT_INDEXER_FACTORY_ADDRESS: address,
    CPREDICT_INDEXER_CORE_ADDRESSES: z.string().min(1),
    CPREDICT_INDEXER_DEPLOYMENT_BLOCK: unsignedInteger.transform(BigInt),
    CPREDICT_INDEXER_CONFIRMATIONS: unsignedInteger
      .transform(BigInt)
      .refine((value) => value <= 10_000n, "must be <= 10000"),
    CPREDICT_INDEXER_BATCH_SIZE: unsignedInteger
      .transform(BigInt)
      .refine(
        (value) => value >= 1n && value <= 10_000n,
        "must be within [1, 10000]",
      ),
    CPREDICT_INDEXER_MAX_BATCHES_PER_TICK: safeInteger.refine(
      (value) => value >= 1 && value <= 100,
    ),
    CPREDICT_INDEXER_POLL_INTERVAL_MS: safeInteger.refine(
      (value) => value >= 250 && value <= 60_000,
    ),
    CPREDICT_INDEXER_RPC_TIMEOUT_MS: safeInteger.refine(
      (value) => value >= 1_000 && value <= 30_000,
    ),
    CPREDICT_INDEXER_DATABASE_POOL_SIZE: safeInteger
      .default(10)
      .refine((value) => value >= 1 && value <= 100),
    CPREDICT_INDEXER_LISTEN_BACKLOG: safeInteger.refine(
      (value) => value >= 128 && value <= 65_535,
    ),
    CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS: safeInteger.refine(
      (value) => value >= 1 && value <= 100_000,
    ),
    CPREDICT_INDEXER_WS_MAX_CONNECTIONS: safeInteger.refine(
      (value) => value >= 1 && value <= 50_000,
    ),
    CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS: safeInteger.refine(
      (value) => value >= 5_000 && value <= 60_000,
    ),
    CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES: safeInteger.refine(
      (value) => value >= 1_024 && value <= 1_048_576,
    ),
    CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS: safeInteger.refine(
      (value) => value >= 100 && value <= 30_000,
    ),
  })
  .superRefine((value, context) => {
    if (
      value.CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS <
      value.CPREDICT_INDEXER_WS_MAX_CONNECTIONS
    ) {
      context.addIssue({
        code: "custom",
        path: ["CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS"],
        message: "must be >= CPREDICT_INDEXER_WS_MAX_CONNECTIONS",
      });
    }
  });

export interface IndexerServiceConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  logLevel: z.infer<typeof logLevel>;
  chainId: number;
  rpcUrl: string;
  databaseUrl: string;
  factoryAddress: Address;
  coreAddresses: readonly Address[];
  deploymentBlock: bigint;
  confirmations: bigint;
  batchSize: bigint;
  maxBatchesPerTick: number;
  pollIntervalMs: number;
  rpcTimeoutMs: number;
  databasePoolSize: number;
  listenBacklog: number;
  httpMaxConnections: number;
  wsMaxConnections: number;
  wsHeartbeatIntervalMs: number;
  wsMaxBufferedAmountBytes: number;
  wsShutdownGraceMs: number;
}

export function parseIndexerServiceConfig(
  environment: Readonly<Record<string, string | undefined>>,
): IndexerServiceConfig {
  rejectUnknown(
    environment,
    "CPREDICT_INDEXER_",
    new Set(Object.keys(schema.shape)),
  );
  const parsed = schema.parse(environment);
  const coreAddresses = parseAddressList(
    parsed.CPREDICT_INDEXER_CORE_ADDRESSES,
  );
  return {
    host: parsed.CPREDICT_INDEXER_HOST,
    port: parsed.CPREDICT_INDEXER_PORT,
    logLevel: parsed.CPREDICT_INDEXER_LOG_LEVEL,
    chainId: parsed.CPREDICT_INDEXER_CHAIN_ID,
    rpcUrl: parsed.CPREDICT_INDEXER_RPC_URL,
    databaseUrl: parsed.CPREDICT_INDEXER_DATABASE_URL,
    factoryAddress: parsed.CPREDICT_INDEXER_FACTORY_ADDRESS,
    coreAddresses,
    deploymentBlock: parsed.CPREDICT_INDEXER_DEPLOYMENT_BLOCK,
    confirmations: parsed.CPREDICT_INDEXER_CONFIRMATIONS,
    batchSize: parsed.CPREDICT_INDEXER_BATCH_SIZE,
    maxBatchesPerTick: parsed.CPREDICT_INDEXER_MAX_BATCHES_PER_TICK,
    pollIntervalMs: parsed.CPREDICT_INDEXER_POLL_INTERVAL_MS,
    rpcTimeoutMs: parsed.CPREDICT_INDEXER_RPC_TIMEOUT_MS,
    databasePoolSize: parsed.CPREDICT_INDEXER_DATABASE_POOL_SIZE,
    listenBacklog: parsed.CPREDICT_INDEXER_LISTEN_BACKLOG,
    httpMaxConnections: parsed.CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS,
    wsMaxConnections: parsed.CPREDICT_INDEXER_WS_MAX_CONNECTIONS,
    wsHeartbeatIntervalMs: parsed.CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS,
    wsMaxBufferedAmountBytes:
      parsed.CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES,
    wsShutdownGraceMs: parsed.CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS,
  };
}

function parseAddressList(value: string): readonly Address[] {
  const result = new Map<string, Address>();
  for (const item of value.split(",")) {
    const trimmed = item.trim();
    if (!isAddress(trimmed))
      throw new TypeError("CORE_ADDRESSES contains an invalid address");
    const normalized = getAddress(trimmed);
    if (normalized === zeroAddress)
      throw new TypeError("CORE_ADDRESSES contains the zero address");
    result.set(normalized.toLowerCase(), normalized);
  }
  if (result.size === 0)
    throw new TypeError("CORE_ADDRESSES must not be empty");
  return [...result.values()];
}

function isSecureServiceUrl(value: string): boolean {
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
  if (isLoopback(url.hostname)) return true;
  return ["require", "verify-ca", "verify-full"].includes(
    url.searchParams.get("sslmode") ?? "",
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

function rejectUnknown(
  environment: Readonly<Record<string, string | undefined>>,
  prefix: string,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(environment)) {
    if (key.startsWith(prefix) && !allowed.has(key)) {
      throw new Error(`unsupported indexer environment variable: ${key}`);
    }
  }
}
