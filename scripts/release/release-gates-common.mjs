import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { evaluateCommercialEconomics } from "../economics/commercial-economics.mjs";
import {
  validateProductionK6Api,
  validateProductionK6Websocket,
} from "../load/validate-production-evidence.mjs";
import {
  validateChain,
  validateDistributedWebsocketCapacity,
  validateEventLatency,
  validateReorg,
  validateRoleTopology,
  validateTelemetry,
} from "../../load/distributed/commercial-evidence.mjs";
import { buildTelemetrySummary } from "../../load/distributed/telemetry-evidence.mjs";

export const RELEASE_GATES_PATH = "manifests/release-gates.json";
export const RELEASE_GATES_CONFIG_PATH = "manifests/release-gates.config.json";
export const RELEASE_GATE_RUNNER_ID = "cpredict-release-gate-runner-v1";

const SECURITY_TOOL_IDENTITIES = Object.freeze({
  slither: Object.freeze({
    name: "slither-analyzer",
    version: "0.11.6",
    artifactSha256:
      "1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec",
  }),
  aderyn: Object.freeze({
    name: "aderyn",
    version: "0.6.8",
    artifactSha256:
      "624c6652bb9478b38ddc255c27819cd5c6cb0448f5deb72036cc9cf5a27d4aac",
  }),
  echidna: Object.freeze({
    name: "echidna",
    version: "2.3.3",
    artifactSha256:
      "8e16a43d8c37b74365ef259ea986e074b8a717309f770c7ff3d1f9fb891a7902",
  }),
  medusa: Object.freeze({
    name: "medusa",
    version: "1.5.1",
    artifactSha256:
      "a8b38bbd07a60f51e1b96304db58dba441b5053d7a61d1749458f3f7eaf5d3ce",
  }),
  halmos: Object.freeze({
    name: "halmos",
    version: "0.3.3",
    artifactSha256:
      "3967291bdd4aaac96a4c42dd18bf25bd76215acad53697d98f02b986ac8d3f67",
  }),
  "solidity-smtchecker": Object.freeze({
    name: "solc",
    version: "0.8.36+commit.8a079791",
    artifactSha256:
      "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d",
  }),
  "mutation-full": Object.freeze({
    name: "slither-mutate",
    version: "0.11.6",
    artifactSha256:
      "1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec",
  }),
});

export const REQUIRED_GATE_POLICY = Object.freeze([
  policy(
    "requirements",
    "npm run check:requirements -- --source $CPREDICT_REQUIREMENTS_SOURCE",
    "requirements",
  ),
  policy("sbom", "npm run check:sbom", "sbom"),
  policy("generated-artifacts", "npm run check:artifacts", "generated"),
  policy("solidity-viair", "bash scripts/test-all.sh", "command"),
  policy("solidity-nonir", "bash scripts/test-non-ir.sh", "command"),
  policy("coverage", "bash scripts/coverage-full.sh", "coverage"),
  policy("gas-size", "bash scripts/gas-gates.sh", "gas"),
  policy(
    "offchain",
    "npm run check:offchain && npm run test:offchain -- --maxWorkers=1 && npm run build:offchain",
    "command",
  ),
  policy("postgresql", "bash scripts/postgres-integration.sh", "postgresql"),
  policy(
    "commercial-load",
    'node scripts/release/record-commercial-load.mjs --bundle "$CPREDICT_COMMERCIAL_LOAD_BUNDLE" --trusted-public-key "$CPREDICT_COMMERCIAL_LOAD_PUBLIC_KEY" --trusted-public-key-sha256 "$CPREDICT_COMMERCIAL_LOAD_PUBLIC_KEY_SHA256" --evidence-root "$CPREDICT_RELEASE_EVIDENCE_ROOT"',
    "commercial-load",
  ),
  policy(
    "commercial-economics",
    'node scripts/economics/run-commercial-economics-gate.mjs --input "$CPREDICT_ECONOMICS_INPUT" --policy "$CPREDICT_ECONOMICS_POLICY" --output-json "$CPREDICT_ECONOMICS_OUTPUT_JSON" --output-md "$CPREDICT_ECONOMICS_OUTPUT_MD"',
    "economics",
  ),
  policy("deployment-tooling", "npm run test:deployment-tools", "deployment"),
  policy("secret-scan", "npm run scan:secrets", "command"),
  policy(
    "history-secret-scan",
    "trufflesecurity/trufflehog@6f3c981e7b77f235fd2702dd74af25fc4b72bf11 version=3.96.0 full-history",
    "history",
  ),
  policy("slither", "bash scripts/security/run-slither.sh", "security"),
  policy("aderyn", "bash scripts/security/run-aderyn.sh", "security"),
  policy("echidna", "bash scripts/security/run-echidna.sh", "security"),
  policy("medusa", "bash scripts/security/run-medusa.sh", "security"),
  policy("halmos", "bash scripts/security/run-halmos.sh", "security"),
  policy(
    "smt",
    "bash scripts/security/run-smt.sh",
    "security",
    "solidity-smtchecker",
  ),
  policy(
    "mutation",
    "bash scripts/security/run-mutation-full.sh",
    "security",
    "mutation-full",
  ),
  policy("release-tools", "npm run test:release-tools", "command"),
]);

function policy(id, command, validator, evidenceGate = id) {
  return {
    id,
    resultPath: `reports/release/gates/${id}.json`,
    runnerId: RELEASE_GATE_RUNNER_ID,
    command,
    validator,
    evidenceGate,
  };
}

