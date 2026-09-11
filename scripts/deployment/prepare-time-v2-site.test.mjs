import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTimeV2Runtime,
  verifyCreationInputs,
} from "./prepare-time-v2-site.mjs";
import { env } from "../../dist/offchain/app-core/test/fixtures.js";
import { ENTRY_POINT, PERMIT2 } from "./deploy-arbitrum-sepolia.mjs";
const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture() {
  const previous = {
    environment: {
      ...env,
      deployment: { ...env.deployment, protocolVersion: "legacy-v1" },
    },
    sponsor: null,
    allowedOrigins: ["https://example.test"],
    adminSubjects: [],
  };
  const pending = {
    chainId: 421614,
    status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    paymentTokenKind: "sandbox-test-token",
    paymentTokenReused: true,
    paymentTokenRuntimeCodehash: hash(77),
    usdc: env.deployment.paymentToken,
    permit2: PERMIT2,
    entryPoint: ENTRY_POINT,
    factoryActivationFingerprint: hash(3),
    marketResolutionWindowSeconds: 86400,
    paymasterPolicyVersion: 1,
    paymasterMaxCostPerOperation: "1",
    paymasterMaxCostPerUserDay: "2",
    paymasterMaxCostGlobalDay: "3",
  };
  for (const [i, k] of [
    "timelock",
    "config",
    "emergencyController",
    "exposureGuard",
    "feeVault",
    "bondEscrow",
    "cloneImplementation",
    "fullMarketDeployer",
    "factory",
    "marketplace",
    "paymaster",
    "temporaryAdmin",
    "governanceSafe",
    "emergencySafe",
    "protocolTreasury",
    "sponsorSigner",
  ].entries())
    pending[k] = address(i + 21);
  const runtimeCodeHashes = Object.fromEntries(
    [
      pending.factory,
      pending.marketplace,
      pending.bondEscrow,
      pending.feeVault,
      pending.usdc,
    ].map((a) => [a.toLowerCase(), hash(77)]),
  );
  return {
    previous,
    pending,
    sourceCommit: "a".repeat(40),
    deploymentBlock: "100",
    runtimeCodeHashes,
  };
}
test("retargeting preserves login, account derivation, settings and ctUSD while replacing all protocol contracts", async () => {
  const f = fixture(),
    next = await buildTimeV2Runtime(f);
  assert.equal(next.environment.deployment.protocolVersion, "time-v2");
  assert.equal(
    next.environment.deployment.paymentToken,
    f.previous.environment.deployment.paymentToken,
  );
  assert.deepEqual(next.environment.account, f.previous.environment.account);
  assert.equal(next.environment.privyAppId, f.previous.environment.privyAppId);
  assert.deepEqual(next.allowedOrigins, f.previous.allowedOrigins);
  assert.equal(next.minimumOperationBlock, "100");
  assert.notEqual(
    next.environment.deployment.id,
    f.previous.environment.deployment.id,
  );
});
test("retargeting rejects a new token, an unverified token hash or an unchanged legacy contract", async () => {
  const f = fixture();
  await assert.rejects(
    buildTimeV2Runtime({ ...f, pending: { ...f.pending, usdc: address(88) } }),
    /reuse/,
  );
  await assert.rejects(
    buildTimeV2Runtime({
      ...f,
      pending: { ...f.pending, paymentTokenRuntimeCodehash: hash(88) },
    }),
    /hash mismatch/,
  );
  await assert.rejects(
    buildTimeV2Runtime({
      ...f,
      pending: { ...f.pending, factory: env.deployment.factory },
    }),
    /rollover_reuses_legacy_contract/,
  );
});
test("source validation rejects a receipt-only bundle without matching creation inputs", async () => {
  const f = fixture();
  await assert.rejects(
    verifyCreationInputs(
      f.pending,
      {
        transactions: [],
        receipts: Array.from({ length: 12 }, (_, i) => ({
          status: "0x1",
          transactionHash: hash(i + 1),
        })),
      },
      async () => ({ bytecode: { object: "0x123456789012" } }),
    ),
    /missing creation/,
  );
});
