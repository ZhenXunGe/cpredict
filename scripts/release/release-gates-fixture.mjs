import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_GATE_POLICY } from "./release-gates-common.mjs";
import { evaluateCommercialEconomics } from "../economics/commercial-economics.mjs";
import { buildEventLatencySummary } from "../../load/distributed/event-latency-evidence.mjs";
import { buildTelemetrySummary } from "../../load/distributed/telemetry-evidence.mjs";

export function validReleaseGateFixture(sourceManifestBytes) {
  const sourceHash = hash(sourceManifestBytes);
  const files = new Map();
  const put = (path, value) => {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(
          typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
        );
    files.set(path, bytes);
    return { path, sha256: hash(bytes) };
  };
  const sourceInput = inventoryPut(
    files,
    "foundry.toml",
    "[profile.default]\n",
  );
  const gates = [];
  for (const policy of REQUIRED_GATE_POLICY) {
    let rawEvidence;
    if (policy.validator === "requirements") {
      rawEvidence = [
        {
          role: "traceability",
          ...put("manifests/requirements-traceability.json", {
            requirements: [{ id: "PF-1" }],
          }),
        },
      ];
    } else if (policy.validator === "sbom") {
      rawEvidence = [
        {
          role: "licenses",
          ...put("manifests/licenses.json", {
            legalConclusion: false,
            packages: [{ identity: "npm:x@1" }],
          }),
        },
        {
          role: "sbom",
          ...put("manifests/sbom.spdx.json", {
            spdxVersion: "SPDX-2.3",
            packages: [{ name: "root" }, { name: "x" }],
          }),
        },
      ];
    } else if (policy.validator === "generated") {
      rawEvidence = [
        {
          role: "bytecode",
          ...put("generated/registries/bytecode.json", [
            { runtimeBytecodeSha256: "1".repeat(64) },
          ]),
        },
      ];
    } else if (policy.validator === "command") {
      rawEvidence = [
        {
          role: "command-result",
          ...put(
            `reports/release/raw/${policy.id}.json`,
            commandEvidence(policy, sourceHash, "CPREDICT_COMMAND_RESULT"),
          ),
        },
      ];
    } else if (policy.validator === "security") {
      const artifact = inventoryPut(
        files,
        `reports/security/${policy.id}-validator.log`,
        "PASS\n",
      );
      const tool = securityTool(policy.evidenceGate);
      const securityPath =
        policy.evidenceGate === "solidity-smtchecker"
          ? "reports/security/smtchecker-evidence.json"
          : `reports/security/${policy.evidenceGate}-evidence.json`;
      rawEvidence = [
        {
          role: "security-evidence",
          ...put(securityPath, {
            schemaVersion: 1,
            gate: policy.evidenceGate,
            result: "PASS",
            validatorExitCode: 0,
            tool: { ...tool, rawExitCode: 0, acceptedExitCodes: [0] },
            platform: "darwin-arm64",
            sourceSnapshotSha256: hashInventory([sourceInput]),
            inputs: [{ ...sourceInput }],
            evidence: [{ ...artifact }],
          }),
        },
      ];
    } else if (policy.validator === "coverage") {
      const summary = [
        "production coverage gate: PASS (lines 100%, functions 100%, branches >=95%)",
        "production viaIR forced build: PASS",
        "production gas assertion context: PASS (10/10, 0 failed, 0 skipped)",
        "coverage-full exit code: 0",
        "",
      ].join("\n");
      put("reports/coverage/full.summary.txt", summary);
      put("reports/coverage/full.lcov", "TN:\nend_of_record\n");
      put("reports/coverage/production-viair-forced-build.log", "PASS\n");
      put("reports/coverage/production-gas-assertion-check.log", "PASS\n");
      const checksums = [
        "reports/coverage/full.lcov",
        "reports/coverage/full.summary.txt",
        "reports/coverage/production-gas-assertion-check.log",
        "reports/coverage/production-viair-forced-build.log",
      ]
        .map((path) => `${hash(files.get(path))}  ${path}\n`)
        .join("");
      rawEvidence = [
        {
          role: "checksums",
          ...put("reports/coverage/full.sha256", checksums),
        },
        {
          role: "summary",
          path: "reports/coverage/full.summary.txt",
          sha256: hash(files.get("reports/coverage/full.summary.txt")),
        },
      ];
    } else if (policy.validator === "gas") {
      rawEvidence = [
        {
          role: "gas-result",
          ...put("reports/release/raw/gas-size.json", {
            ...commandEvidence(policy, sourceHash, "CPREDICT_GAS_GATE"),
            tests: [
              "testGasGateAllowanceBuy",
              "testGasGateAllowanceFill",
              "testGasGateCloneDeploymentAndInitialization",
              "testGasGateFullCreate2Deployment",
              "testGasGateListingCreate",
              "testGasGateMarketplacePermit2FillUnder430k",
              "testGasGatePaymasterValidationAndPostOpUnder150k",
              "testGasGatePrimaryPermit2BuyUnder370k",
              "testGasGatePrincipalRefund",
              "testGasGateWinnerClaim",
            ].map((name, index) => ({ name, outerTestGas: 100_000 + index })),
            sizes: [
              ["CloneMarketVaultV1", 22_000, 23_000],
              ["FullMarketDeployerV1", 23_000, 24_000],
              ["FullMarketVaultV1", 22_000, 23_000],
              ["MarketFactoryV1", 15_000, 16_000],
              ["SponsorshipPaymasterV1", 7_000, 8_000],
            ].map(([contract, runtimeBytes, initcodeBytes]) => ({
              contract,
              runtimeBytes,
              initcodeBytes,
            })),
          }),
        },
      ];
    } else if (policy.validator === "postgresql") {
      rawEvidence = [
        {
          role: "postgresql-result",
          ...put("reports/release/raw/postgresql.json", {
            ...commandEvidence(policy, sourceHash, "CPREDICT_POSTGRESQL_GATE"),
            postgresVersion: "17.10",
            totals: { total: 9, passed: 9, failed: 0, skipped: 0, todo: 0 },
            cleanup: {
              pgCtlStatus: 3,
              pgIsReady: 2,
              dataDirectoryRemoved: true,
            },
          }),
        },
      ];
    } else if (policy.validator === "commercial-load") {
      rawEvidence = commercialLoadEvidence({
        files,
        put,
        sourceManifestBytes,
        sourceHash,
      });
    } else if (policy.validator === "economics") {
      const economics = commercialEconomicsEvidence(sourceHash);
      rawEvidence = [
        {
          role: "assessment",
          ...put(
            "reports/release/raw/commercial-economics-result.json",
            economics.assessment,
          ),
        },
        {
          role: "input",
          ...put(
            "reports/release/raw/commercial-economics-input.json",
            economics.input,
          ),
        },
        {
          role: "policy",
          ...put(
            "reports/release/raw/commercial-economics-policy.json",
            economics.policy,
          ),
        },
        {
          role: "report",
          ...put(
            "reports/release/raw/commercial-economics-report.md",
            "# Commercial economics\n\n**PASS**\n",
          ),
        },
      ];
    } else if (policy.validator === "deployment") {
      rawEvidence = [
        {
          role: "deployment-result",
          ...put("reports/release/raw/deployment-tooling.json", {
            ...commandEvidence(
              policy,
              sourceHash,
              "CPREDICT_DEPLOYMENT_TOOLING_GATE",
            ),
            totals: { total: 18, passed: 18, failed: 0, skipped: 0, todo: 0 },
          }),
        },
      ];
    } else if (policy.validator === "history") {
      rawEvidence = [
        {
          role: "scan-result",
          ...put("reports/release/raw/history-secret-scan.json", {
            schemaVersion: 1,
            scanner: "trufflehog",
            version: "3.96.0",
            actionCommit: "6f3c981e7b77f235fd2702dd74af25fc4b72bf11",
            executionProfile: "FULL_GIT_HISTORY",
            results: ["verified", "unknown"],
            updatePolicy: "disabled",
            result: "PASS",
            exitCode: 0,
            sourceManifestSha256: sourceHash,
          }),
        },
      ];
    } else {
      throw new Error(`fixture has no validator ${policy.validator}`);
    }
    rawEvidence.sort((a, b) => (a.role < b.role ? -1 : 1));
    const result = {
      schemaVersion: 1,
      gateId: policy.id,
      runnerId: policy.runnerId,
      command: policy.command,
      executionProfile: "FULL",
      result: "PASS",
      exitCode: 0,
      sourceManifestSha256: sourceHash,
      rawEvidence,
    };
    const resultFile = put(policy.resultPath, result);
    gates.push({
      id: policy.id,
      resultPath: policy.resultPath,
      sha256: resultFile.sha256,
    });
  }
  gates.sort((a, b) => (a.id < b.id ? -1 : 1));
  const config = {
    schemaVersion: 2,
    requiredGates: REQUIRED_GATE_POLICY.map((item) => ({ ...item })),
  };
  const document = {
    schemaVersion: 2,
    sourceManifestSha256: sourceHash,
    gates,
  };
  put("manifests/release-gates.config.json", config);
  put("manifests/release-gates.json", document);
  return { config, document, files, sourceHash };
}