export async function checkReleaseGates(root, evidenceRoot = root) {
  const actualRoot = realpathSync(root);
  const actualEvidenceRoot = realpathSync(evidenceRoot);
  const readSource = secureCheckoutReader(actualRoot);
  const readExternal = secureCheckoutReader(actualEvidenceRoot);
  const readEvidence = (path) =>
    existsSync(join(actualEvidenceRoot, path))
      ? readExternal(path)
      : readSource(path);
  const config = parseJson(
    readSource(RELEASE_GATES_CONFIG_PATH),
    RELEASE_GATES_CONFIG_PATH,
  );
  const sourceBytes = readSource("manifests/source-manifest.json");
  let document;
  try {
    document = parseJson(readExternal(RELEASE_GATES_PATH), RELEASE_GATES_PATH);
  } catch (error) {
    throw new Error(
      `${RELEASE_GATES_PATH} is absent or invalid; release remains blocked: ${error.message}`,
    );
  }
  const expectedCommitSha = /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : undefined;
  validateReleaseGatesDocument(document, config, {
    sourceManifestSha256: sha256(sourceBytes),
    expectedCommitSha,
    readEvidence,
  });
  return document;
}

export function validateReleaseGatesDocument(document, config, context) {
  validateReleaseGatesConfig(config);
  exactObject(
    document,
    ["schemaVersion", "sourceManifestSha256", "gates"],
    "release gates document",
  );
  assert(document.schemaVersion === 2, "unsupported release gates schema");
  assertSha(
    document.sourceManifestSha256,
    "release gates sourceManifestSha256",
  );
  assert(
    document.sourceManifestSha256 === context.sourceManifestSha256,
    "release gates source manifest binding is stale",
  );
  assert(Array.isArray(document.gates), "release gates must be an array");
  assert(
    document.gates.length === REQUIRED_GATE_POLICY.length,
    "release gates inventory is incomplete or contains unknown gates",
  );
  const policyById = new Map(
    REQUIRED_GATE_POLICY.map((item) => [item.id, item]),
  );
  const seen = new Set();
  let previous = "";
  for (const gate of document.gates) {
    exactObject(
      gate,
      ["id", "resultPath", "sha256"],
      `release gate ${gate?.id ?? "<unknown>"}`,
    );
    assert(!seen.has(gate.id), `duplicate release gate ${gate.id}`);
    assert(
      previous === "" || compare(previous, gate.id) < 0,
      "release gates are not canonically sorted",
    );
    previous = gate.id;
    seen.add(gate.id);
    const expected = policyById.get(gate.id);
    assert(expected !== undefined, `unknown release gate ${gate.id}`);
    assert(
      gate.resultPath === expected.resultPath,
      `release gate ${gate.id} must reference exact result path ${expected.resultPath}`,
    );
    assertSha(gate.sha256, `release gate ${gate.id} result SHA-256`);
    const resultBytes = context.readEvidence(gate.resultPath);
    assert(
      sha256(resultBytes) === gate.sha256,
      `stale release gate result SHA-256 for ${gate.id}`,
    );
    const result = parseJson(resultBytes, gate.resultPath);
    validateGateResult(result, expected, context);
  }
  for (const expected of REQUIRED_GATE_POLICY)
    assert(
      seen.has(expected.id),
      `missing required release gate ${expected.id}`,
    );
}

export function validateReleaseGatesConfig(config) {
  exactObject(
    config,
    ["schemaVersion", "requiredGates"],
    "release gates config",
  );
  assert(config.schemaVersion === 2, "unsupported release gates config schema");
  assert(
    Array.isArray(config.requiredGates),
    "required release gates must be an array",
  );
  assert(
    JSON.stringify(config.requiredGates) ===
      JSON.stringify(REQUIRED_GATE_POLICY),
    "release gate policy differs from fixed code policy",
  );
}

export function validateGateResult(result, expected, context) {
  exactObject(
    result,
    [
      "schemaVersion",
      "gateId",
      "runnerId",
      "command",
      "executionProfile",
      "result",
      "exitCode",
      "sourceManifestSha256",
      "rawEvidence",
    ],
    `gate result ${expected.id}`,
  );
  assert(result.schemaVersion === 1, `gate result ${expected.id} schema drift`);
  assert(
    result.gateId === expected.id,
    `gate result gateId mismatch for ${expected.id}`,
  );
  assert(
    result.runnerId === expected.runnerId,
    `gate result runner identity mismatch for ${expected.id}`,
  );
  assert(
    result.command === expected.command,
    `gate result command mismatch for ${expected.id}`,
  );
  assert(
    result.executionProfile === "FULL",
    `gate result ${expected.id} is not a FULL execution`,
  );
  assert(
    result.result === "PASS",
    `gate result ${expected.id} is ${String(result.result)}; only PASS is releasable`,
  );
  assert(
    result.exitCode === 0,
    `gate result ${expected.id} exitCode must be zero`,
  );
  assert(
    result.sourceManifestSha256 === context.sourceManifestSha256,
    `gate result ${expected.id} source binding is stale`,
  );
  assert(
    Array.isArray(result.rawEvidence) && result.rawEvidence.length > 0,
    `gate result ${expected.id} has no raw evidence`,
  );
  const evidence = new Map();
  let previousRole = "";
  const paths = new Set();
  for (const item of result.rawEvidence) {
    exactObject(
      item,
      ["role", "path", "sha256"],
      `gate result ${expected.id} raw evidence`,
    );
    assert(
      /^[a-z][a-z0-9-]*$/.test(item.role),
      `invalid raw evidence role for ${expected.id}`,
    );
    assert(
      previousRole === "" || compare(previousRole, item.role) < 0,
      `raw evidence roles are not sorted for ${expected.id}`,
    );
    previousRole = item.role;
    validateReleaseEvidencePath(item.path);
    assert(
      !evidence.has(item.role),
      `duplicate raw evidence role ${item.role} for ${expected.id}`,
    );
    assert(
      !paths.has(item.path),
      `duplicate raw evidence path ${item.path} for ${expected.id}`,
    );
    paths.add(item.path);
    assertSha(
      item.sha256,
      `raw evidence SHA-256 for ${expected.id}/${item.role}`,
    );
    const bytes = context.readEvidence(item.path);
    assert(
      sha256(bytes) === item.sha256,
      `stale raw evidence for ${expected.id}/${item.role}`,
    );
    evidence.set(item.role, { ...item, bytes });
  }
  validateSemanticEvidence(expected, result, evidence, context);
}

