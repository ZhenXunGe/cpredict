import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  padHex,
  stringToHex,
} from "viem";
import { REQUIRED_CANARY_STEPS, REQUIRED_DRILLS } from "./evidence-lib.mjs";
import { checkDeploymentLinks } from "./check-deployment-links.mjs";
import { validateCanaryEvidence } from "./validate-canary-evidence.mjs";
import { validateDeploymentAbis } from "./validate-deployment-abi.mjs";
import { validateFinalManifest } from "./validate-final-manifest.mjs";
import { validateMonitoringConfig } from "./validate-monitoring-config.mjs";
import { validateOpsEvidence } from "./validate-ops-evidence.mjs";
import {
  DEPLOYMENT_READ_ABIS,
  TIMELOCK_ROLE_IDS,
  verifyLiveRpc,
} from "./verify-live-rpc.mjs";

const h = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const a = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const sha = (n) => n.toString(16).padStart(64, "0");
const at = (seconds) =>
  `2026-08-08T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}Z`;

function receipt(n, timestamp = 2_000_000) {
  return {
    txHash: h(n),
    status: 1,
    blockNumber: 1000 + n,
    blockHash: h(1000 + n),
    timestamp,
  };
}

function constructorArg(name, type, value) {
  return { name, type, value };
}

function deploymentRecord(n, constructorArgs = []) {
  return {
    address: a(n),
    runtimeCodehash: h(10_000 + n),
    deploymentTx: h(20_000 + n),
    deploymentBlock: 500 + n,
    deploymentBlockHash: h(30_000 + n),
    constructorArgs,
    receiptStatus: 1,
  };
}

function externalRecord(n) {
  return {
    address: a(n),
    runtimeCodehash: h(10_000 + n),
    deploymentTx: h(20_000 + n),
    deploymentBlock: 100 + n,
    deploymentBlockHash: h(30_000 + n),
  };
}

