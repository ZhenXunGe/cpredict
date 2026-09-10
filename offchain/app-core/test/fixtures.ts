import { getAddress } from "viem";
import {
  accountSchema,
  environmentSchema,
  operationSchema,
} from "../src/contracts.js";
export const A = (n: number) =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`);
export const H = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}` as const;
export const env = environmentSchema.parse({
  id: "ctusd-test",
  label: "ctUSD 公开测试",
  asset: "ctUSD",
  decimals: 6,
  deployment: {
    id: "deployment-test",
    manifestHash: H(1),
    sourceCommit: "a".repeat(40),
    chainId: 421614,
    deploymentBlock: "1",
    factory: A(1),
    marketplace: A(2),
    bondEscrow: A(3),
    feeVault: A(4),
    paymentToken: A(5),
    protocolTreasury: A(6),
    runtimeCodeHashes: {},
  },
  account: {
    kernelVersion: "0.3.1",
    entryPointVersion: "0.7",
    index: "1001",
    derivationVersion: 1,
  },
  services: {
    app: "/ctusd/app",
    indexer: "/ctusd/indexer/public",
    metadata: "/ctusd/metadata",
    rpc: "/ctusd/app/v1/rpc",
  },
  privyAppId: "privy-test",
  walletConnectProjectId: "wallet-connect-test",
  explorerUrl: "https://sepolia.arbiscan.io",
  features: {
    newExposure: true,
    sponsorship: true,
    faucet: true,
    leaderboard: true,
  },
});
export const appAccount = accountSchema.parse({
  id: "10000000-0000-4000-8000-000000000001",
  environment: env.id,
  deploymentId: env.deployment.id,
  controller: A(10),
  address: A(11),
  walletKind: "external",
  ...env.account,
  createdAt: "2026-09-09T00:00:00.000Z",
});
export const operation = operationSchema.parse({
  id: "20000000-0000-4000-8000-000000000001",
  environment: env.id,
  deploymentId: env.deployment.id,
  accountId: appAccount.id,
  account: appAccount.address,
  kind: "transfer",
  intent: { kind: "transfer", recipient: A(12), amount: "1000000" },
  state: "awaiting-signature",
  nonce: "0",
  calls: [{ to: A(5), data: "0x1234", value: "0" }],
  callData: "0x1234",
  factory: null,
  factoryData: null,
  providerOperationId: null,
  userOperationHash: null,
  transactionHash: null,
  blockNumber: null,
  blockHash: null,
  actualGasCost: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  expiresAt: "2026-09-09T00:05:00.000Z",
  maxGasCost: "1000000000000000",
  lane: "exit",
  reason: null,
});