function validateSemanticEvidence(policy, result, evidence, context) {
  if (policy.validator === "requirements") {
    exactRoles(evidence, ["traceability"]);
    exactPath(
      evidence,
      "traceability",
      "manifests/requirements-traceability.json",
    );
    const value = jsonEvidence(evidence, "traceability");
    assert(
      Array.isArray(value.requirements) && value.requirements.length > 0,
      "requirements traceability evidence is empty",
    );
    unique(
      value.requirements.map((item) => item.id),
      "requirements traceability IDs",
    );
    return;
  }
  if (policy.validator === "sbom") {
    exactRoles(evidence, ["licenses", "sbom"]);
    exactPath(evidence, "sbom", "manifests/sbom.spdx.json");
    exactPath(evidence, "licenses", "manifests/licenses.json");
    const sbom = jsonEvidence(evidence, "sbom");
    const licenses = jsonEvidence(evidence, "licenses");
    assert(
      sbom.spdxVersion === "SPDX-2.3" &&
        Array.isArray(sbom.packages) &&
        sbom.packages.length > 1,
      "SBOM semantic evidence invalid",
    );
    assert(
      licenses.legalConclusion === false &&
        Array.isArray(licenses.packages) &&
        licenses.packages.length > 0,
      "license semantic evidence invalid",
    );
    return;
  }
  if (policy.validator === "generated") {
    exactRoles(evidence, ["bytecode"]);
    exactPath(evidence, "bytecode", "generated/registries/bytecode.json");
    const bytecode = jsonEvidence(evidence, "bytecode");
    assert(
      Array.isArray(bytecode) &&
        bytecode.length > 0 &&
        bytecode.every((item) =>
          /^[0-9a-f]{64}$/.test(item.runtimeBytecodeSha256),
        ),
      "generated bytecode evidence invalid",
    );
    return;
  }
  if (policy.validator === "command") {
    exactRoles(evidence, ["command-result"]);
    exactPath(
      evidence,
      "command-result",
      `reports/release/raw/${policy.id}.json`,
    );
    validateCommandEvidence(
      jsonEvidence(evidence, "command-result"),
      policy,
      context,
    );
    return;
  }
  if (policy.validator === "security") {
    exactRoles(evidence, ["security-evidence"]);
    exactPath(
      evidence,
      "security-evidence",
      securityEvidencePath(policy.evidenceGate),
    );
    validateSecurityEvidence(
      jsonEvidence(evidence, "security-evidence"),
      policy,
      context,
    );
    return;
  }
  if (policy.validator === "coverage") {
    exactRoles(evidence, ["checksums", "summary"]);
    exactPath(evidence, "checksums", "reports/coverage/full.sha256");
    exactPath(evidence, "summary", "reports/coverage/full.summary.txt");
    const summary = evidence.get("summary").bytes.toString("utf8");
    for (const marker of [
      "production coverage gate: PASS (lines 100%, functions 100%, branches >=95%)",
      "production viaIR forced build: PASS",
      "production gas assertion context: PASS (10/10, 0 failed, 0 skipped)",
      "coverage-full exit code: 0",
    ])
      assert(summary.includes(marker), `coverage summary missing ${marker}`);
    validateChecksumList(
      evidence.get("checksums").bytes.toString("utf8"),
      context,
    );
    return;
  }
  if (policy.validator === "gas") {
    exactRoles(evidence, ["gas-result"]);
    exactPath(evidence, "gas-result", "reports/release/raw/gas-size.json");
    const value = jsonEvidence(evidence, "gas-result");
    exactObject(
      value,
      [
        "schemaVersion",
        "evidenceType",
        "gateId",
        "runnerId",
        "command",
        "executionProfile",
        "result",
        "exitCode",
        "sourceManifestSha256",
        "tests",
        "sizes",
      ],
      "gas evidence",
    );
    validateCommandCore(value, policy, context, "CPREDICT_GAS_GATE");
    const expectedTests = [
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
    ];
    assert(
      Array.isArray(value.tests) &&
        JSON.stringify(value.tests.map((item) => item.name)) ===
          JSON.stringify(expectedTests),
      "gas PASS test inventory incomplete or unsorted",
    );
    for (const item of value.tests) {
      exactObject(
        item,
        ["name", "outerTestGas"],
        `gas test ${item?.name ?? "<unknown>"}`,
      );
      assert(
        Number.isSafeInteger(item.outerTestGas) && item.outerTestGas > 0,
        `gas test ${item.name} has invalid execution gas evidence`,
      );
    }
    const sizeLimits = new Map([
      ["CloneMarketVaultV1", 23_000],
      ["FullMarketVaultV1", 23_000],
      ["FullMarketDeployerV1", 24_576],
      ["MarketFactoryV1", 24_576],
      ["SponsorshipPaymasterV1", 24_576],
    ]);
    assert(
      Array.isArray(value.sizes) && value.sizes.length === sizeLimits.size,
      "production runtime size inventory incomplete",
    );
    unique(
      value.sizes.map((item) => item.contract),
      "runtime size contract names",
    );
    for (const item of value.sizes) {
      exactObject(
        item,
        ["contract", "runtimeBytes", "initcodeBytes"],
        `runtime size ${item?.contract ?? "<unknown>"}`,
      );
      const maximum = sizeLimits.get(item.contract);
      assert(
        maximum !== undefined &&
          Number.isSafeInteger(item.runtimeBytes) &&
          item.runtimeBytes > 0 &&
          item.runtimeBytes < maximum,
        `runtime size gate failed: ${item.contract}`,
      );
      assert(
        Number.isSafeInteger(item.initcodeBytes) &&
          item.initcodeBytes > 0 &&
          item.initcodeBytes < 49_152,
        `initcode size gate failed: ${item.contract}`,
      );
    }
    return;
  }
  if (policy.validator === "postgresql") {
    exactRoles(evidence, ["postgresql-result"]);
    exactPath(
      evidence,
      "postgresql-result",
      "reports/release/raw/postgresql.json",
    );
    const value = jsonEvidence(evidence, "postgresql-result");
    exactObject(
      value,
      [
        "schemaVersion",
        "evidenceType",
        "gateId",
        "runnerId",
        "command",
        "executionProfile",
        "result",
        "exitCode",
        "sourceManifestSha256",
        "postgresVersion",
        "totals",
        "cleanup",
      ],
      "PostgreSQL evidence",
    );
    validateCommandCore(value, policy, context, "CPREDICT_POSTGRESQL_GATE");
    assert(
      value.postgresVersion === "17.10",
      "PostgreSQL evidence version drift",
    );
    assert(
      JSON.stringify(value.totals) ===
        JSON.stringify({ total: 9, passed: 9, failed: 0, skipped: 0, todo: 0 }),
      "PostgreSQL zero-skip totals invalid",
    );
    assert(
      JSON.stringify(value.cleanup) ===
        JSON.stringify({
          pgCtlStatus: 3,
          pgIsReady: 2,
          dataDirectoryRemoved: true,
        }),
      "PostgreSQL cleanup evidence invalid",
    );
    return;
  }
  if (policy.validator === "commercial-load") {
    validateCommercialLoadEvidence(evidence, context);
    return;
  }
  if (policy.validator === "economics") {
    exactRoles(evidence, ["assessment", "input", "policy", "report"]);
    exactPath(
      evidence,
      "assessment",
      "reports/release/raw/commercial-economics-result.json",
    );
    exactPath(
      evidence,
      "input",
      "reports/release/raw/commercial-economics-input.json",
    );
    exactPath(
      evidence,
      "policy",
      "reports/release/raw/commercial-economics-policy.json",
    );
    exactPath(
      evidence,
      "report",
      "reports/release/raw/commercial-economics-report.md",
    );
    const input = jsonEvidence(evidence, "input");
    const approvedPolicy = jsonEvidence(evidence, "policy");
    const assessment = jsonEvidence(evidence, "assessment");
    const recomputed = evaluateCommercialEconomics(input, approvedPolicy);
    assert(
      JSON.stringify(assessment) === JSON.stringify(recomputed),
      "commercial economics result is not reproducible from its evidence and policy",
    );
    assert(
      assessment.overallStatus === "PASS",
      `commercial economics is ${String(assessment.overallStatus)}; only PASS is releasable`,
    );
    assert(
      Array.isArray(assessment.gates) &&
        assessment.gates.length === 7 &&
        assessment.gates.every((gate) => gate.status === "PASS"),
      "commercial economics seven-gate inventory is incomplete or non-PASS",
    );
    const auditTime = context.auditTimeMs ?? Date.now();
    assert(
      Number.isFinite(auditTime),
      "commercial economics audit time is invalid",
    );
    assert(
      Date.parse(assessment.assessmentTime) <= auditTime,
      "commercial economics assessment is future-dated",
    );
    assert(
      auditTime <= Date.parse(assessment.validUntil),
      "commercial economics assessment has expired",
    );
    assert(
      input.deploymentBinding?.sourceManifestSha256 ===
        `sha256:${context.sourceManifestSha256}`,
      "commercial economics source manifest binding is stale",
    );
    if (context.expectedCommitSha !== undefined) {
      assert(
        input.deploymentBinding?.auditCommit === context.expectedCommitSha,
        "commercial economics audit commit binding is stale",
      );
    }
    assert(
      evidence.get("report").bytes.toString("utf8").includes("**PASS**"),
      "commercial economics report does not state PASS",
    );
    return;
  }
  if (policy.validator === "deployment") {
    exactRoles(evidence, ["deployment-result"]);
    exactPath(
      evidence,
      "deployment-result",
      "reports/release/raw/deployment-tooling.json",
    );
    const value = jsonEvidence(evidence, "deployment-result");
    exactObject(
      value,
      [
        "schemaVersion",
        "evidenceType",
        "gateId",
        "runnerId",
        "command",
        "executionProfile",
        "result",
        "exitCode",
        "sourceManifestSha256",
        "totals",
      ],
      "deployment tooling evidence",
    );
    validateCommandCore(
      value,
      policy,
      context,
      "CPREDICT_DEPLOYMENT_TOOLING_GATE",
    );
    assert(
      JSON.stringify(value.totals) ===
        JSON.stringify({
          total: 18,
          passed: 18,
          failed: 0,
          skipped: 0,
          todo: 0,
        }),
      "deployment tooling zero-skip totals invalid",
    );
    return;
  }
  if (policy.validator === "history") {
    exactRoles(evidence, ["scan-result"]);
    exactPath(
      evidence,
      "scan-result",
      "reports/release/raw/history-secret-scan.json",
    );
    const value = jsonEvidence(evidence, "scan-result");
    exactObject(
      value,
      [
        "schemaVersion",
        "scanner",
        "version",
        "actionCommit",
        "executionProfile",
        "results",
        "updatePolicy",
        "result",
        "exitCode",
        "sourceManifestSha256",
      ],
      "history secret scan result",
    );
    assert(
      value.schemaVersion === 1,
      "history secret scan result schema drift",
    );
    assert(
      value.scanner === "trufflehog" && value.version === "3.96.0",
      "history secret scanner identity drift",
    );
    assert(
      value.actionCommit === "6f3c981e7b77f235fd2702dd74af25fc4b72bf11",
      "history secret scan action commit drift",
    );
    assert(
      value.executionProfile === "FULL_GIT_HISTORY",
      "history secret scan must cover full Git history",
    );
    assert(
      JSON.stringify(value.results) === JSON.stringify(["verified", "unknown"]),
      "history secret scan result policy drift",
    );
    assert(
      value.updatePolicy === "disabled",
      "history secret scanner updates must be disabled",
    );
    assert(
      value.result === "PASS" && value.exitCode === 0,
      "history secret scan did not PASS",
    );
    assert(
      value.sourceManifestSha256 === context.sourceManifestSha256,
      "history secret scan source binding is stale",
    );
    return;
  }
  throw new Error(`unknown semantic validator ${policy.validator}`);
}