function commercialEconomicsEvidence(sourceHash) {
  const input = JSON.parse(
    readFileSync(
      "scripts/economics/inputs/commercial-input.template.json",
      "utf8",
    ),
  );
  const approvedPolicy = JSON.parse(
    readFileSync(
      "scripts/economics/inputs/commercial-policy.template.json",
      "utf8",
    ),
  );
  const fixtureNow = Math.floor(Date.now() / 1_000) * 1_000;
  input.assessmentId = "TEST-ONLY-release-economics";
  input.assessmentTime = new Date(fixtureNow - 60_000).toISOString();
  input.validUntil = new Date(fixtureNow + 86_340_000).toISOString();
  const provenance = {
    datasetSha256: `sha256:${"a".repeat(64)}`,
    collectionStart: "2026-01-01T00:00:00Z",
    collectionEnd: input.assessmentTime,
    verifier: "TEST-ONLY release fixture verifier",
    verificationRef: "TEST-ONLY: no production claim",
  };
  for (const key of [
    "deploymentBinding",
    "configurationEvidence",
    "ethUsdEvidence",
    "baseReceipts",
    "gasPriceEvidence",
    "bondEvidence",
    "microPoolEvidence",
    "marketCapEvidence",
    "earlyBirdEvidence",
    "c2cEvidence",
    "launchGuardEvidence",
  ]) {
    input[key].evidenceStatus = "PROVIDED";
    input[key].provenance = { ...provenance };
  }
  input.deploymentBinding.sourceManifestSha256 = `sha256:${sourceHash}`;
  input.deploymentBinding.auditCommit = "c".repeat(40);
  input.deploymentBinding.deployments = [
    "ProtocolConfigV1",
    "MarketFactoryV1",
    "FullMarketVaultV1",
    "CloneMarketVaultV1",
    "MarketplaceV1",
    "BondEscrowV1",
    "SponsorshipPaymasterV1",
    "LaunchExposureGuardV1",
  ].map((component, index) => ({
    component,
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    runtimeCodeHash: `0x${(index + 11).toString(16).padStart(64, "0")}`,
  }));
  input.configurationEvidence.observedBlockNumber = "1000";
  input.configurationEvidence.rpcVerified = true;
  input.configurationEvidence.marketSnapshots = ["FULL", "CLONE"].map(
    (mode) => {
      const component = `${mode === "FULL" ? "Full" : "Clone"}MarketVaultV1`;
      const deployment = input.deploymentBinding.deployments.find(
        (item) => item.component === component,
      );
      return {
        mode,
        vaultAddress: deployment.address,
        runtimeCodeHash: deployment.runtimeCodeHash,
        marketPrimaryCapAtomic:
          mode === "FULL"
            ? input.subject.v1.fullMarketCapAtomic
            : input.subject.v1.cloneMarketCapAtomic,
        creatorRakeBps: input.subject.v1.creatorRakeBps,
        protocolShareBps: input.subject.v1.protocolShareBps,
        earlyBirdShareBps: input.subject.v1.earlyBirdShareBps,
        platformC2CFeeBps: input.subject.v1.platformC2CFeeBps,
        creatorC2CFeeBps: input.subject.v1.creatorC2CFeeBps,
      };
    },
  );
  Object.assign(input.ethUsdEvidence, {
    ethUsdE8: "300000000000",
    observedAt: new Date(fixtureNow - 3_600_000).toISOString(),
    validUntil: input.validUntil,
  });
  input.gasPriceEvidence.samplesWei = ["10000000"];
  const operationComponents = {
    PAYMASTER_OVERHEAD: "SponsorshipPaymasterV1",
    BOND_SETTLE: "BondEscrowV1",
    LISTING_CANCEL: "MarketplaceV1",
    TERMINAL_RETURN: "MarketplaceV1",
  };
  const operations = [
    "RESOLVE",
    "CREATOR_VOID",
    "TIMEOUT_VOID",
    "BOND_SETTLE",
    "WINNER_CLAIM",
    "PAYMASTER_OVERHEAD",
    "REFUND_CLAIM",
    "LISTING_CANCEL",
    "TERMINAL_RETURN",
    "TIMEOUT_BONUS_CLAIM",
  ];
  const receipts = operations.flatMap((operation) =>
    (operationComponents[operation] === undefined
      ? ["FULL", "CLONE"]
      : ["NA"]
    ).map((deploymentMode) => ({ operation, deploymentMode })),
  );
  input.baseReceipts.receipts = receipts.map(
    ({ operation, deploymentMode }, index) => {
      const component =
        operationComponents[operation] ??
        `${deploymentMode === "FULL" ? "Full" : "Clone"}MarketVaultV1`;
      const deployment = input.deploymentBinding.deployments.find(
        (item) => item.component === component,
      );
      return {
        transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        contractAddress: deployment.address,
        runtimeCodeHash: deployment.runtimeCodeHash,
        chainId: 421614,
        blockNumber: String(1_000 + index),
        operation,
        deploymentMode,
        gasUsed: operation === "PAYMASTER_OVERHEAD" ? "50000" : "100000",
        effectiveGasPriceWei: "10000000",
        l1FeeWei: "100000000000",
        externalChargeAtomic: "0",
        coveredClaims: "1",
        success: true,
        synthetic: false,
        rpcVerified: true,
      };
    },
  );
  input.bondEvidence.cohorts = [
    {
      mode: "FULL",
      sampleCount: "30",
      observedAttackProfitP95Atomic: "50000000",
      incidentResponseCostP95Atomic: "10000000",
    },
    {
      mode: "CLONE",
      sampleCount: "30",
      observedAttackProfitP95Atomic: "5000000",
      incidentResponseCostP95Atomic: "1000000",
    },
  ];
  Object.assign(input.microPoolEvidence, {
    mode: "CLONE",
    principalAtomic: "500000000",
    expectedClaimantCount: "10",
    paymasterSponsoredShareBps: "10000",
    earlyBirdEnabled: true,
  });
  input.marketCapEvidence.cohorts = [
    {
      mode: "FULL",
      sampleCount: "30",
      p95PeakPrincipalAtomic: "3000000000",
      capDeniedOrders: "0",
      eligibleOrders: "1000",
      unrecoveredLossAtomic: "0",
    },
    {
      mode: "CLONE",
      sampleCount: "30",
      p95PeakPrincipalAtomic: "300000000",
      capDeniedOrders: "0",
      eligibleOrders: "1000",
      unrecoveredLossAtomic: "0",
    },
  ];
  Object.assign(input.earlyBirdEvidence, {
    walletCount: "100",
    flaggedWalletCount: "5",
    totalEarlyPrincipalAtomic: "1000000000",
    flaggedEarlyPrincipalAtomic: "40000000",
    totalEarlyRewardAtomic: "100000000",
    flaggedEarlyRewardAtomic: "4000000",
  });
  input.c2cEvidence.matchedCohorts = true;
  input.c2cEvidence.baseline = {
    feeBps: "0",
    sampleCount: "100",
    quotedUnits: "1000000",
    filledUnits: "800000",
    medianTimeToFillSeconds: "100",
  };
  input.c2cEvidence.candidate = {
    feeBps: "200",
    sampleCount: "100",
    quotedUnits: "1000000",
    filledUnits: "760000",
    medianTimeToFillSeconds: "110",
  };
  Object.assign(input.launchGuardEvidence, {
    observationDays: "90",
    marketCount: "1000",
    accountingMismatchCount: "0",
    guardBypassIncidentCount: "0",
    unrecoveredIncidentCount: "0",
    capDeniedOrders: "5",
    eligibleOrders: "10000",
    p95ExposureUtilizationBps: "6000",
  });
  for (const [key, section] of Object.entries(approvedPolicy)) {
    if (
      [
        "$schema",
        "schemaVersion",
        "policyId",
        "maximumAssessmentValiditySeconds",
      ].includes(key)
    )
      continue;
    section.approved = true;
    section.approvalRef = "TEST-ONLY release policy fixture";
  }
  approvedPolicy.microPoolRake.minimumReceiptsPerOperation = "1";
  approvedPolicy.extremeGasExit.minimumGasPriceSamples = "1";
  approvedPolicy.extremeGasExit.minimumReceiptsPerOperation = "1";
  const assessment = evaluateCommercialEconomics(input, approvedPolicy);
  if (assessment.overallStatus !== "PASS")
    throw new Error(
      `TEST-ONLY commercial economics fixture did not PASS: ${JSON.stringify(assessment.gates)}`,
    );
  return { input, policy: approvedPolicy, assessment };
}

