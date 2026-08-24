import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRuntimePackage, parseSyncArgs, writeRuntimePackage } from "./sync-runtime.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const pending = {
  chainId: 421614,
  status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
  sourceManifestSha256: "a".repeat(64),
  timelock: address("1"), config: address("2"), emergencyController: address("3"),
  exposureGuard: address("4"), feeVault: address("5"), bondEscrow: address("6"),
  cloneImplementation: address("7"), fullMarketDeployer: address("8"), factory: address("9"),
  marketplace: address("a"), paymaster: address("b"), governanceSafe: address("c"),
  emergencySafe: address("d"), temporaryAdmin: address("e"),
  protocolTreasury: address("f"), sponsorSigner: address("e"),
  paymasterPolicyVersion: 1,
  paymasterMaxCostPerOperation: "2000000000000000",
  paymasterMaxCostPerUserDay: "20000000000000000",
  paymasterMaxCostGlobalDay: "500000000000000000",
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
};

const finalDeployment = {
  chainId: 421614,
  status: "FINALIZED_VERIFIED",
  source: { sourceManifestSha256: "a".repeat(64) },
  contracts: Object.fromEntries([
    "timelock", "config", "emergencyController", "exposureGuard", "feeVault", "bondEscrow",
    "cloneImplementation", "fullMarketDeployer", "factory", "marketplace", "paymaster",
  ].map((key, index) => [key, { address: address(((index + 1) % 16).toString(16)) }])),
  externalContracts: {
    usdc: { address: pending.usdc }, permit2: { address: pending.permit2 }, entryPoint: { address: pending.entryPoint },
  },
  actors: {
    governanceSafe: { address: pending.governanceSafe },
    emergencySafe: { address: pending.emergencySafe },
    sponsorSigner: pending.sponsorSigner,
  },
  configuration: {
    paymasterPolicyVersion: 2,
    paymasterMaxCostPerOperation: "1",
    paymasterMaxCostPerUserDay: "2",
    paymasterMaxCostGlobalDay: "3",
  },
};

test("candidate package remains DEBUG and never emits final.json", () => {
  const result = buildRuntimePackage({
    mode: "candidate", deployment: pending, deploymentBlock: 123,
    inputSha256: "f".repeat(64),
  });
  assert.equal(result.packageManifest.mode, "DEBUG");
  assert.equal(result.files["web-demo/deployment/final.json"], undefined);
  assert.match(result.files["web-demo/deployment/debug-addresses.json"], /DEBUG_NOT_FINALIZED/);
  assert.match(result.files["compose.env"], /CPREDICT_INDEXER_DEPLOYMENT_BLOCK=123/);
  assert.doesNotMatch(result.files["compose.env"], /RPC|PASSWORD|PRIVATE|TOKEN/);
});

test("argument parser rejects ambiguous or duplicate input", () => {
  assert.deepEqual(parseSyncArgs(["candidate", "--pending", "x", "--deployment-block", "1"]), {
    mode: "candidate", pending: "x", deploymentBlock: "1",
  });
  assert.throws(() => parseSyncArgs(["candidate", "--pending", "x", "--pending", "y"]), /duplicate/);
  assert.throws(() => parseSyncArgs(["release"]), /usage/);
});

test("package file hashes bind every generated payload", async () => {
  const result = buildRuntimePackage({
    mode: "candidate", deployment: pending, deploymentBlock: 456,
    inputSha256: "0".repeat(64),
  });
  assert.equal(Object.keys(result.packageManifest.files).length, Object.keys(result.files).length - 1);
  assert.equal(result.packageManifest.sourceManifestSha256, pending.sourceManifestSha256);
});

test("final package emits final.json and rejects debug or wrong-chain promotion", () => {
  const result = buildRuntimePackage({
    mode: "final", deployment: finalDeployment, deploymentBlock: 789,
    inputSha256: "d".repeat(64),
  });
  assert.equal(result.packageManifest.mode, "FINALIZED_VERIFIED");
  assert.match(result.files["web-demo/deployment/final.json"], /FINALIZED_VERIFIED/);
  assert.equal(result.files["web-demo/deployment/debug-addresses.json"], undefined);
  assert.throws(() => buildRuntimePackage({ mode: "final", deployment: pending, deploymentBlock: 1, inputSha256: "e".repeat(64) }), /FINALIZED_VERIFIED/);
  assert.throws(() => buildRuntimePackage({ mode: "candidate", deployment: { ...pending, chainId: 1 }, deploymentBlock: 1, inputSha256: "e".repeat(64) }), /421614/);
});

test("runtime writer publishes an immutable package and atomic current env", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-runtime-boundary-"));
  const output = join(boundary, "packages");
  const pkg = buildRuntimePackage({ mode: "candidate", deployment: pending, deploymentBlock: 9, inputSha256: "9".repeat(64) });
  const first = await writeRuntimePackage(pkg, { outputRoot: output, runtimeBoundary: boundary });
  const second = await writeRuntimePackage(pkg, { outputRoot: output, runtimeBoundary: boundary });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.match(await readFile(join(output, "current.env"), "utf8"), new RegExp(pkg.identity));
  await assert.rejects(writeRuntimePackage(pkg, { outputRoot: join(boundary, "..", "escape"), runtimeBoundary: boundary }), /escapes/);
});