function validateCommercialLoadEvidence(evidence, context) {
  const rawRoot = "reports/release/raw/commercial-load";
  for (const [role, path] of [
    ["manifest", `${rawRoot}/commercial-evidence-v4.json`],
    ["signature", `${rawRoot}/commercial-evidence-v4.sig`],
    ["trusted-public-key", `${rawRoot}/trusted-public-key.pem`],
  ])
    exactPath(evidence, role, path);

  const manifest = jsonEvidence(evidence, "manifest");
  exactObject(
    manifest,
    [
      "schemaVersion",
      "lane",
      "runId",
      "runStatus",
      "generatedAt",
      "signing",
      "roles",
      "topology",
      "thresholds",
      "overall",
    ],
    "commercial-load manifest",
  );
  assert(
    manifest.schemaVersion === 4 &&
      manifest.lane === "distributed-commercial-production-equivalent",
    "commercial-load manifest schema/lane drift",
  );
  assert(
    manifest.runStatus === "completed" && manifest.overall === 0,
    "commercial-load bundle is incomplete or non-PASS",
  );
  assert(
    typeof manifest.runId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.runId),
    "commercial-load runId is invalid",
  );
  assert(
    !Number.isNaN(Date.parse(manifest.generatedAt)),
    "commercial-load generatedAt is invalid",
  );
  exactObject(
    manifest.signing,
    ["algorithm", "keyId", "publicKeySha256"],
    "commercial-load signing metadata",
  );
  assert(
    manifest.signing.algorithm === "Ed25519" &&
      typeof manifest.signing.keyId === "string" &&
      manifest.signing.keyId.length > 0,
    "commercial-load signing identity is invalid",
  );
  assert(
    JSON.stringify(manifest.thresholds) ===
      JSON.stringify({
        apiSteadyRps: 500,
        apiSteadySeconds: 300,
        apiBurstRps: 2000,
        apiBurstSeconds: 60,
        apiDroppedIterations: 0,
        apiP95MsExclusive: 300,
        apiP99MsExclusive: 750,
        websocketSimultaneousConnections: 10000,
        websocketHoldSeconds: 60,
        chainTransactionsPerSecond: 50,
        chainDurationSeconds: 600,
        chainPlannedTransactions: 30000,
        eventToClientP95MsExclusive: 2000,
      }),
    "commercial-load threshold policy drift",
  );
  assert(
    JSON.stringify(manifest.topology) ===
      JSON.stringify({
        sutLoadSeparated: true,
        sutChainSeparated: true,
        loadChainSeparated: true,
      }),
    "commercial-load topology separation failed",
  );

  const publicKeyBody = evidence
    .get("trusted-public-key")
    .bytes.toString("utf8");
  const normalizedPublicKey = String(
    createPublicKey(publicKeyBody).export({ type: "spki", format: "pem" }),
  );
  assert(
    sha256(normalizedPublicKey) === manifest.signing.publicKeySha256,
    "commercial-load trusted public key hash mismatch",
  );
  const signatureText = evidence.get("signature").bytes.toString("utf8");
  assert(
    /^[A-Za-z0-9+/]+={0,2}\n?$/.test(signatureText),
    "commercial-load signature encoding is invalid",
  );
  assert(
    verify(
      null,
      evidence.get("manifest").bytes,
      publicKeyBody,
      Buffer.from(signatureText.trim(), "base64"),
    ),
    "commercial-load signature is invalid",
  );

  exactObject(
    manifest.roles,
    ["sut", "load", "chain"],
    "commercial-load role references",
  );
  const expectedRoles = new Set([
    "manifest",
    "signature",
    "trusted-public-key",
  ]);
  const roles = {};
  const artifactByRole = {};
  for (const role of ["sut", "load", "chain"]) {
    const reference = manifest.roles[role];
    exactObject(
      reference,
      ["host", "evidencePath", "evidenceSha256"],
      `${role} commercial-load reference`,
    );
    const roleName = `${role}-role-evidence`;
    const rolePath = `${rawRoot}/roles/${role}/role-evidence.json`;
    expectedRoles.add(roleName);
    exactPath(evidence, roleName, rolePath);
    assert(
      reference.evidencePath === `roles/${role}/role-evidence.json`,
      `${role} commercial-load evidence path drift`,
    );
    assert(
      reference.evidenceSha256 === evidence.get(roleName).sha256,
      `${role} commercial-load role digest mismatch`,
    );
    const value = jsonEvidence(evidence, roleName);
    exactObject(
      value,
      [
        "schemaVersion",
        "lane",
        "runId",
        "role",
        "runStatus",
        "observedAt",
        "window",
        "releaseBinding",
        "host",
        "targets",
        "stages",
        "artifacts",
      ],
      `${role} commercial-load evidence`,
    );
    assert(
      value.schemaVersion === 1 &&
        value.lane === "distributed-commercial-load-role",
      `${role} commercial-load role schema/lane drift`,
    );
    assert(
      value.role === role &&
        value.runId === manifest.runId &&
        value.runStatus === "completed",
      `${role} commercial-load role identity/status mismatch`,
    );
    assert(
      !Number.isNaN(Date.parse(value.observedAt)),
      `${role} commercial-load observedAt is invalid`,
    );
    assert(
      JSON.stringify(value.host) === JSON.stringify(reference.host),
      `${role} commercial-load host reference mismatch`,
    );
    assert(
      value.stages !== null &&
        typeof value.stages === "object" &&
        Object.keys(value.stages).length > 0 &&
        Object.values(value.stages).every((exit) => exit === 0),
      `${role} commercial-load stages contain a failure or unrun step`,
    );
    assert(
      Array.isArray(value.artifacts) && value.artifacts.length > 0,
      `${role} commercial-load artifact inventory is empty`,
    );
    const names = value.artifacts.map((item) => item.name);
    assert(
      new Set(names).size === names.length &&
        JSON.stringify(names) === JSON.stringify([...names].sort(compare)),
      `${role} commercial-load artifact inventory is duplicate or unsorted`,
    );
    const files = new Map();
    for (const item of value.artifacts) {
      exactObject(
        item,
        ["name", "bytes", "sha256"],
        `${role} commercial-load artifact`,
      );
      assert(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name),
        `${role} commercial-load artifact name is unsafe`,
      );
      assert(
        Number.isSafeInteger(item.bytes) && item.bytes >= 0,
        `${role} commercial-load artifact byte size is invalid`,
      );
      assertSha(item.sha256, `${role} commercial-load artifact hash`);
      const artifactRole = `${role}-${slug(item.name)}`;
      assert(
        !expectedRoles.has(artifactRole),
        `${role} commercial-load artifact roles collide after normalization`,
      );
      const artifactPath = `${rawRoot}/roles/${role}/${item.name}`;
      expectedRoles.add(artifactRole);
      exactPath(evidence, artifactRole, artifactPath);
      const raw = evidence.get(artifactRole);
      assert(
        raw.bytes.length === item.bytes && raw.sha256 === item.sha256,
        `${role} commercial-load artifact inventory is stale: ${item.name}`,
      );
      files.set(item.name, raw.bytes);
    }
    validateCommercialRoleBinding(value, files, role, context);
    if (context.expectedCommitSha !== undefined) {
      assert(
        value.releaseBinding.gitCommitSha === context.expectedCommitSha,
        `${role} commercial-load audit commit binding is stale`,
      );
    }
    roles[role] = value;
    artifactByRole[role] = files;
  }
  exactRoles(evidence, [...expectedRoles]);
  validateRoleTopology(roles);
  validateProductionK6Api(
    parseArtifact(
      artifactByRole.load,
      "k6-api-summary.json",
      "commercial-load API summary",
    ),
  );
  validateProductionK6Websocket(
    parseArtifact(
      artifactByRole.load,
      "k6-websocket-summary.json",
      "commercial-load WebSocket summary",
    ),
  );
  validateDistributedWebsocketCapacity(
    parseArtifact(
      artifactByRole.load,
      "websocket-capacity-before.json",
      "commercial-load WebSocket baseline",
    ),
    parseArtifact(
      artifactByRole.load,
      "websocket-capacity-after.json",
      "commercial-load WebSocket final",
    ),
  );
  const chainBytes = requiredArtifact(
    artifactByRole.chain,
    "chain.json",
    "commercial-load chain report",
  );
  const chain = parseJson(chainBytes, "commercial-load chain report");
  validateChain(chain);
  const eventLatencyRawBytes = requiredArtifact(
    artifactByRole.chain,
    "event-latency-raw.json",
    "commercial-load raw event latency",
  );
  validateEventLatency(
    parseArtifact(
      artifactByRole.chain,
      "event-latency.json",
      "commercial-load event latency",
    ),
    parseJson(eventLatencyRawBytes, "commercial-load raw event latency"),
    chain,
    sha256(chainBytes),
    sha256(eventLatencyRawBytes),
  );
  validateReorg(
    parseArtifact(
      artifactByRole.chain,
      "reorg-recovery.json",
      "commercial-load reorg report",
    ),
  );
  const telemetryRawBytes = requiredArtifact(
    artifactByRole.sut,
    "telemetry-raw.json",
    "commercial-load raw telemetry",
  );
  validateTelemetry(
    parseArtifact(
      artifactByRole.sut,
      "telemetry-summary.json",
      "commercial-load telemetry summary",
    ),
    parseJson(telemetryRawBytes, "commercial-load raw telemetry"),
    sha256(telemetryRawBytes),
  );
}

