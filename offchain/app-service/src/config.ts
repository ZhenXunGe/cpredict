import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  environmentSchema,
  positive,
  secureUrl,
  uint,
} from "../../app-core/src/contracts.js";

const laneLimit = z.strictObject({
  projectWei: positive,
  accountWei: positive,
  subjectWei: positive,
  projectOperations: z.number().int().positive(),
  accountOperations: z.number().int().positive(),
  subjectOperations: z.number().int().positive(),
});
export const weeklyBudgetSchema = z
  .strictObject({
    window: z.literal("shanghai-monday"),
    projectWei: positive,
    exitReserveWei: positive,
  })
  .refine((v) => BigInt(v.exitReserveWei) < BigInt(v.projectWei), {
    message:
      "weekly exit reserve must be smaller than the total project budget",
  });
export const sponsorConfigSchema = z
  .strictObject({
    projectId: z.string().min(1).max(128),
    providerHardLimitUsd: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .refine((v) => Number(v) > 0)
      .nullable()
      .default(null),
    providerHardLimitWei: positive.nullable().default(null),
    providerHardLimitPeriodSeconds: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null),
    policyOperator: z.literal("and"),
    passOnError: z.literal(false),
    maxCostPerOperation: positive,
    validitySeconds: z.number().int().min(60).max(300),
    exposure: laneLimit,
    exit: laneLimit,
    methodDailyOperations: z.number().int().min(1).max(1000),
    weekly: weeklyBudgetSchema,
  })
  .superRefine((v, ctx) => {
    if (v.providerHardLimitUsd === null && v.providerHardLimitWei === null)
      ctx.addIssue({
        code: "custom",
        message: "an explicit provider hard limit is required",
      });
    if (
      (v.providerHardLimitWei === null) !==
      (v.providerHardLimitPeriodSeconds === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "native provider hard limit requires its exact interval",
      });
    if (
      BigInt(v.maxCostPerOperation) > BigInt(v.weekly.exitReserveWei) ||
      BigInt(v.maxCostPerOperation) >
        BigInt(v.weekly.projectWei) - BigInt(v.weekly.exitReserveWei)
    )
      ctx.addIssue({
        code: "custom",
        message: "each weekly lane must cover at least one operation",
      });
  });
export type SponsorConfig = z.infer<typeof sponsorConfigSchema>;
export const appRuntimeSchema = z.strictObject({
  environment: environmentSchema,
  sponsor: sponsorConfigSchema.nullable(),
  allowedOrigins: z.array(secureUrl).min(1).max(20),
  adminSubjects: z.array(z.string().startsWith("did:privy:").max(160)).max(100),
  trustedProxies: z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(8)
    .default([]),
  confirmations: z.number().int().min(1).max(100).default(2),
  minimumOperationBlock: uint.default("0"),
});
export type AppRuntime = z.infer<typeof appRuntimeSchema>;
export interface ServiceConfig {
  runtime: AppRuntime;
  host: string;
  port: number;
  databaseUrl: string;
  rpcUrl: string;
  metadataUrl: string;
  privySecret: string;
  bundlerUrl: string | undefined;
  paymasterUrl: string | undefined;
}
export async function loadServiceConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<ServiceConfig> {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const runtime = appRuntimeSchema.parse(
    JSON.parse(await readFile(required("CPREDICT_APP_CONFIG_FILE"), "utf8")),
  );
  const databaseUrl = required("CPREDICT_APP_DATABASE_URL");
  const db = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(db.hostname) &&
      !["require", "verify-full"].includes(
        db.searchParams.get("sslmode") ?? "",
      ))
  )
    throw new Error(
      "app database requires PostgreSQL with TLS or a local endpoint",
    );
  const bundlerUrl = env.CPREDICT_APP_ZERODEV_BUNDLER_URL
    ? secureUrl.parse(env.CPREDICT_APP_ZERODEV_BUNDLER_URL)
    : undefined;
  const paymasterUrl = env.CPREDICT_APP_ZERODEV_PAYMASTER_URL
    ? secureUrl.parse(env.CPREDICT_APP_ZERODEV_PAYMASTER_URL)
    : undefined;
  if (
    runtime.environment.features.sponsorship &&
    (!runtime.sponsor || !bundlerUrl || !paymasterUrl)
  )
    throw new Error(
      "sponsorship requires Bundler and Paymaster endpoints (the same ZeroDev RPC is supported) and an explicit hard-cap / AND / fail-closed policy configuration",
    );
  if (runtime.sponsor) {
    for (const endpoint of [bundlerUrl, paymasterUrl]) {
      if (!endpoint) continue;
      const url = new URL(endpoint);
      if (
        url.hostname !== "rpc.zerodev.app" ||
        url.protocol !== "https:" ||
        url.port ||
        url.hash ||
        url.pathname !==
          `/api/v3/${runtime.sponsor.projectId}/chain/${runtime.environment.deployment.chainId}`
      )
        throw new Error(
          "ZeroDev endpoint must match the environment's project and chain",
        );
    }
  }
  return {
    runtime,
    databaseUrl,
    host: z
      .enum(["127.0.0.1", "::1", "0.0.0.0"])
      .parse(env.CPREDICT_APP_HOST ?? "127.0.0.1"),
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.CPREDICT_APP_PORT ?? "8795"),
    rpcUrl: secureUrl.parse(required("CPREDICT_APP_RPC_URL")),
    metadataUrl: secureUrl.parse(required("CPREDICT_APP_METADATA_URL")),
    privySecret: required("CPREDICT_APP_PRIVY_SECRET"),
    bundlerUrl,
    paymasterUrl,
  };
}