function finalManifest() {
  const timelock = deploymentRecord(1);
  const usdc = {
    ...externalRecord(101),
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  };
  const permit2 = {
    ...externalRecord(102),
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  };
  const entryPoint = {
    ...externalRecord(103),
    address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  };
  const actors = {
    deployer: a(201),
    governanceSafe: {
      address: a(202),
      owners: [a(211), a(212), a(213), a(214), a(215), a(216)],
      threshold: 4,
      runtimeCodehash: h(40202),
      deploymentTx: h(50202),
      deploymentBlock: 402,
      deploymentBlockHash: h(60202),
    },
    emergencySafe: {
      address: a(203),
      owners: [a(221), a(222), a(223), a(224), a(225), a(226)],
      threshold: 2,
      runtimeCodehash: h(40203),
      deploymentTx: h(50203),
      deploymentBlock: 403,
      deploymentBlockHash: h(60203),
    },
    protocolTreasury: a(204),
    sponsorSigner: a(205),
  };
  timelock.constructorArgs = [
    constructorArg("minDelay", "uint256", "3600"),
    constructorArg("proposers", "address[]", [
      actors.governanceSafe.address,
      actors.deployer,
    ]),
    constructorArg("executors", "address[]", [a(0)]),
    constructorArg("admin", "address", actors.deployer),
  ];
  const configuration = {
    initialExposureCap: "50000000000",
    creationFee: "1000000",
    protocolShareBps: 1000,
    earlyBirdShareBps: 1000,
    platformC2CFeeBps: 100,
    maxCreatorRakeBps: 1000,
    maxCreatorC2CFeeBps: 200,
    maxFullMarketCap: "5000000000",
    maxCloneMarketCap: "500000000",
    maxPerUserPrimaryCap: "100000000",
    paymasterMaxCostPerOperation: "2000000000000000",
    paymasterMaxCostPerUserDay: "20000000000000000",
    paymasterMaxCostGlobalDay: "500000000000000000",
    paymasterPolicyVersion: 1,
  };
  const contracts = {
    timelock,
    config: deploymentRecord(2, [
      constructorArg("governance_", "address", timelock.address),
      constructorArg("paymentToken_", "address", usdc.address),
      constructorArg("treasury_", "address", actors.protocolTreasury),
    ]),
    emergencyController: deploymentRecord(3, [
      constructorArg("governance_", "address", timelock.address),
      constructorArg("emergencySafe_", "address", actors.emergencySafe.address),
    ]),
    exposureGuard: deploymentRecord(4, [
      constructorArg("governance_", "address", timelock.address),
      constructorArg("initialCap", "uint256", configuration.initialExposureCap),
    ]),
    feeVault: deploymentRecord(5, [
      constructorArg("governance_", "address", timelock.address),
      constructorArg("paymentToken_", "address", usdc.address),
    ]),
    bondEscrow: deploymentRecord(6, [
      constructorArg("governance_", "address", timelock.address),
      constructorArg("paymentToken_", "address", usdc.address),
    ]),
    cloneImplementation: deploymentRecord(7),
    fullMarketDeployer: deploymentRecord(8, [
      constructorArg("governance_", "address", timelock.address),
    ]),
    factory: deploymentRecord(9),
    marketplace: deploymentRecord(10),
    paymaster: deploymentRecord(11),
  };
  contracts.factory.constructorArgs = [
    constructorArg("governance_", "address", timelock.address),
    constructorArg("config_", "address", contracts.config.address),
    constructorArg(
      "emergencyController_",
      "address",
      contracts.emergencyController.address,
    ),
    constructorArg(
      "exposureGuard_",
      "address",
      contracts.exposureGuard.address,
    ),
    constructorArg("bondEscrow_", "address", contracts.bondEscrow.address),
    constructorArg("feeVault_", "address", contracts.feeVault.address),
    constructorArg(
      "fullMarketDeployer_",
      "address",
      contracts.fullMarketDeployer.address,
    ),
    constructorArg(
      "cloneImplementation_",
      "address",
      contracts.cloneImplementation.address,
    ),
    constructorArg("permit2_", "address", permit2.address),
  ];
  contracts.marketplace.constructorArgs = [
    constructorArg("factory_", "address", contracts.factory.address),
    constructorArg(
      "emergencyController_",
      "address",
      contracts.emergencyController.address,
    ),
    constructorArg("feeVault_", "address", contracts.feeVault.address),
    constructorArg("paymentToken_", "address", usdc.address),
    constructorArg("permit2_", "address", permit2.address),
  ];
  contracts.paymaster.constructorArgs = [
    constructorArg("governance_", "address", timelock.address),
    constructorArg(
      "emergencyController_",
      "address",
      contracts.emergencyController.address,
    ),
    constructorArg("entryPoint_", "address", entryPoint.address),
    constructorArg("sponsorSigner_", "address", actors.sponsorSigner),
    constructorArg(
      "maxCostPerOperation_",
      "uint256",
      configuration.paymasterMaxCostPerOperation,
    ),
    constructorArg(
      "maxCostPerUserPerDay_",
      "uint256",
      configuration.paymasterMaxCostPerUserDay,
    ),
    constructorArg(
      "maxCostGlobalPerDay_",
      "uint256",
      configuration.paymasterMaxCostGlobalDay,
    ),
  ];
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.deployment.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    status: "FINALIZED_VERIFIED",
    chainId: 421614,
    network: "arbitrum-sepolia",
    generatedAt: "2026-08-08T00:00:00Z",
    source: {
      commit: "1".repeat(40),
      tag: "audit-v1.0.0",
      sourceManifestSha256: sha(1),
      compiler: "0.8.36",
      foundry: "1.7.1",
      optimizer: true,
      optimizerRuns: 200,
      viaIR: true,
      evmVersion: "cancun",
    },
    referenceBlock: {
      number: 2000,
      hash: h(2000),
      timestamp: 2_000_000,
      parentChainId: 11_155_111,
      l1BlockNumber: 1_000_000,
      finality: "FINALIZED",
      confirmations: 20,
      rpcEvidenceSha256: sha(2),
    },
    actors,
    externalContracts: { usdc, permit2, entryPoint },
    contracts,
    transactions: {
      deployment: receipt(301, 1_990_000),
      bootstrapSchedule: receipt(302, 1_990_100),
      bootstrapFinalize: receipt(303, 1_993_700),
    },
    bootstrap: {
      minimumDelaySeconds: 3600,
      operationId: h(401),
      salt: h(402),
      factoryActivationFingerprint: h(403),
      scheduledAt: 1_990_100,
      executedAt: 1_993_700,
    },
    configuration,
    roles: {
      defaultAdmin: [timelock.address],
      proposer: [actors.governanceSafe.address],
      canceller: [actors.governanceSafe.address],
      executor: [a(0)],
      temporaryDeployerRolesCleared: true,
      roleEventsSha256: sha(3),
    },
    sourceVerification: Object.keys(contracts).map((contract) => ({
      contract,
      address: contracts[contract].address,
      status: "VERIFIED",
      explorerUrl: `https://sepolia.arbiscan.io/address/${contracts[contract].address}#code`,
      constructorArgsVerified: true,
      runtimeBytecodeVerified: true,
    })),
    canaryEvidence: { evidenceSha256: sha(4), status: "COMPLETE" },
  };
}