function validateCommercialRoleBinding(roleEvidence, files, role, context) {
  const sourceManifest = requiredArtifact(files, "source-manifest.json", role);
  const releaseConfigBody = requiredArtifact(
    files,
    "release-config.json",
    role,
  );
  const releaseConfig = parseJson(
    releaseConfigBody,
    `${role} commercial-load release config`,
  );
  const migrations = parseJson(
    requiredArtifact(files, "migrations-manifest.json", role),
    `${role} commercial-load migrations manifest`,
  );
  const clock = parseJson(
    requiredArtifact(files, "clock-evidence.json", role),
    `${role} commercial-load clock evidence`,
  );
  const binding = roleEvidence.releaseBinding;
  exactObject(
    binding,
    [
      "gitCommitSha",
      "sourceManifestSha256",
      "releaseConfigSha256",
      "migrationsSha256",
      "runtimeImageDigest",
    ],
    `${role} commercial-load release binding`,
  );
  assert(
    /^[0-9a-f]{40}$/.test(binding.gitCommitSha),
    `${role} commercial-load commit is invalid`,
  );
  assert(
    binding.sourceManifestSha256 === context.sourceManifestSha256 &&
      sha256(sourceManifest) === context.sourceManifestSha256,
    `${role} commercial-load source manifest binding is stale`,
  );
  assert(
    binding.releaseConfigSha256 === sha256(releaseConfigBody),
    `${role} commercial-load release config binding is stale`,
  );
  assert(
    /^sha256:[0-9a-f]{64}$/.test(binding.runtimeImageDigest),
    `${role} commercial-load runtime image digest is invalid`,
  );
  assert(
    releaseConfig.schemaVersion === 1 &&
      releaseConfig.gitCommitSha === binding.gitCommitSha,
    `${role} commercial-load release config commit mismatch`,
  );
  assert(
    releaseConfig.sourceManifestSha256 === binding.sourceManifestSha256,
    `${role} commercial-load release config source mismatch`,
  );
  assert(
    releaseConfig.migrationsSha256 === binding.migrationsSha256,
    `${role} commercial-load release config migration mismatch`,
  );
  assert(
    releaseConfig.runtimeImageDigests?.[role] === binding.runtimeImageDigest,
    `${role} commercial-load release config image mismatch`,
  );
  assert(
    migrations.schemaVersion === 1 &&
      migrations.treeSha256 === binding.migrationsSha256,
    `${role} commercial-load migration tree binding mismatch`,
  );
  validateMigrationTree(migrations, context);
  assert(
    clock.schemaVersion === 1 &&
      clock.source === roleEvidence.window?.clockSource &&
      clock.maxOffsetMs === roleEvidence.window?.clockMaxOffsetMs,
    `${role} commercial-load clock evidence mismatch`,
  );
  assert(
    !Number.isNaN(Date.parse(clock.observedAt)),
    `${role} commercial-load clock timestamp is invalid`,
  );
}

