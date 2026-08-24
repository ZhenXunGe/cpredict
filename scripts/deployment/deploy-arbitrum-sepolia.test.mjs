import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CHAIN_ID,
  ENTRY_POINT,
  FINGERPRINT_MARKER,
  PERMIT2,
  USDC,
  extractFingerprint,
  parseArgs,
  parseEnvText,
  validateBroadcastDocument,
  validatePendingManifest,
} from "./deploy-arbitrum-sepolia.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;

function pendingManifest() {
  return {
    chainId: CHAIN_ID,
    status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    temporaryAdmin: address(1),
    governanceSafe: address(2),
    emergencySafe: address(3),
    protocolTreasury: address(16),
    sponsorSigner: address(17),
    paymasterPolicyVersion: 1,
    paymasterMaxCostPerOperation: "2000000000000000",
    paymasterMaxCostPerUserDay: "20000000000000000",
    paymasterMaxCostGlobalDay: "500000000000000000",
    timelock: address(4),
    config: address(5),
    emergencyController: address(6),
    exposureGuard: address(7),
    feeVault: address(8),
    bondEscrow: address(9),
    cloneImplementation: address(10),
    fullMarketDeployer: address(11),
    factory: address(12),
    marketplace: address(13),
    paymaster: address(14),
    factoryActivationFingerprint: hash(15),
    usdc: USDC,
    permit2: PERMIT2,
    entryPoint: ENTRY_POINT,
  };
}

test("safe env parser accepts literals without evaluating shell syntax", () => {
  const env = parseEnvText("RPC=https://example.test/a?x=1\nQUOTED=\"hello world\"\n");
  assert.equal(env.RPC, "https://example.test/a?x=1");
  assert.equal(env.QUOTED, "hello world");
  assert.throws(() => parseEnvText("KEY=$(id)\n"), /forbidden/);
  assert.throws(() => parseEnvText("KEY=one\nKEY=two\n"), /duplicate/);
  assert.throws(() => parseEnvText("export KEY=one\n"), /KEY=VALUE/);
});

test("CLI parser exposes staged and one-command deployment flows", () => {
  const parsed = parseArgs([
    "all",
    "--profile",
    "debug",
    "--wait-for-timelock",
    "--poll-seconds",
    "10",
    "--yes",
  ]);
  assert.equal(parsed.command, "all");
  assert.equal(parsed.profile, "debug");
  assert.equal(parsed.waitForTimelock, true);
  assert.equal(parsed.pollSeconds, 10);
  assert.equal(parsed.yes, true);
  assert.throws(() => parseArgs(["deploy", "--poll-seconds", "1"]), />= 5/);
  assert.throws(() => parseArgs(["launch"]), /unknown command/);
});

test("fingerprint parser requires the explicit Solidity preview marker", () => {
  const expected = hash(123);
  assert.equal(
    extractFingerprint(`noise\n${FINGERPRINT_MARKER}\n${expected}\n`),
    expected,
  );
  assert.throws(() => extractFingerprint(expected), /marker/);
  assert.throws(() => extractFingerprint(`${FINGERPRINT_MARKER}\n0x12`), /bytes32/);
});

test("pending manifest binds canonical Arbitrum Sepolia dependencies", () => {
  assert.equal(
    validatePendingManifest(pendingManifest()).factory.toLowerCase(),
    address(12),
  );
  const wrongChain = pendingManifest();
  wrongChain.chainId = 1;
  assert.throws(() => validatePendingManifest(wrongChain), /chainId/);
  const wrongUsdc = pendingManifest();
  wrongUsdc.usdc = address(999);
  assert.throws(() => validatePendingManifest(wrongUsdc), /usdc mismatch/);
  const wrongBudget = pendingManifest();
  wrongBudget.paymasterMaxCostPerUserDay = "1";
  assert.throws(() => validatePendingManifest(wrongBudget), /budget ordering/);
});

test("broadcast evidence requires enough successful transaction receipts", () => {
  const fixture = {
    receipts: Array.from({ length: 12 }, (_, index) => ({
      status: "0x1",
      transactionHash: hash(index + 1),
    })),
  };
  assert.deepEqual(validateBroadcastDocument(fixture, 12), { receipts: 12 });
  fixture.receipts[3].status = "0x0";
  assert.throws(() => validateBroadcastDocument(fixture, 12), /not successful/);
  assert.throws(
    () => validateBroadcastDocument({ receipts: fixture.receipts.slice(0, 3) }, 12),
    /expected >= 12/,
  );
});

test("shell entrypoint provides help without credentials or network", () => {
  const result = spawnSync(
    "bash",
    ["scripts/deployment/deploy-arbitrum-sepolia.sh", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cpredict Arbitrum Sepolia deployment orchestrator/);
  assert.match(result.stdout, /deploy/);
  assert.match(result.stdout, /finalize/);
});