function canaryEvidence() {
  const deadline = 2_000_000;
  const full = a(501);
  const clone = a(502);
  const timeoutMarket = a(601);
  const steps = REQUIRED_CANARY_STEPS.map((id, i) => {
    const expected = new Set([
      "security.permit2ReplayRejected",
      "paymaster.budgetRejected",
      "timeout.deadlineCreatorVoidRejected",
    ]).has(id);
    let timestamp = deadline + 100 + i;
    if (id === "timeout.deadlineMinusOneCreatorVoid") timestamp = deadline - 1;
    if (id === "timeout.deadlineCreatorVoidRejected") timestamp = deadline;
    const fullSteps = new Set([
      "full.create",
      "primary.allowanceBuy",
      "aa.approvalAndListing",
      "c2c.partialFill",
      "resolve.winnerClaim",
      "resolve.earlyBirdClaim",
      "resolve.feeClaim",
      "resolve.bondClaim",
      "timeout.deadlineMinusOneCreatorVoid",
      "timeout.deadlineCreatorVoidRejected",
    ]);
    const cloneSteps = new Set([
      "clone.create",
      "primary.permit2Buy",
      "security.permit2ReplayRejected",
      "c2c.cancel",
      "c2c.terminalReturn",
      "creatorVoid.refund",
    ]);
    const mode = fullSteps.has(id)
      ? "FULL"
      : cloneSteps.has(id)
        ? "CLONE"
        : "PROTOCOL";
    const market =
      id === "timeout.deadlineMinusOneCreatorVoid"
        ? a(606)
        : id === "timeout.deadlineCreatorVoidRejected"
          ? timeoutMarket
          : mode === "FULL"
            ? full
            : mode === "CLONE"
              ? clone
              : a(0);
    const evidence = expected
      ? {
          blockNumber: 3000 + i,
          blockHash: h(3000 + i),
          timestamp,
          callDataSha256: sha(5000 + i),
          revertSelector: keccak256(
            stringToHex(
              id === "security.permit2ReplayRejected"
                ? "InvalidNonce()"
                : id === "paymaster.budgetRejected"
                  ? "SponsorshipBudgetExceeded()"
                  : "ResolutionWindowExpired()",
            ),
          ).slice(0, 10),
        }
      : receipt(6000 + i, timestamp);
    return {
      id,
      mode,
      market,
      outcome: expected ? "EXPECTED_REVERT" : "SUCCESS",
      evidence,
    };
  });
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.canary.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    status: "COMPLETE",
    chainId: 421614,
    generatedAt: "2026-08-08T00:00:00Z",
    deploymentIdentity: {
      factory: a(9),
      factoryActivationFingerprint: h(403),
      bootstrapFinalizeTx: h(303),
      sourceCommit: "1".repeat(40),
    },
    referenceBlock: { number: 4000, hash: h(4000) },
    steps,
    timeoutCanary: {
      market: timeoutMarket,
      mode: "FULL",
      closeAt: deadline - 86_400,
      outcomeDeadlineAt: deadline - 900,
      resolutionWindow: 900,
      deadline,
      voidReceipt: receipt(7001, deadline),
      slashedBond: "10000000",
      totalPrincipal: "3000000",
      principalRefunds: [
        {
          holder: a(602),
          burnedUnits: "1000000",
          payout: "1000000",
          receipt: receipt(7002, deadline + 1),
        },
        {
          holder: a(603),
          burnedUnits: "2000000",
          payout: "2000000",
          receipt: receipt(7003, deadline + 2),
        },
      ],
      bondSettlement: {
        fundedBonus: "10000000",
        receipt: receipt(7004, deadline + 3),
      },
      bonusClaims: [
        {
          holder: a(602),
          bonusUnits: "1000000",
          payout: "3333333",
          receipt: receipt(7005, deadline + 4),
        },
        {
          holder: a(603),
          bonusUnits: "2000000",
          payout: "6666667",
          receipt: receipt(7006, deadline + 5),
        },
      ],
    },
    zeroParticipantTimeoutCanary: {
      market: a(604),
      mode: "CLONE",
      closeAt: deadline - 86_300,
      outcomeDeadlineAt: deadline - 800,
      resolutionWindow: 900,
      deadline: deadline + 100,
      voidReceipt: receipt(7010, deadline + 100),
      slashedBond: "10000000",
      bondSettleReceipt: receipt(7011, deadline + 101),
      creator: a(605),
      creatorCreditIncrease: "10000000",
    },
  };
}