function validateMigrationTree(migrations, context) {
  const expectedNames = [
    "001_indexer.sql",
    "002_settlement_evidence.sql",
    "003_read_api_indexes.sql",
  ];
  assert(
    Array.isArray(migrations.files) &&
      JSON.stringify(migrations.files.map((item) => item.name)) ===
        JSON.stringify(expectedNames),
    "commercial-load migration inventory drift",
  );
  const hash = createHash("sha256");
  for (const item of migrations.files) {
    exactObject(
      item,
      ["name", "bytes", "sha256"],
      `commercial-load migration ${item?.name ?? "<unknown>"}`,
    );
    const body = context.readEvidence(
      `offchain/indexer/migrations/${item.name}`,
    );
    assert(
      body.length === item.bytes && sha256(body) === item.sha256,
      `commercial-load migration evidence is stale: ${item.name}`,
    );
    hash.update(item.name);
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  assert(
    hash.digest("hex") === migrations.treeSha256,
    "commercial-load migration tree hash mismatch",
  );
}

function parseArtifact(files, name, label) {
  return parseJson(requiredArtifact(files, name, label), label);
}
function requiredArtifact(files, name, label) {
  const value = files.get(name);
  assert(value !== undefined, `${label} missing ${name}`);
  return value;
}
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateCommandEvidence(value, policy, context) {
  exactObject(
    value,
    [
      "schemaVersion",
      "evidenceType",
      "gateId",
      "runnerId",
      "command",
      "executionProfile",
      "result",
      "exitCode",
      "sourceManifestSha256",
    ],
    `command evidence ${policy.id}`,
  );
  validateCommandCore(value, policy, context, "CPREDICT_COMMAND_RESULT");
}

function validateCommandCore(value, policy, context, evidenceType) {
  assert(
    value.schemaVersion === 1 && value.evidenceType === evidenceType,
    `${policy.id} command evidence schema/type invalid`,
  );
  assert(
    value.gateId === policy.id &&
      value.runnerId === policy.runnerId &&
      value.command === policy.command,
    `${policy.id} command/runner identity mismatch`,
  );
  assert(
    value.executionProfile === "FULL" &&
      value.result === "PASS" &&
      value.exitCode === 0,
    `${policy.id} is not a successful FULL execution`,
  );
  assert(
    value.sourceManifestSha256 === context.sourceManifestSha256,
    `${policy.id} command evidence source binding is stale`,
  );
}

function validateSecurityEvidence(value, policy, context) {
  exactObject(
    value,
    [
      "schemaVersion",
      "gate",
      "result",
      "tool",
      "validatorExitCode",
      "platform",
      "sourceSnapshotSha256",
      "inputs",
      "evidence",
    ],
    `${policy.id} security evidence`,
  );
  exactObject(
    value.tool,
    ["name", "version", "artifactSha256", "rawExitCode", "acceptedExitCodes"],
    `${policy.id} security tool`,
  );
  assert(
    value.schemaVersion === 1,
    `${policy.id} security evidence schema drift`,
  );
  assert(
    value.gate === policy.evidenceGate,
    `${policy.id} security evidence gate mismatch`,
  );
  assert(
    value.result === "PASS" && value.validatorExitCode === 0,
    `${policy.id} security validator did not PASS`,
  );
  assert(
    value.platform === "darwin-arm64",
    `${policy.id} security runner platform mismatch`,
  );
  const identity = SECURITY_TOOL_IDENTITIES[policy.evidenceGate];
  assert(
    identity !== undefined &&
      value.tool.name === identity.name &&
      value.tool.version === identity.version &&
      value.tool.artifactSha256 === identity.artifactSha256,
    `${policy.id} security tool identity mismatch`,
  );
  assert(
    Number.isInteger(value.tool.rawExitCode) &&
      Array.isArray(value.tool.acceptedExitCodes) &&
      value.tool.acceptedExitCodes.length > 0,
    `${policy.id} security tool exit inventory invalid`,
  );
  unique(value.tool.acceptedExitCodes, `${policy.id} accepted tool exits`);
  assert(
    value.tool.acceptedExitCodes.includes(value.tool.rawExitCode),
    `${policy.id} security tool exit invalid`,
  );
  const inputPaths = validateSecurityInventory(
    value.inputs,
    `${policy.id} security input`,
    context,
    false,
  );
  const evidencePaths = validateSecurityInventory(
    value.evidence,
    `${policy.id} security artifact`,
    context,
    true,
  );
  for (const path of inputPaths)
    assert(
      !evidencePaths.has(path),
      `${policy.id} security input/evidence path overlap`,
    );
  assertSha(value.sourceSnapshotSha256, `${policy.id} source snapshot hash`);
  assert(
    value.sourceSnapshotSha256 === hashSecurityInventory(value.inputs),
    `${policy.id} security source snapshot mismatch`,
  );
}

function validateSecurityInventory(items, label, context, outputOnly) {
  assert(Array.isArray(items) && items.length > 0, `${label} inventory empty`);
  const paths = new Set();
  let previous = "";
  for (const item of items) {
    exactObject(item, ["path", "bytes", "sha256"], `${label} entry`);
    validateReleaseEvidencePath(item.path);
    assert(
      !outputOnly || item.path.startsWith("reports/security/"),
      `${label} must be under reports/security`,
    );
    assert(
      previous === "" || compare(previous, item.path) < 0,
      `${label} inventory is not sorted`,
    );
    previous = item.path;
    assert(
      !paths.has(item.path),
      `${label} inventory contains duplicate paths`,
    );
    paths.add(item.path);
    assert(
      Number.isSafeInteger(item.bytes) && item.bytes >= 0,
      `${label} byte size invalid`,
    );
    assertSha(item.sha256, `${label} hash`);
    const bytes = context.readEvidence(item.path);
    assert(
      bytes.length === item.bytes,
      `${label} byte size is stale for ${item.path}`,
    );
    assert(
      sha256(bytes) === item.sha256,
      `${label} SHA-256 is stale for ${item.path}`,
    );
  }
  return paths;
}

function hashSecurityInventory(items) {
  const canonical = items
    .map((item) => `${item.path}|${item.bytes}|${item.sha256}`)
    .join("\n");
  return sha256(Buffer.from(`${canonical}\n`));
}

function securityEvidencePath(evidenceGate) {
  return evidenceGate === "solidity-smtchecker"
    ? "reports/security/smtchecker-evidence.json"
    : `reports/security/${evidenceGate}-evidence.json`;
}

function validateChecksumList(text, context) {
  const rows = text.trimEnd().split("\n");
  assert(rows.length >= 4, "coverage checksum inventory incomplete");
  const seen = new Set();
  for (const row of rows) {
    const match = row.match(
      /^([0-9a-f]{64})  (reports\/coverage\/[A-Za-z0-9._-]+)$/,
    );
    assert(match, `invalid coverage checksum row: ${row}`);
    assert(!seen.has(match[2]), `duplicate coverage checksum path ${match[2]}`);
    seen.add(match[2]);
    assert(
      sha256(context.readEvidence(match[2])) === match[1],
      `stale coverage evidence ${match[2]}`,
    );
  }
  for (const path of [
    "reports/coverage/full.lcov",
    "reports/coverage/full.summary.txt",
    "reports/coverage/production-viair-forced-build.log",
    "reports/coverage/production-gas-assertion-check.log",
  ]) {
    assert(seen.has(path), `coverage checksum missing ${path}`);
  }
}

function secureCheckoutReader(root) {
  return (path) => {
    validateReleaseEvidencePath(
      path,
      path === RELEASE_GATES_CONFIG_PATH || path === RELEASE_GATES_PATH,
    );
    const requested = join(root, path);
    const metadata = lstatSync(requested);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `release evidence must be a regular non-symlink file: ${path}`,
    );
    const actual = realpathSync(requested);
    const child = relative(root, actual);
    assert(
      child !== "" && !child.startsWith("..") && !isAbsolute(child),
      `release evidence escapes checkout: ${path}`,
    );
    return readFileSync(actual);
  };
}

