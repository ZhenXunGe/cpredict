import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildCandidate } from "./prepare-environment.mjs";
import { env as template } from "../../dist/offchain/app-core/test/fixtures.js";
import {
  sessionPaymasterConfig,
  validatePendingManifest,
  CHAIN_ID,
  USDC,
  PERMIT2,
  ENTRY_POINT,
} from "../deployment/deploy-arbitrum-sepolia.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
function pending() {
  return {
    ...Object.fromEntries(
      [
        "temporaryAdmin",
        "governanceSafe",
        "emergencySafe",
        "protocolTreasury",
        "sponsorSigner",
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
        "tradingSessionPolicy",
        "tradingSessionPaymaster",
      ].map((key, n) => [key, address(n + 1)]),
    ),
    chainId: CHAIN_ID,
    status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    paymentTokenKind: "canonical-usdc",
    marketplaceVersion: "orderbook-v2",
    tradingSessionPaymasterCodehash: hash(44),
    factoryActivationFingerprint: hash(45),
    usdc: USDC,
    permit2: PERMIT2,
    entryPoint: ENTRY_POINT,
    marketResolutionWindowSeconds: 86400,
    paymasterPolicyVersion: 1,
    paymasterMaxCostPerOperation: "2000000000000000",
    paymasterMaxCostPerUserDay: "20000000000000000",
    paymasterMaxCostGlobalDay: "500000000000000000",
  };
}

test("isolated candidate preserves wallet and asset, changes contracts, and cannot open new exposure", () => {
  const p = {
    ...pending(),
    paymentTokenKind: "sandbox-test-token",
    usdc: template.deployment.paymentToken,
  };
  const codeHashes = Object.fromEntries(
    [
      p.factory,
      p.marketplace,
      p.bondEscrow,
      p.feeVault,
      p.usdc,
      p.tradingSessionPolicy,
    ].map((a) => [a.toLowerCase(), hash(55)]),
  );
  const args = {
    template,
    pending: p,
    sourceCommit: "a".repeat(40),
    deploymentBlock: "123",
    id: "ctusd-orderbook-v2",
    prefix: "/v2-test",
    codeHashes,
  };
  const result = buildCandidate(args);
  assert.deepEqual(result.account, template.account);
  assert.equal(result.privyAppId, template.privyAppId);
  assert.equal(result.features.newExposure, false);
  assert.equal(result.features.automaticClaims, true);
  assert.equal(result.deployment.marketplaceVersion, "orderbook-v2");
  assert.throws(
    () =>
      buildCandidate({
        ...args,
        pending: { ...p, factory: template.deployment.factory },
      }),
    /new_factory_required/,
  );
  assert.throws(
    () => buildCandidate({ ...args, pending: { ...p, usdc: address(999) } }),
    /payment_asset_must_be_preserved/,
  );
  assert.throws(
    () => buildCandidate({ ...args, codeHashes: {} }),
    /verified_code_hash_required/,
  );
});
test("V2 pending evidence requires its policy and pinned external paymaster", () => {
  assert.equal(
    validatePendingManifest(pending()).marketplaceVersion,
    "orderbook-v2",
  );
  assert.throws(
    () =>
      validatePendingManifest({
        ...pending(),
        tradingSessionPolicy: undefined,
      }),
    /tradingSessionPolicy/,
  );
  assert.throws(
    () =>
      validatePendingManifest({
        ...pending(),
        tradingSessionPaymasterCodehash: hash(0),
      }),
    /Codehash/,
  );
  assert.throws(
    () => sessionPaymasterConfig({ TRADING_SESSION_PAYMASTER: address(5) }),
    /CODEHASH/,
  );
  assert.deepEqual(
    sessionPaymasterConfig({
      TRADING_SESSION_PAYMASTER: address(5),
      TRADING_SESSION_PAYMASTER_CODEHASH: hash(5),
    }),
    { address: address(5), runtimeCodehash: hash(5) },
  );
});
test("V2 and V1 defaults keep separate pending manifests and state directories", () => {
  for (const variant of ["", "orderbook-v2"]) {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {parseArgs} from './scripts/deployment/deploy-arbitrum-sepolia.mjs'; console.log(JSON.stringify(parseArgs(['status'])));",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CPREDICT_DEPLOYMENT_VARIANT: variant },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pendingPath.includes("/orderbook-v2/"), !!variant);
    assert.equal(parsed.stateDir.includes("/orderbook-v2/"), !!variant);
  }
});
test("V2 entrypoint rejects a legacy manifest instead of silently using its ABI", () => {
  const legacy = pending();
  delete legacy.marketplaceVersion;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {readFileSync} from 'node:fs'; import {validatePendingManifest} from './scripts/deployment/deploy-arbitrum-sepolia.mjs'; validatePendingManifest(JSON.parse(readFileSync(0,'utf8')));",
    ],
    {
      input: JSON.stringify(legacy),
      encoding: "utf8",
      env: { ...process.env, CPREDICT_DEPLOYMENT_VARIANT: "orderbook-v2" },
    },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /marketplaceVersion/);
});
