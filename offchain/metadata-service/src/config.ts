import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

const unsignedInteger = z.string().regex(/^(0|[1-9]\d*)$/);
const safeInteger = unsignedInteger.transform(Number).refine(Number.isSafeInteger);
const address = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value))
  .refine((value) => value !== zeroAddress);
const serviceHost = z.enum(["127.0.0.1", "::1", "0.0.0.0", "::"]);
const booleanString = z.enum(["true", "false"]);
const schema = z
  .object({
    CPREDICT_METADATA_HOST: serviceHost,
    CPREDICT_METADATA_CONTAINER_MODE: booleanString.default("false"),
    CPREDICT_METADATA_PORT: safeInteger.refine(
      (value) => value >= 1 && value <= 65_535,
    ),
    CPREDICT_METADATA_LOG_LEVEL: z.enum([
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
      "silent",
    ]),
    CPREDICT_METADATA_CHAIN_ID: z.literal("421614"),
    CPREDICT_METADATA_FACTORY_ADDRESS: address,
    CPREDICT_METADATA_PUBLIC_BASE_URL: z
      .string()
      .url()
      .transform((value) => value.replace(/\/$/, ""))
      .refine(isSecurePublicUrl, "must use HTTPS or loopback HTTP"),
    CPREDICT_METADATA_DATABASE_URL: z
      .string()
      .url()
      .refine(
        (value) => isSecurePostgresUrl(value) || isComposePostgresUrl(value),
        "must use secure PostgreSQL or the explicit Compose-internal endpoint",
      ),
    CPREDICT_METADATA_CHALLENGE_TTL_SECONDS: safeInteger.refine(
      (value) => value >= 60 && value <= 900,
    ),
    CPREDICT_METADATA_DATABASE_POOL_SIZE: safeInteger
      .default(5)
      .refine((value) => value >= 1 && value <= 20),
  })
  .superRefine((value, context) => {
    const publicBind = ["0.0.0.0", "::"].includes(value.CPREDICT_METADATA_HOST);
    const containerMode = value.CPREDICT_METADATA_CONTAINER_MODE === "true";
    if (publicBind !== containerMode) {
      context.addIssue({
        code: "custom",
        path: ["CPREDICT_METADATA_CONTAINER_MODE"],
        message: "must be true exactly when binding a container wildcard address",
      });
    }
    if (containerMode && !isComposePostgresUrl(value.CPREDICT_METADATA_DATABASE_URL)) {
      context.addIssue({
        code: "custom",
        path: ["CPREDICT_METADATA_DATABASE_URL"],
        message: "container mode only permits the internal postgres service",
      });
    }
  });

export interface MetadataServiceConfig {
  host: "127.0.0.1" | "::1" | "0.0.0.0" | "::";
  containerMode: boolean;
  port: number;
  logLevel: z.infer<(typeof schema)["shape"]["CPREDICT_METADATA_LOG_LEVEL"]>;
  chainId: 421_614;
  factory: Address;
  publicBaseUrl: string;
  databaseUrl: string;
  challengeTtlSeconds: number;
  databasePoolSize: number;
}

export function parseMetadataServiceConfig(
  environment: Readonly<Record<string, string | undefined>>,
): MetadataServiceConfig {
  const allowed = new Set(Object.keys(schema.shape));
  for (const key of Object.keys(environment))
    if (key.startsWith("CPREDICT_METADATA_") && !allowed.has(key))
      throw new Error(`unsupported metadata environment variable: ${key}`);
  const parsed = schema.parse(environment);
  return {
    host: parsed.CPREDICT_METADATA_HOST,
    containerMode: parsed.CPREDICT_METADATA_CONTAINER_MODE === "true",
    port: parsed.CPREDICT_METADATA_PORT,
    logLevel: parsed.CPREDICT_METADATA_LOG_LEVEL,
    chainId: 421_614,
    factory: parsed.CPREDICT_METADATA_FACTORY_ADDRESS,
    publicBaseUrl: parsed.CPREDICT_METADATA_PUBLIC_BASE_URL,
    databaseUrl: parsed.CPREDICT_METADATA_DATABASE_URL,
    challengeTtlSeconds: parsed.CPREDICT_METADATA_CHALLENGE_TTL_SECONDS,
    databasePoolSize: parsed.CPREDICT_METADATA_DATABASE_POOL_SIZE,
  };
}

function isSecurePublicUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function isSecurePostgresUrl(value: string): boolean {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return false;
  if (isLoopback(url.hostname)) return true;
  return ["require", "verify-ca", "verify-full"].includes(
    url.searchParams.get("sslmode") ?? "",
  );
}

function isComposePostgresUrl(value: string): boolean {
  const url = new URL(value);
  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === "postgres" &&
    url.pathname === "/cpredict_metadata" &&
    url.searchParams.get("sslmode") === "disable"
  );
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}
