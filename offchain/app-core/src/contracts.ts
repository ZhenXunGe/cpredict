import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

export const address = z
  .string()
  .refine(isAddress)
  .transform((v) => getAddress(v))
  .refine((v) => v !== zeroAddress);
export const hash = z
  .string()
  .regex(/^0x[\da-fA-F]{64}$/)
  .transform((v) => v as Hex);
export const bytes = z
  .string()
  .max(65_538)
  .regex(/^0x(?:[\da-fA-F]{2})*$/)
  .transform((v) => v as Hex);
export const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/, { abort: true })
  .refine((v) => BigInt(v) < 2n ** 256n, { abort: true });
export const positive = uint.refine((v) => BigInt(v) > 0n, { abort: true });
export const signedAmount = z.string().regex(/^-?(0|[1-9]\d{0,77})$/);
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const secureUrl = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return (
      !u.username &&
      !u.password &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    );
  });
export const servicePath = z.string().regex(/^\/[a-zA-Z0-9/_-]*$/);

export const deploymentSchema = z.strictObject({
  id,
  protocolVersion: z.enum(["legacy-v1", "time-v2"]).optional(),
  manifestHash: hash,
  sourceCommit: z.string().regex(/^[\da-f]{40}$/),
  chainId: z.literal(421614),
  deploymentBlock: uint,
  factory: address,
  marketplace: address,
  bondEscrow: address,
  feeVault: address,
  paymentToken: address,
  protocolTreasury: address,
  runtimeCodeHashes: z.record(z.string().regex(/^0x[\da-f]{40}$/), hash),
});

export const environmentSchema = z
  .strictObject({
    id,
    label: z.string().min(1).max(64),
    asset: z.enum(["ctUSD", "USDC"]),
    decimals: z.literal(6),
    deployment: deploymentSchema,
    account: z.strictObject({
      kernelVersion: z.literal("0.3.1"),
      entryPointVersion: z.literal("0.7"),
      index: uint,
      derivationVersion: z.literal(1),
    }),
    services: z.strictObject({
      app: servicePath,
      indexer: servicePath,
      metadata: servicePath,
      rpc: servicePath,
    }),
    privyAppId: z.string().min(1).max(128),
    // Omit to use Privy's app-level configuration or its SDK default.
    walletConnectProjectId: z.string().trim().min(1).max(128).optional(),
    explorerUrl: secureUrl,
    // Accepted only for existing runtime files; the retired Demo has no UI entry.
    legacyUrl: z
      .string()
      .max(512)
      .refine((v) => v.startsWith("/") && !v.startsWith("//"))
      .optional(),
    features: z.strictObject({
      newExposure: z.boolean(),
      faucet: z.boolean(),
      leaderboard: z.boolean(),
      sponsorship: z.boolean(),
      gaslessDeposit: z.boolean().optional(),
    }),
  })
  .superRefine((v, ctx) => {
    if (
      v.features.gaslessDeposit &&
      (v.asset !== "USDC" || v.account.index !== "1002")
    )
      ctx.addIssue({
        code: "custom",
        path: ["features", "gaslessDeposit"],
        message:
          "gasless deposits require the USDC environment and fixed account index 1002",
      });
    if (
      v.asset === "USDC" &&
      v.deployment.paymentToken.toLowerCase() !==
        "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"
    )
      ctx.addIssue({
        code: "custom",
        path: ["deployment", "paymentToken"],
        message: "USDC must match the Circle Arbitrum Sepolia test token",
      });
    if (v.asset === "USDC" && v.features.faucet)
      ctx.addIssue({
        code: "custom",
        path: ["features", "faucet"],
        message: "ctUSD mint sponsorship is unavailable in USDC",
      });
  });
export type Environment = z.infer<typeof environmentSchema>;
export const siteConfigSchema = z
  .strictObject({
    version: z.literal(1),
    defaultEnvironment: id.nullable(),
    environments: z.array(environmentSchema).max(8),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>(),
      accounts = new Set<string>(),
      deployments = new Set<string>(),
      apps = new Set<string>();
    for (const e of v.environments) {
      const accountKey = `${e.deployment.chainId}:${e.account.index}:${e.account.kernelVersion}`;
      if (
        ids.has(e.id) ||
        accounts.has(accountKey) ||
        deployments.has(e.deployment.id) ||
        apps.has(e.privyAppId)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "environments require distinct identities, account indexes, deployments and Privy projects",
        });
      ids.add(e.id);
      accounts.add(accountKey);
      deployments.add(e.deployment.id);
      apps.add(e.privyAppId);
    }
    if (v.defaultEnvironment !== null && !ids.has(v.defaultEnvironment))
      ctx.addIssue({
        code: "custom",
        message: "default environment is missing",
      });
  });