function opsEvidence() {
  const operators = [
    { address: a(801), role: "DEPLOYMENT_OPERATOR" },
    { address: a(802), role: "SECURITY_REVIEWER" },
    { address: a(803), role: "ONCALL_OPERATOR" },
  ];
  const artifactKinds = (id) => {
    if (
      [
        "roles.independentRpcSnapshot",
        "incident.rpcDivergence",
        "rpc.failover",
      ].includes(id)
    )
      return ["RPC_RESPONSE", "RPC_RESPONSE"];
    if (id === "monitoring.metricsScrape") return ["METRICS"];
    if (id === "monitoring.alertDelivery") return ["ALERT_RECEIPT"];
    if (
      [
        "emergency.pauseNewRisk",
        "emergency.exitStillAvailable",
        "emergency.autoExpiry",
      ].includes(id)
    )
      return ["TRANSACTION_RECEIPT"];
    if (["indexer.reorgRecovery", "indexer.backupRestore"].includes(id))
      return ["DATABASE_REPORT"];
    if (id === "paymaster.kmsRotation") return ["KMS_ATTESTATION"];
    return ["RUNBOOK_LOG"];
  };
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.ops-drill.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    status: "COMPLETE",
    chainId: 421614,
    generatedAt: "2026-08-08T00:00:00Z",
    deploymentManifestSha256: sha(20),
    referenceBlock: { number: 5000, hash: h(5000) },
    operators,
    drills: REQUIRED_DRILLS.map((id, i) => ({
      id,
      status: "PASS",
      startedAt: at(i * 2),
      completedAt: at(i * 2 + 1),
      artifacts: artifactKinds(id).map((kind, j) => ({
        kind,
        uri: `artifact:drill/${i}/${j}`,
        sha256: sha(9000 + i * 10 + j),
        capturedAt: at(i * 2 + 1),
      })),
      observedOutcome: `${id} passed against Arbitrum Sepolia runtime evidence`,
    })),
    signoff: {
      deploymentOperator: operators[0].address,
      securityReviewer: operators[1].address,
      oncallOperator: operators[2].address,
      signedAt: "2026-08-08T00:30:00Z",
      statementSha256: sha(21),
    },
  };
}

test("final deployment manifest accepts a complete cross-linked runtime record", () => {
  assert.equal(validateFinalManifest(finalManifest()).chainId, 421614);
});

test("source-verification planning accepts only explicit pending records", () => {
  const fixture = finalManifest();
  fixture.status = "BOOTSTRAP_FINALIZED_PENDING_CANARY";
  fixture.canaryEvidence = {
    evidenceSha256: "0".repeat(64),
    status: "PENDING",
  };
  fixture.sourceVerification = fixture.sourceVerification.map((item) => ({
    ...item,
    status: "PENDING",
    constructorArgsVerified: false,
    runtimeBytecodeVerified: false,
  }));
  assert.doesNotThrow(() =>
    validateFinalManifest(fixture, {
      allowPendingCanary: true,
      allowPendingSourceVerification: true,
    }),
  );
  assert.throws(
    () => validateFinalManifest(fixture, { allowPendingCanary: true }),
    /explicitly PENDING/,
  );
});