export function validateReleaseEvidencePath(path, allowIndex = false) {
  assert(
    typeof path === "string" && /^[\x20-\x7e]+$/.test(path),
    "invalid release evidence path",
  );
  assert(
    !path.startsWith("/") && !path.includes("\\"),
    `unsafe release evidence path ${path}`,
  );
  const parts = path.split("/");
  assert(
    parts.every((part) => part && part !== "." && part !== ".."),
    `unsafe release evidence path ${path}`,
  );
  assert(
    allowIndex || path !== RELEASE_GATES_PATH,
    "release gates index cannot evidence itself",
  );
}

function exactRoles(evidence, roles) {
  assert(
    JSON.stringify([...evidence.keys()].sort(compare)) ===
      JSON.stringify([...roles].sort(compare)),
    `raw evidence role inventory mismatch; expected ${roles.join(",")}`,
  );
}
function exactPath(evidence, role, path) {
  assert(
    evidence.get(role)?.path === path,
    `raw evidence ${role} must be ${path}`,
  );
}
function jsonEvidence(evidence, role) {
  return parseJson(evidence.get(role).bytes, evidence.get(role).path);
}
function unique(values, label) {
  assert(new Set(values).size === values.length, `duplicate ${label}`);
}
function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function compare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function assertSha(value, label) {
  assert(/^[0-9a-f]{64}$/.test(value), `invalid ${label}`);
}
function exactObject(value, keys, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unknown or missing keys`,
  );
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