export function environmentKey(e: Environment): string {
  return `${e.id}:${e.deployment.id}:${e.deployment.manifestHash.toLowerCase()}`;
}

export const accountSchema = z.strictObject({
  id: z.string().uuid(),
  environment: id,
  deploymentId: id,
  controller: address,
  address,
  walletKind: z.enum(["embedded", "external"]),
  kernelVersion: z.literal("0.3.1"),
  entryPointVersion: z.literal("0.7"),
  index: uint,
  derivationVersion: z.literal(1),
  createdAt: z.string().datetime(),
});
export type AppAccount = z.infer<typeof accountSchema>;

const market = { market: address };
const createParams = z.strictObject({
  rulesHash: hash,
  metadataURI: secureUrl.max(512),
  resolutionSourceHash: hash,
  resolutionSourceURI: secureUrl.max(512),
  outcomeCount: z.number().int().min(2).max(32),
  closeAt: positive,
  eventStartsAt: uint,
  outcomeDeadlineAt: positive,
  creatorTreasury: address,
  deploymentMode: z.union([z.literal(0), z.literal(1)]),
  featureFlags: uint,
  creatorRakeBps: z.number().int().min(0).max(10_000),
  creatorC2CFeeBps: z.number().int().min(0).max(10_000),
  perUserPrimaryCap: positive,
  marketPrimaryCap: positive,
  minimumPrimaryUnits: positive,
  minimumC2CUnits: positive,
  creatorBond: positive,
});
export const receiveAuthorizationSchema = z.strictObject({
  from: address,
  to: address,
  value: positive,
  validAfter: uint,
  validBefore: positive,
  nonce: hash.transform((v) => v.toLowerCase() as Hex),
});
export const depositPrepareSchema = z.strictObject({
  accountId: z.string().uuid(),
  source: address,
  amount: positive,
  idempotencyKey: z.string().uuid(),
});
export const usdcDomainSchema = z.strictObject({
  name: z.string().min(1).max(100),
  version: z.literal("2"),
  chainId: z.literal(421614),
  verifyingContract: z.literal("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
});
export const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("faucet") }),
  z.strictObject({
    kind: z.literal("deposit-usdc"),
    depositId: z.string().uuid(),
    authorization: receiveAuthorizationSchema,
    signature: z
      .string()
      .regex(/^0x[\da-fA-F]{130}$/)
      .transform((v) => v.toLowerCase() as Hex),
  }),
  z.strictObject({
    kind: z.literal("buy"),
    ...market,
    outcomeId: uint,
    units: positive,
    minUnits: positive,
    maxPayment: positive,
    deadline: positive,
  }),
  z.strictObject({
    kind: z.literal("create-market"),
    params: createParams,
    userSalt: hash,
    maxPayment: positive,
  }),
  z.strictObject({
    kind: z.literal("create-listing"),
    ...market,
    outcomeId: uint,
    units: positive,
    unitPrice: positive,
    expiresAt: positive,
  }),
  z.strictObject({
    kind: z.literal("fill-listing"),
    listingId: hash,
    units: positive,
    minUnits: positive,
    maxPayment: positive,
    deadline: positive,
  }),
  z.strictObject({ kind: z.literal("cancel-listing"), listingId: hash }),
  z.strictObject({ kind: z.literal("return-listing"), listingId: hash }),
  z.strictObject({
    kind: z.literal("resolve"),
    ...market,
    outcomeId: uint,
    evidenceHash: hash,
  }),
  z.strictObject({
    kind: z.literal("creator-void"),
    ...market,
    evidenceHash: hash,
  }),
  z.strictObject({ kind: z.literal("void-timeout"), ...market }),
  z.strictObject({ kind: z.literal("claim-winner"), ...market }),
  z.strictObject({ kind: z.literal("claim-early-bird"), ...market }),
  z.strictObject({ kind: z.literal("refund"), ...market }),
  z.strictObject({ kind: z.literal("claim-timeout-bonus"), ...market }),
  z.strictObject({ kind: z.literal("settle-bond"), ...market }),
  z.strictObject({ kind: z.literal("claim-bond") }),
  z.strictObject({ kind: z.literal("claim-fees") }),
  z.strictObject({
    kind: z.literal("transfer"),
    recipient: address,
    amount: positive,
  }),
]);
export type BusinessIntent = z.infer<typeof intentSchema>;
export type OperationKind = BusinessIntent["kind"];
export type BudgetLane = "exposure" | "exit";
export function budgetLane(kind: OperationKind): BudgetLane {
  return [
    "faucet",
    "deposit-usdc",
    "buy",
    "create-market",
    "create-listing",
    "fill-listing",
  ].includes(kind)
    ? "exposure"
    : "exit";
}
export const callSchema = z.strictObject({
  to: address,
  data: bytes,
  value: z.literal("0"),
});
export type BusinessCall = z.infer<typeof callSchema>;
export const preparedOperationSchema = z.strictObject({
  account: accountSchema,
  nonce: uint,
  calls: z.array(callSchema).min(1).max(8),
  callData: bytes,
  factory: address.nullable(),
  factoryData: bytes.nullable(),
  maxGasCost: positive,
  expiresInSeconds: z.number().int().min(60).max(300),
});
export const registerOperationSchema = z.strictObject({
  environment: id,
  deploymentId: id,
  accountId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  intent: intentSchema,
  nonce: uint,
  callData: bytes,
  factory: address.nullable(),
  factoryData: bytes.nullable(),
});
export const operationStateSchema = z.enum([
  "preparing",
  "awaiting-signature",
  "submitted",
  "confirming",
  "confirmed",
  "reverted",
  "cancelled",
  "unknown",
]);
export type OperationState = z.infer<typeof operationStateSchema>;
export const operationSchema = z.strictObject({
  id: z.string().uuid(),
  environment: id,
  deploymentId: id,
  accountId: z.string().uuid(),
  account: address,
  kind: z.enum([
    "faucet",
    "deposit-usdc",
    "buy",
    "create-market",
    "create-listing",
    "fill-listing",
    "cancel-listing",
    "return-listing",
    "resolve",
    "creator-void",
    "void-timeout",
    "claim-winner",
    "claim-early-bird",
    "refund",
    "claim-timeout-bonus",
    "settle-bond",
    "claim-bond",
    "claim-fees",
    "transfer",
  ]),
  intent: intentSchema,
  state: operationStateSchema,
  nonce: uint,
  calls: z.array(callSchema).min(1).max(8),
  callData: bytes,
  factory: address.nullable(),
  factoryData: bytes.nullable(),
  providerOperationId: z.string().max(256).nullable(),
  userOperationHash: hash.nullable(),
  transactionHash: hash.nullable(),
  blockNumber: uint.nullable(),
  blockHash: hash.nullable(),
  actualGasCost: uint.nullable(),
  finality: z
    .enum(["pending", "application-confirmed", "finalized"])
    .default("pending"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxGasCost: positive,
  lane: z.enum(["exposure", "exit"]),
  reason: z.string().max(128).nullable(),
});
export type Operation = z.infer<typeof operationSchema>;
export const depositSchema = z.strictObject({
  id: z.string().uuid(),
  environment: id,
  deploymentId: id,
  accountId: z.string().uuid(),
  account: address,
  domain: usdcDomainSchema,
  authorization: receiveAuthorizationSchema,
  state: z.union([
    operationStateSchema,
    z.enum(["awaiting-authorization", "expired"]),
  ]),
  operationId: z.string().uuid().nullable(),
  userOperationHash: hash.nullable(),
  transactionHash: hash.nullable(),
  blockNumber: uint.nullable(),
  blockHash: hash.nullable(),
  actualGasCost: uint.nullable(),
  finality: z.enum(["pending", "application-confirmed", "finalized"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  reason: z.string().max(128).nullable(),
});
export type Deposit = z.infer<typeof depositSchema>;
export const depositPageSchema = z.strictObject({
  items: z.array(depositSchema),
  nextCursor: z.string().nullable(),
});
export const depositReportQuerySchema = z
  .strictObject({
    start: z.string().datetime(),
    end: z.string().datetime(),
    accountId: z.string().uuid().optional(),
    source: address.optional(),
    id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .refine(
    (q) =>
      Date.parse(q.end) > Date.parse(q.start) &&
      Date.parse(q.end) - Date.parse(q.start) <= 32 * 86400000,
    "deposit report requires a positive interval of at most 32 days",
  );
export type DepositReportQuery = z.infer<typeof depositReportQuerySchema>;
export function isRecoverable(s: OperationState): boolean {
  return ["submitted", "confirming", "unknown"].includes(s);
}

export const errorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().max(64),
    message: z.string().max(256),
    operationId: z.string().uuid().optional(),
  }),
});
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message = code,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as T;
}
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
export function accountIdentity(account: AppAccount): string {
  return `${account.environment}:${account.deploymentId}:${account.address.toLowerCase()}`;
}
export type VerifiedIdentity = {
  subject: string;
  controllers: readonly { address: Address; kind: "embedded" | "external" }[];
};