test("final manifest rejects missing fields", () => {
  const fixture = finalManifest();
  delete fixture.roles;
  assert.throws(() => validateFinalManifest(fixture), /keys must be exactly/);
});

test("final manifest rejects wrong chain", () => {
  const fixture = finalManifest();
  fixture.chainId = 1;
  assert.throws(() => validateFinalManifest(fixture), /chainId/);
});

test("final manifest requires Ethereum Sepolia parent binding and finalized status", () => {
  const wrongParent = finalManifest();
  wrongParent.referenceBlock.parentChainId = 1;
  assert.throws(() => validateFinalManifest(wrongParent), /parentChainId/);

  const softFinality = finalManifest();
  softFinality.referenceBlock.finality = "SAFE";
  assert.throws(() => validateFinalManifest(softFinality), /finality/);
});

test("final manifest rejects source-verification links outside Arbitrum Sepolia Arbiscan", () => {
  const fixture = finalManifest();
  fixture.sourceVerification[0].explorerUrl = `https://example.com/address/${fixture.sourceVerification[0].address}#code`;
  assert.throws(() => validateFinalManifest(fixture), /Arbiscan address URL/);
});

test("final manifest rejects constructor/address tampering", () => {
  const fixture = finalManifest();
  fixture.contracts.factory.constructorArgs[1].value = a(999);
  assert.throws(() => validateFinalManifest(fixture), /constructorArgs/);
});

test("final manifest rejects temporary deployer roles", () => {
  const fixture = finalManifest();
  fixture.roles.proposer = [
    fixture.actors.governanceSafe.address,
    fixture.actors.deployer,
  ];
  assert.throws(() => validateFinalManifest(fixture), /proposer/);
});

test("live verifier rejects a single RPC before network access", async () => {
  await assert.rejects(
    () => verifyLiveRpc(finalManifest(), ["https://rpc-a.invalid"]),
    /exactly two/,
  );
});

test("live verifier rejects same-origin RPC aliases before network access", async () => {
  await assert.rejects(
    () =>
      verifyLiveRpc(finalManifest(), [
        "https://rpc.invalid/a",
        "https://rpc.invalid/b",
      ]),
    /distinct URLs and origins/,
  );
});