function commercialLoadEvidence({
  files,
  put,
  sourceManifestBytes,
  sourceHash,
}) {
  const migrationBodies = new Map([
    ["001_indexer.sql", Buffer.from("-- fixture migration 1\n")],
    ["002_settlement_evidence.sql", Buffer.from("-- fixture migration 2\n")],
    ["003_read_api_indexes.sql", Buffer.from("-- fixture migration 3\n")],
  ]);
  const migrationFiles = [];
  const migrationHash = createHash("sha256");
  for (const [name, body] of migrationBodies) {
    put(`offchain/indexer/migrations/${name}`, body);
    migrationHash.update(name);
    migrationHash.update("\0");
    migrationHash.update(body);
    migrationHash.update("\0");
    migrationFiles.push({ name, bytes: body.length, sha256: hash(body) });
  }
  const migrationsSha256 = migrationHash.digest("hex");
  const commit = "b".repeat(40);
  const imageDigests = {
    sut: `sha256:${"1".repeat(64)}`,
    load: `sha256:${"2".repeat(64)}`,
    chain: `sha256:${"3".repeat(64)}`,
  };
  const releaseConfig = {
    schemaVersion: 1,
    gitCommitSha: commit,
    sourceManifestSha256: sourceHash,
    migrationsSha256,
    runtimeImageDigests: imageDigests,
  };
  const rawEvidence = [];
  const roleReferences = {};
  const windows = {
    sut: ["2026-08-12T00:00:00.000Z", "2026-08-12T00:20:00.000Z"],
    load: ["2026-08-12T00:01:00.000Z", "2026-08-12T00:19:00.000Z"],
    chain: ["2026-08-12T00:02:00.000Z", "2026-08-12T00:18:00.000Z"],
  };
  for (const [index, role] of ["sut", "load", "chain"].entries()) {
    const artifacts = new Map([
      [
        "clock-evidence.json",
        {
          schemaVersion: 1,
          source: "chrony",
          maxOffsetMs: 25,
          observedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
      [
        "migrations-manifest.json",
        {
          schemaVersion: 1,
          treeSha256: migrationsSha256,
          files: migrationFiles,
        },
      ],
      ["release-config.json", releaseConfig],
      ["source-manifest.json", sourceManifestBytes],
      ["stage-exit-codes.json", { execute: 0 }],
    ]);
    if (role === "sut") {
      const telemetryRaw = commercialTelemetryRaw();
      const telemetryRawBytes = Buffer.from(
        `${JSON.stringify(telemetryRaw)}\n`,
      );
      artifacts.set("telemetry-raw.json", telemetryRawBytes);
      artifacts.set(
        "telemetry-summary.json",
        buildTelemetrySummary(telemetryRaw, hash(telemetryRawBytes)),
      );
    }
    if (role === "load") {
      artifacts.set("k6-api-summary.json", commercialApiReport());
      artifacts.set("k6-websocket-summary.json", commercialWebsocketReport());
      artifacts.set(
        "websocket-capacity-after.json",
        commercialWebsocketCapacity("after", 10_000, 0, 0, 10_000),
      );
      artifacts.set(
        "websocket-capacity-before.json",
        commercialWebsocketCapacity("before", 0, 0, 0, 0),
      );
    }
    if (role === "chain") {
      const chainEvidence = commercialChainEvidence();
      artifacts.set("chain.json", chainEvidence.chainBytes);
      artifacts.set(
        "event-latency-raw.json",
        chainEvidence.eventLatencyRawBytes,
      );
      artifacts.set("event-latency.json", chainEvidence.eventLatencySummary);
      artifacts.set("reorg-recovery.json", commercialReorg());
    }
    const inventory = [];
    for (const [name, value] of [...artifacts].sort(([left], [right]) =>
      left < right ? -1 : 1,
    )) {
      const path = `reports/release/raw/commercial-load/roles/${role}/${name}`;
      const stored = put(path, value);
      inventory.push({
        name,
        bytes: files.get(path).length,
        sha256: stored.sha256,
      });
      rawEvidence.push({ role: `${role}-${releaseSlug(name)}`, ...stored });
    }
    const host = {
      identitySha256: String(index + 1).repeat(64),
      identitySource: "fixture-host-registry",
      machineFingerprintSha256: String(index + 4).repeat(64),
      platform: "linux",
      arch: "x64",
    };
    const identityEvidence = Buffer.from(`TEST-ONLY host identity ${role}\n`);
    const identityStored = put(
      `reports/release/raw/commercial-load/roles/${role}/host-identity-evidence.bin`,
      identityEvidence,
    );
    inventory.push({
      name: "host-identity-evidence.bin",
      bytes: identityEvidence.length,
      sha256: identityStored.sha256,
    });
    inventory.sort((left, right) => (left.name < right.name ? -1 : 1));
    rawEvidence.push({
      role: `${role}-host-identity-evidence-bin`,
      ...identityStored,
    });
    host.identityEvidence = {
      path: "host-identity-evidence.bin",
      sha256: identityStored.sha256,
      bytes: identityEvidence.length,
      assurance:
        "opaque-external-host-identity-evidence-not-cryptographically-verified-by-cpredict",
    };
    const roleEvidence = {
      schemaVersion: 1,
      lane: "distributed-commercial-load-role",
      runId: "release-fixture",
      role,
      runStatus: "completed",
      observedAt: windows[role][1],
      window: {
        startedAt: windows[role][0],
        completedAt: windows[role][1],
        clockSource: "chrony",
        clockMaxOffsetMs: 25,
      },
      releaseBinding: {
        gitCommitSha: commit,
        sourceManifestSha256: sourceHash,
        releaseConfigSha256: hash(
          Buffer.from(`${JSON.stringify(releaseConfig)}\n`),
        ),
        migrationsSha256,
        runtimeImageDigest: imageDigests[role],
      },
      host,
      targets: {
        sutOrigin: "https://sut.example.invalid",
        websocketTarget: "wss://sut.example.invalid/v1/stream",
        chainRpcOrigin: "https://chain.example.invalid",
      },
      stages: { execute: 0 },
      artifacts: inventory,
    };
    const rolePath = `reports/release/raw/commercial-load/roles/${role}/role-evidence.json`;
    const roleStored = put(rolePath, roleEvidence);
    rawEvidence.push({ role: `${role}-role-evidence`, ...roleStored });
    roleReferences[role] = {
      host,
      evidencePath: `roles/${role}/role-evidence.json`,
      evidenceSha256: roleStored.sha256,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const normalizedPublicKey = String(
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const manifest = {
    schemaVersion: 4,
    lane: "distributed-commercial-production-equivalent",
    runId: "release-fixture",
    runStatus: "completed",
    generatedAt: "2026-08-12T00:20:01.000Z",
    signing: {
      algorithm: "Ed25519",
      keyId: "TEST-ONLY-release-fixture",
      publicKeySha256: hash(normalizedPublicKey),
    },
    roles: roleReferences,
    topology: {
      sutLoadSeparated: true,
      sutChainSeparated: true,
      loadChainSeparated: true,
    },
    thresholds: {
      apiSteadyRps: 500,
      apiSteadySeconds: 300,
      apiBurstRps: 2_000,
      apiBurstSeconds: 60,
      apiDroppedIterations: 0,
      apiP95MsExclusive: 300,
      apiP99MsExclusive: 750,
      websocketSimultaneousConnections: 10_000,
      websocketHoldSeconds: 60,
      chainTransactionsPerSecond: 50,
      chainDurationSeconds: 600,
      chainPlannedTransactions: 30_000,
      eventToClientP95MsExclusive: 2_000,
    },
    overall: 0,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  rawEvidence.push({
    role: "manifest",
    ...put(
      "reports/release/raw/commercial-load/commercial-evidence-v4.json",
      manifestBytes,
    ),
  });
  rawEvidence.push({
    role: "signature",
    ...put(
      "reports/release/raw/commercial-load/commercial-evidence-v4.sig",
      `${sign(null, manifestBytes, privateKey).toString("base64")}\n`,
    ),
  });
  rawEvidence.push({
    role: "trusted-public-key",
    ...put(
      "reports/release/raw/commercial-load/trusted-public-key.pem",
      normalizedPublicKey,
    ),
  });
  return rawEvidence;
}

let cachedCommercialChainEvidence;

function commercialChainEvidence() {
  if (cachedCommercialChainEvidence !== undefined)
    return cachedCommercialChainEvidence;
  const market = `0x${"1".repeat(40)}`;
  const chain = {
    profile: "full",
    market,
    targetTps: 50,
    durationSeconds: 600,
    classifications: {
      planned: 30_000,
      submitted: 30_000,
      included: 30_000,
      success: 24_000,
      expectedRevert: 6_000,
      rejectedSubmission: 0,
      unexpectedRevert: 0,
      unexpectedSuccess: 0,
      missingReceipt: 0,
    },
    thresholds: { fullClassification: true, targetRate: true },
  };
  const transactions = [];
  const deliveries = [];
  for (let index = 0; index < chain.classifications.included; index += 1) {
    const transactionHash = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const outcome =
      index < chain.classifications.success ? "success" : "expected-revert";
    transactions.push({
      transactionHash,
      expectedOutcome: outcome,
      receiptStatus: outcome,
      blockNumber: 1_000 + Math.floor(index / 50),
    });
    if (outcome === "success") {
      const receiptObserved =
        1_000_000_000_000n + BigInt(index) * 1_000_000_000n;
      deliveries.push({
        transactionHash,
        logIndex: 0,
        eventName: "PrimaryPurchased",
        receiptObservedMonotonicNs: receiptObserved.toString(),
        websocketReceivedMonotonicNs: (
          receiptObserved + 250_000_000n
        ).toString(),
      });
    }
  }
  const raw = {
    schemaVersion: 1,
    lane: "chain-receipt-to-websocket-client-raw",
    clockDomain: "single-process-monotonic-nanoseconds",
    market,
    transactions,
    deliveries,
  };
  const chainBytes = Buffer.from(`${JSON.stringify(chain)}\n`);
  const eventLatencyRawBytes = Buffer.from(`${JSON.stringify(raw)}\n`);
  cachedCommercialChainEvidence = {
    chainBytes,
    eventLatencyRawBytes,
    eventLatencySummary: buildEventLatencySummary(
      raw,
      chain,
      hash(chainBytes),
      hash(eventLatencyRawBytes),
    ),
  };
  return cachedCommercialChainEvidence;
}

function commercialApiReport() {
  const phaseCount = (count) => ({
    count,
    rate: 1,
    thresholds: { [`count>=${count}`]: false },
  });
  const duration = (p95, p99) => ({
    "p(95)": p95,
    "p(99)": p99,
    thresholds: { "p(95)<300": false, "p(99)<750": false },
  });
  const rate = (passes, fails) => ({
    passes,
    fails,
    value: passes / (passes + fails),
    thresholds: { "rate<0.005": passes / (passes + fails) >= 0.005 },
  });
  const steady = 150_000;
  const transition = 1_250;
  const burst = 120_000;
  const total = steady + transition + burst;
  return {
    metrics: {
      iterations: { count: total, rate: 750 },
      http_reqs: { count: total, rate: 750 },
      checks: { passes: total, fails: 0, value: 1 },
      cpredict_api_phase_iterations: {
        count: total,
        rate: 1,
        thresholds: { "count>=271250": false, "count<=275002": false },
      },
      http_req_duration: duration(10, 20),
      "cpredict_api_phase_iterations{phase:steady}": phaseCount(steady),
      "cpredict_api_phase_iterations{phase:transition}": phaseCount(transition),
      "cpredict_api_phase_iterations{phase:burst}": phaseCount(burst),
      "http_req_duration{phase:steady}": duration(10, 20),
      "http_req_duration{phase:transition}": duration(50, 100),
      "http_req_duration{phase:burst}": duration(100, 200),
      "cpredict_response_errors{phase:steady}": rate(0, steady),
      "cpredict_response_errors{phase:transition}": rate(0, transition),
      "cpredict_response_errors{phase:burst}": rate(0, burst),
      "cpredict_server_errors{phase:steady}": rate(0, steady),
      "cpredict_server_errors{phase:transition}": rate(0, transition),
      "cpredict_server_errors{phase:burst}": rate(0, burst),
      "cpredict_transport_errors{phase:steady}": rate(0, steady),
      "cpredict_transport_errors{phase:transition}": rate(0, transition),
      "cpredict_transport_errors{phase:burst}": rate(0, burst),
      dropped_iterations: {
        count: 0,
        rate: 0,
        thresholds: { "count==0": false },
      },
      cpredict_response_errors: rate(0, total),
      cpredict_server_errors: rate(0, total),
      cpredict_transport_errors: rate(0, total),
    },
  };
}

function commercialWebsocketReport() {
  const rate = (passes, fails) => ({
    passes,
    fails,
    value: passes / (passes + fails),
    thresholds: { "rate<0.005": passes / (passes + fails) >= 0.005 },
  });
  return {
    metrics: {
      iterations: { count: 10_000, rate: 100 },
      checks: { passes: 20_000, fails: 0, value: 1 },
      ws_sessions: { count: 10_000, rate: 100 },
      ws_connecting: { "p(95)": 20, "p(99)": 40 },
      cpredict_ws_upgrade_failures: rate(0, 10_000),
      cpredict_ws_hold_failures: rate(0, 10_000),
      cpredict_ws_protocol_ready_failures: rate(0, 10_000),
    },
  };
}

function commercialWebsocketCapacity(
  phase,
  acceptedTotal,
  rejectedTotal,
  currentConnections,
  peakConnections,
) {
  return {
    schemaVersion: 1,
    runId: "release-fixture",
    phase,
    observedAt:
      phase === "before"
        ? "2026-08-12T00:01:00.000Z"
        : "2026-08-12T00:19:00.000Z",
    target: "https://sut.example.invalid",
    processStartTimeSeconds: 1_765_000_000,
    acceptedTotal,
    rejectedTotal,
    currentConnections,
    peakConnections,
  };
}

function commercialTelemetryRaw() {
  const histogram = (name, count, scale = 1) => [
    { key: `${name}_bucket{le="0.01"}`, value: count },
    { key: `${name}_bucket{le="+Inf"}`, value: count },
    { key: `${name}_count`, value: count },
    { key: `${name}_sum`, value: count * 0.005 * scale },
  ];
  const metrics = (final) => [
    {
      key: "cpredict_indexer_process_cpu_seconds_total",
      value: final ? 10 : 0,
    },
    { key: "cpredict_indexer_process_resident_memory_bytes", value: 1_000 },
    { key: "cpredict_indexer_nodejs_eventloop_lag_seconds", value: 0.005 },
    { key: "cpredict_indexer_http_connections", value: final ? 10_000 : 0 },
    { key: "cpredict_indexer_http_requests_queued", value: 0 },
    {
      key: "cpredict_indexer_http_requests_in_flight",
      value: final ? 2_000 : 0,
    },
    { key: "cpredict_indexer_db_operations_queued", value: 0 },
    { key: "cpredict_indexer_db_operations_in_flight", value: final ? 20 : 0 },
    { key: "cpredict_indexer_db_configured_connections", value: 20 },
    { key: "cpredict_indexer_last_indexed_block", value: final ? 999 : 100 },
    { key: "cpredict_indexer_ws_accepted_total", value: final ? 10_000 : 0 },
    { key: "cpredict_indexer_ws_connections", value: final ? 10_000 : 0 },
    { key: "cpredict_indexer_ws_peak_connections", value: final ? 10_000 : 0 },
    {
      key:
        "cpredict_indexer_ws_rejected_total{reason=" +
        JSON.stringify("limit") +
        "}",
      value: 0,
    },
    {
      key:
        "cpredict_indexer_ws_outbound_total{kind=" +
        JSON.stringify("ready") +
        "}",
      value: final ? 10_000 : 0,
    },
    {
      key:
        "cpredict_indexer_ws_heartbeat_total{kind=" +
        JSON.stringify("sent") +
        "}",
      value: final ? 20_000 : 0,
    },
    ...histogram(
      "cpredict_indexer_http_request_duration_seconds",
      final ? 1_000 : 0,
    ),
    ...histogram(
      "cpredict_indexer_db_admission_wait_seconds",
      final ? 1_000 : 0,
    ),
    ...histogram(
      "cpredict_indexer_db_operation_duration_seconds",
      final ? 1_000 : 0,
    ),
    ...histogram("cpredict_indexer_tick_seconds", final ? 100 : 0),
  ];
  return {
    schemaVersion: 1,
    lane: "distributed-commercial-sut-telemetry-raw",
    runId: "release-fixture",
    startedAt: "2026-08-12T00:00:00.000Z",
    completedAt: "2026-08-12T00:20:00.000Z",
    sampleIntervalMs: 60_000,
    allowedBlockLag: 2,
    samples: [
      {
        observedAt: "2026-08-12T00:00:00.000Z",
        metrics: metrics(false),
        chainHead: 100,
        postgres: { activeConnections: 1, transactions: 0, checkpoints: 0 },
      },
      {
        observedAt: "2026-08-12T00:20:00.000Z",
        metrics: metrics(true),
        chainHead: 1_000,
        postgres: {
          activeConnections: 20,
          transactions: 600_000,
          checkpoints: 2,
        },
      },
    ],
  };
}

function commercialReorg() {
  const hash32 = (value) => `0x${value.repeat(64)}`;
  return {
    schemaVersion: 2,
    lane: "multi-block-common-ancestor-rollback-replay",
    injectedDepth: 3,
    commonAncestor: { blockNumber: 100, blockHash: hash32("a") },
    oldBranch: { tipBlockNumber: 103, tipHash: hash32("b"), blockCount: 3 },
    newBranch: { tipBlockNumber: 103, tipHash: hash32("c"), blockCount: 3 },
    rollback: {
      orphanedBlockRowsBefore: 3,
      orphanedEventRowsBefore: 3,
      orphanedBlockRowsAfter: 0,
      orphanedEventRowsAfter: 0,
      transactionAtomicityFailures: 0,
    },
    replay: {
      expectedBlocks: 3,
      replayedBlocks: 3,
      expectedEvents: 3,
      replayedEvents: 3,
      missingEvents: 0,
      duplicateEvents: 0,
    },
    finalCheckpoint: { blockNumber: 103, blockHash: hash32("c") },
    recoveryMs: 250,
  };
}

function releaseSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function commandEvidence(policy, sourceManifestSha256, evidenceType) {
  return {
    schemaVersion: 1,
    evidenceType,
    gateId: policy.id,
    runnerId: policy.runnerId,
    command: policy.command,
    executionProfile: "FULL",
    result: "PASS",
    exitCode: 0,
    sourceManifestSha256,
  };
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inventoryPut(files, path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  files.set(path, bytes);
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}

function hashInventory(entries) {
  return hash(
    Buffer.from(
      `${entries.map((entry) => `${entry.path}|${entry.bytes}|${entry.sha256}`).join("\n")}\n`,
    ),
  );
}

function securityTool(gate) {
  const identities = {
    slither: {
      name: "slither-analyzer",
      version: "0.11.6",
      artifactSha256:
        "1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec",
    },
    aderyn: {
      name: "aderyn",
      version: "0.6.8",
      artifactSha256:
        "624c6652bb9478b38ddc255c27819cd5c6cb0448f5deb72036cc9cf5a27d4aac",
    },
    echidna: {
      name: "echidna",
      version: "2.3.3",
      artifactSha256:
        "8e16a43d8c37b74365ef259ea986e074b8a717309f770c7ff3d1f9fb891a7902",
    },
    medusa: {
      name: "medusa",
      version: "1.5.1",
      artifactSha256:
        "a8b38bbd07a60f51e1b96304db58dba441b5053d7a61d1749458f3f7eaf5d3ce",
    },
    halmos: {
      name: "halmos",
      version: "0.3.3",
      artifactSha256:
        "3967291bdd4aaac96a4c42dd18bf25bd76215acad53697d98f02b986ac8d3f67",
    },
    "solidity-smtchecker": {
      name: "solc",
      version: "0.8.36+commit.8a079791",
      artifactSha256:
        "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d",
    },
    "mutation-full": {
      name: "slither-mutate",
      version: "0.11.6",
      artifactSha256:
        "1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec",
    },
  };
  return identities[gate];
}