test("live verifier reaches strict PASS only after two matching RPCs and evidence binding", async () => {
  const manifest = finalManifest();
  const runtime = "0x6000";
  const runtimeHash = keccak256(runtime);
  for (const record of [
    ...Object.values(manifest.contracts),
    ...Object.values(manifest.externalContracts),
  ])
    record.runtimeCodehash = runtimeHash;
  manifest.actors.governanceSafe.runtimeCodehash = runtimeHash;
  manifest.actors.emergencySafe.runtimeCodehash = runtimeHash;
  manifest.roles.roleEventsSha256 = "0".repeat(64);
  manifest.referenceBlock.rpcEvidenceSha256 = "0".repeat(64);

  const c = manifest.contracts;
  const e = manifest.externalContracts;
  const cfg = manifest.configuration;
  const roleSets = {
    defaultAdmin: [c.timelock.address.toLowerCase()],
    proposer: [manifest.actors.governanceSafe.address.toLowerCase()],
    canceller: [manifest.actors.governanceSafe.address.toLowerCase()],
    executor: [a(0)],
  };
  const addressAbi = new Map([
    [
      c.factory.address.toLowerCase(),
      ["factory", DEPLOYMENT_READ_ABIS.factory],
    ],
    [c.config.address.toLowerCase(), ["config", DEPLOYMENT_READ_ABIS.config]],
    [
      c.emergencyController.address.toLowerCase(),
      ["emergencyController", DEPLOYMENT_READ_ABIS.emergencyController],
    ],
    [
      c.exposureGuard.address.toLowerCase(),
      ["exposureGuard", DEPLOYMENT_READ_ABIS.exposureGuard],
    ],
    [
      c.feeVault.address.toLowerCase(),
      ["feeVault", DEPLOYMENT_READ_ABIS.feeVault],
    ],
    [
      c.bondEscrow.address.toLowerCase(),
      ["bondEscrow", DEPLOYMENT_READ_ABIS.bondEscrow],
    ],
    [
      c.fullMarketDeployer.address.toLowerCase(),
      ["fullMarketDeployer", DEPLOYMENT_READ_ABIS.fullMarketDeployer],
    ],
    [
      c.marketplace.address.toLowerCase(),
      ["marketplace", DEPLOYMENT_READ_ABIS.marketplace],
    ],
    [
      c.paymaster.address.toLowerCase(),
      ["paymaster", DEPLOYMENT_READ_ABIS.paymaster],
    ],
    [
      c.timelock.address.toLowerCase(),
      ["timelock", DEPLOYMENT_READ_ABIS.timelock],
    ],
    [
      manifest.actors.governanceSafe.address.toLowerCase(),
      ["governanceSafe", DEPLOYMENT_READ_ABIS.safe],
    ],
    [
      manifest.actors.emergencySafe.address.toLowerCase(),
      ["emergencySafe", DEPLOYMENT_READ_ABIS.safe],
    ],
  ]);
  const values = {
    factory: {
      governance: c.timelock.address,
      config: c.config.address,
      emergencyController: c.emergencyController.address,
      exposureGuard: c.exposureGuard.address,
      bondEscrow: c.bondEscrow.address,
      feeVault: c.feeVault.address,
      fullMarketDeployer: c.fullMarketDeployer.address,
      cloneImplementation: c.cloneImplementation.address,
      paymentToken: e.usdc.address,
      permit2: e.permit2.address,
      marketplace: c.marketplace.address,
      active: true,
      deprecated: false,
      activationFingerprint: manifest.bootstrap.factoryActivationFingerprint,
      dependencyFingerprint: manifest.bootstrap.factoryActivationFingerprint,
      dependencyFingerprintFor: manifest.bootstrap.factoryActivationFingerprint,
    },
    config: {
      governance: c.timelock.address,
      paymentToken: e.usdc.address,
      protocolTreasury: manifest.actors.protocolTreasury,
      creationFee: BigInt(cfg.creationFee),
      protocolShareBps: cfg.protocolShareBps,
      earlyBirdShareBps: cfg.earlyBirdShareBps,
      platformC2CFeeBps: cfg.platformC2CFeeBps,
      maxCreatorRakeBps: cfg.maxCreatorRakeBps,
      maxCreatorC2CFeeBps: cfg.maxCreatorC2CFeeBps,
      maxFullMarketCap: BigInt(cfg.maxFullMarketCap),
      maxCloneMarketCap: BigInt(cfg.maxCloneMarketCap),
      maxPerUserPrimaryCap: BigInt(cfg.maxPerUserPrimaryCap),
    },
    emergencyController: {
      governance: c.timelock.address,
      emergencySafe: manifest.actors.emergencySafe.address,
      pausedFlags: 0n,
      pauseExpiresAt: 0,
    },
    exposureGuard: {
      governance: c.timelock.address,
      factory: c.factory.address,
      exposureCap: BigInt(cfg.initialExposureCap),
      retired: false,
    },
    feeVault: {
      governance: c.timelock.address,
      paymentToken: e.usdc.address,
      factory: c.factory.address,
      authorizedAccruer: true,
    },
    bondEscrow: {
      governance: c.timelock.address,
      paymentToken: e.usdc.address,
      factory: c.factory.address,
    },
    fullMarketDeployer: {
      governance: c.timelock.address,
      factory: c.factory.address,
    },
    marketplace: {
      factory: c.factory.address,
      emergencyController: c.emergencyController.address,
      feeVault: c.feeVault.address,
      paymentToken: e.usdc.address,
      permit2: e.permit2.address,
    },
    paymaster: {
      governance: c.timelock.address,
      emergencyController: c.emergencyController.address,
      entryPoint: e.entryPoint.address,
      sponsorSigner: manifest.actors.sponsorSigner,
      maxCostPerOperation: BigInt(cfg.paymasterMaxCostPerOperation),
      maxCostPerUserPerDay: BigInt(cfg.paymasterMaxCostPerUserDay),
      maxCostGlobalPerDay: BigInt(cfg.paymasterMaxCostGlobalDay),
      policyVersion: cfg.paymasterPolicyVersion,
    },
    governanceSafe: {
      getThreshold: 4n,
      getOwners: manifest.actors.governanceSafe.owners,
    },
    emergencySafe: {
      getThreshold: 2n,
      getOwners: manifest.actors.emergencySafe.owners,
    },
  };
  const roleName = Object.fromEntries(
    Object.entries(TIMELOCK_ROLE_IDS).map(([name, id]) => [
      id.toLowerCase(),
      name,
    ]),
  );
  const grantTopic = keccak256(
    stringToHex("RoleGranted(bytes32,address,address)"),
  );
  const revokeTopic = keccak256(
    stringToHex("RoleRevoked(bytes32,address,address)"),
  );
  const topicAddress = (address) => padHex(address, { size: 32 });
  const logs = [];
  let logIndex = 0;
  const addRoleLog = (eventTopic, role, account, blockNumber) =>
    logs.push({
      blockNumber: `0x${blockNumber.toString(16)}`,
      transactionHash: h(80_000 + logIndex),
      logIndex: `0x${(logIndex++).toString(16)}`,
      topics: [
        eventTopic,
        TIMELOCK_ROLE_IDS[role],
        topicAddress(account),
        topicAddress(manifest.actors.deployer),
      ],
    });
  addRoleLog(
    grantTopic,
    "defaultAdmin",
    c.timelock.address,
    c.timelock.deploymentBlock,
  );
  addRoleLog(
    grantTopic,
    "defaultAdmin",
    manifest.actors.deployer,
    c.timelock.deploymentBlock,
  );
  addRoleLog(
    grantTopic,
    "proposer",
    manifest.actors.governanceSafe.address,
    c.timelock.deploymentBlock,
  );
  addRoleLog(
    grantTopic,
    "proposer",
    manifest.actors.deployer,
    c.timelock.deploymentBlock,
  );
  addRoleLog(
    grantTopic,
    "canceller",
    manifest.actors.governanceSafe.address,
    c.timelock.deploymentBlock,
  );
  addRoleLog(
    grantTopic,
    "canceller",
    manifest.actors.deployer,
    c.timelock.deploymentBlock,
  );
  addRoleLog(grantTopic, "executor", a(0), c.timelock.deploymentBlock);
  addRoleLog(
    revokeTopic,
    "proposer",
    manifest.actors.deployer,
    manifest.transactions.bootstrapFinalize.blockNumber,
  );
  addRoleLog(
    revokeTopic,
    "canceller",
    manifest.actors.deployer,
    manifest.transactions.bootstrapFinalize.blockNumber,
  );
  addRoleLog(
    revokeTopic,
    "defaultAdmin",
    manifest.actors.deployer,
    manifest.transactions.bootstrapFinalize.blockNumber,
  );

  const originalFetch = globalThis.fetch;
  let finalizedNumber = 2000;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    let result;
    if (request.method === "eth_chainId") result = "0x66eee";
    else if (request.method === "eth_blockNumber") result = "0x7e4";
    else if (request.method === "eth_getBlockByNumber") {
      if (request.params[0] === "finalized") {
        result = {
          number: `0x${finalizedNumber.toString(16)}`,
          hash: h(finalizedNumber),
          timestamp: `0x${manifest.referenceBlock.timestamp.toString(16)}`,
          l1BlockNumber: `0x${manifest.referenceBlock.l1BlockNumber.toString(16)}`,
        };
      } else {
        result = {
          number: `0x${manifest.referenceBlock.number.toString(16)}`,
          hash: manifest.referenceBlock.hash,
          timestamp: `0x${manifest.referenceBlock.timestamp.toString(16)}`,
          l1BlockNumber: `0x${manifest.referenceBlock.l1BlockNumber.toString(16)}`,
        };
      }
    } else if (request.method === "eth_getCode") result = runtime;
    else if (request.method === "eth_getStorageAt") result = h(1);
    else if (request.method === "eth_getLogs") result = logs;
    else if (request.method === "eth_call") {
      const target = request.params[0].to.toLowerCase();
      if (target === e.usdc.address.toLowerCase()) {
        result = encodeFunctionResult({
          abi: DEPLOYMENT_READ_ABIS.erc20Metadata,
          functionName: "decimals",
          result: 6,
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const [key, abi] = addressAbi.get(target);
      const decoded = decodeFunctionData({ abi, data: request.params[0].data });
      let value;
      if (key === "timelock") {
        if (decoded.functionName === "getMinDelay") value = 3600n;
        else {
          const [role, account] = decoded.args;
          value = roleSets[roleName[role.toLowerCase()]].includes(
            account.toLowerCase(),
          );
        }
      } else value = values[key][decoded.functionName];
      result = encodeFunctionResult({
        abi,
        functionName: decoded.functionName,
        result: value,
      });
    } else throw new Error(`unexpected RPC method ${request.method}`);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const urls = ["https://rpc-a.invalid", "https://rpc-b.invalid"];
    let bindingError;
    try {
      await verifyLiveRpc(manifest, urls);
    } catch (error) {
      bindingError = error;
    }
    assert.match(bindingError.message, /evidence bindings mismatch/);
    manifest.roles.roleEventsSha256 = bindingError.message.match(
      /roles\.roleEventsSha256=([0-9a-f]{64})/,
    )[1];
    manifest.referenceBlock.rpcEvidenceSha256 = bindingError.message.match(
      /referenceBlock\.rpcEvidenceSha256=([0-9a-f]{64})/,
    )[1];
    assert.equal(
      (await verifyLiveRpc(manifest, urls)).digest,
      manifest.referenceBlock.rpcEvidenceSha256,
    );
    finalizedNumber = manifest.referenceBlock.number - 1;
    await assert.rejects(
      verifyLiveRpc(manifest, urls),
      /reference block is not finalized/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canary evidence accepts complete Full, Clone and timeout flows", () => {
  assert.match(
    validateCanaryEvidence(canaryEvidence()).sha256,
    /^[0-9a-f]{64}$/,
  );
});

test("canary evidence rejects an early timeout void", () => {
  const fixture = canaryEvidence();
  fixture.timeoutCanary.voidReceipt.timestamp =
    fixture.timeoutCanary.deadline - 1;
  assert.throws(() => validateCanaryEvidence(fixture), /before deadline/);
});

test("canary evidence rejects a missing E2E step", () => {
  const fixture = canaryEvidence();
  fixture.steps.pop();
  assert.throws(() => validateCanaryEvidence(fixture), /exactly/);
});

test("operations evidence accepts every required drill and independent signoff", () => {
  assert.match(validateOpsEvidence(opsEvidence()).sha256, /^[0-9a-f]{64}$/);
});

test("operations evidence rejects a missing drill", () => {
  const fixture = opsEvidence();
  fixture.drills.pop();
  assert.throws(() => validateOpsEvidence(fixture), /exactly/);
});

test("checked-in monitoring rules contain every required severity", async () => {
  const source = await readFile(
    "monitoring/prometheus/cpredict-alerts.yml",
    "utf8",
  );
  assert.equal(validateMonitoringConfig(source).alerts.length, 10);
});

test("monitoring validator rejects severity weakening", async () => {
  const source = await readFile(
    "monitoring/prometheus/cpredict-alerts.yml",
    "utf8",
  );
  assert.throws(
    () =>
      validateMonitoringConfig(
        source.replace(
          "labels: { severity: critical }",
          "labels: { severity: warning }",
        ),
      ),
    /severity/,
  );
});

test("templates are explicitly rejected as runtime evidence", async () => {
  const template = JSON.parse(
    await readFile(
      "deployments/arbitrum-sepolia/templates/final-manifest.template.json",
      "utf8",
    ),
  );
  assert.throws(
    () => validateFinalManifest(template),
    /keys must be exactly|evidenceClass/,
  );
});

test("deployment verifier getter ABI stays compatible with generated artifacts", async () => {
  assert.equal((await validateDeploymentAbis()).contracts, 10);
});

test("deployment documentation references every required local artifact", async () => {
  const result = await checkDeploymentLinks();
  assert.equal(result.documents, 7);
  assert.equal(result.targets, 29);
});
