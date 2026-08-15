import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  REQUIRED_GATE_POLICY,
  checkReleaseGates,
  validateGateResult,
  validateReleaseGatesConfig,
  validateReleaseGatesDocument,
} from "./release-gates-common.mjs";
import { hash, validReleaseGateFixture } from "./release-gates-fixture.mjs";
import { aggregateReleaseGates } from "./aggregate-release-gates.mjs";
import {
  parseArguments as parseGateRunnerArguments,
  runReleaseGate,
} from "./run-release-gate.mjs";
import {
  parseArguments as parseCommercialLoadArguments,
  recordCommercialLoad,
  validateCommercialLoadSameSha,
} from "./record-commercial-load.mjs";

const source = Buffer.from('{"schemaVersion":1}\n');

test("accepts the exact 22-gate semantic result inventory", () => {
  const fixture = validReleaseGateFixture(source);
  assert.doesNotThrow(() =>
    validateReleaseGatesDocument(
      fixture.document,
      fixture.config,
      context(fixture),
    ),
  );
});

test("rejects unknown, duplicate, missing, broad-prefix and stale result references", () => {
  const fixture = validReleaseGateFixture(source);
  for (const mutate of [
    (value) => {
      value.gates[0].id = "unknown";
    },
    (value) => {
      value.gates[1].id = value.gates[0].id;
    },
    (value) => {
      value.gates.pop();
    },
    (value) => {
      value.gates[0].resultPath = "reports/release/gates/arbitrary.json";
    },
    (value) => {
      value.gates[0].sha256 = "0".repeat(64);
    },
  ]) {
    const changed = structuredClone(fixture.document);
    mutate(changed);
    assert.throws(
      () =>
        validateReleaseGatesDocument(changed, fixture.config, context(fixture)),
      /unknown|duplicate|incomplete|exact result path|stale|sorted/,
    );
  }
});

test("rejects forged PASS metadata, smoke profiles and wrong command/runner identity", () => {
  const fixture = validReleaseGateFixture(source);
  const policy = REQUIRED_GATE_POLICY.find(
    (item) => item.id === "solidity-viair",
  );
  const original = JSON.parse(fixture.files.get(policy.resultPath));
  for (const [field, value, pattern] of [
    ["result", "FAIL", /only PASS/],
    ["exitCode", 1, /exitCode/],
    ["executionProfile", "SMOKE", /not a FULL/],
    ["command", "forge test --match-test smoke", /command mismatch/],
    ["runnerId", "manual", /runner identity/],
  ]) {
    const changed = structuredClone(original);
    changed[field] = value;
    assert.throws(
      () => validateGateResult(changed, policy, context(fixture)),
      pattern,
    );
  }
});

test("semantic validators reject failed Echidna, signed commercial-load tampering, adverse economics, and full mutation evidence", () => {
  const fixture = validReleaseGateFixture(source);
  rejectRawMutation(
    fixture,
    "echidna",
    (raw) => {
      raw.result = "FAIL";
    },
    /did not PASS/,
  );
  rejectRawMutation(
    fixture,
    "echidna",
    (raw) => {
      raw.tool.name = "manual-smoke";
    },
    /tool identity mismatch/,
  );
  rejectRawMutation(
    fixture,
    "mutation",
    (raw) => {
      raw.gate = "mutation-feevault";
    },
    /gate mismatch/,
  );
  rejectRawMutation(
    fixture,
    "commercial-load",
    (raw) => {
      raw.metrics.dropped_iterations.count = 1;
    },
    /artifact inventory is stale/,
    "load-k6-api-summary-json",
  );
  rejectRawMutation(
    fixture,
    "commercial-load",
    (raw) => {
      raw.metrics.ws_sessions.count = 9_351;
    },
    /artifact inventory is stale/,
    "load-k6-websocket-summary-json",
  );
  rejectRawMutation(
    fixture,
    "commercial-economics",
    (raw) => {
      raw.bondEvidence.cohorts[0].observedAttackProfitP95Atomic = "999999999";
    },
    /not reproducible/,
    "input",
  );

  const policy = REQUIRED_GATE_POLICY.find((item) => item.id === "echidna");
  const result = JSON.parse(fixture.files.get(policy.resultPath));
  const security = JSON.parse(fixture.files.get(result.rawEvidence[0].path));
  const files = new Map(fixture.files);
  files.set(security.evidence[0].path, Buffer.from("forged PASS\n"));
  assert.throws(
    () =>
      validateGateResult(result, policy, {
        sourceManifestSha256: fixture.sourceHash,
        readEvidence: (path) => required(files, path),
      }),
    /(byte size|SHA-256) is stale/,
  );
});

test("coverage and PostgreSQL semantic records reject missing or skipped proof", () => {
  const fixture = validReleaseGateFixture(source);
  const coverage = REQUIRED_GATE_POLICY.find((item) => item.id === "coverage");
  const coverageResult = JSON.parse(fixture.files.get(coverage.resultPath));
  const summaryPath = coverageResult.rawEvidence.find(
    (item) => item.role === "summary",
  ).path;
  const changedFiles = new Map(fixture.files);
  changedFiles.set(summaryPath, Buffer.from("coverage-full exit code: 0\n"));
  coverageResult.rawEvidence.find((item) => item.role === "summary").sha256 =
    hash(changedFiles.get(summaryPath));
  assert.throws(
    () =>
      validateGateResult(coverageResult, coverage, {
        sourceManifestSha256: fixture.sourceHash,
        readEvidence: (path) => required(changedFiles, path),
      }),
    /coverage summary missing/,
  );

  rejectRawMutation(
    fixture,
    "postgresql",
    (raw) => {
      raw.totals.skipped = 1;
      raw.totals.passed = 8;
    },
    /zero-skip totals invalid/,
  );
  rejectRawMutation(
    fixture,
    "deployment-tooling",
    (raw) => {
      raw.totals.skipped = 1;
      raw.totals.passed = 17;
    },
    /deployment tooling zero-skip totals invalid/,
  );
});

test("commercial economics PASS expires at its bounded validUntil", () => {
  const fixture = validReleaseGateFixture(source);
  const policy = REQUIRED_GATE_POLICY.find(
    (item) => item.id === "commercial-economics",
  );
  const result = JSON.parse(fixture.files.get(policy.resultPath));
  const assessmentRole = result.rawEvidence.find(
    (item) => item.role === "assessment",
  );
  const assessment = JSON.parse(fixture.files.get(assessmentRole.path));
  assert.throws(
    () =>
      validateGateResult(result, policy, {
        sourceManifestSha256: fixture.sourceHash,
        readEvidence: (path) => required(fixture.files, path),
        auditTimeMs: Date.parse(assessment.validUntil) + 1,
      }),
    /has expired/,
  );
});

test("history secret scan result rejects shallow or mutable scanner execution", () => {
  const fixture = validReleaseGateFixture(source);
  rejectRawMutation(
    fixture,
    "history-secret-scan",
    (raw) => {
      raw.executionProfile = "WORKTREE_ONLY";
    },
    /full Git history/,
  );
  rejectRawMutation(
    fixture,
    "history-secret-scan",
    (raw) => {
      raw.actionCommit = "0".repeat(40);
    },
    /action commit drift/,
  );
  rejectRawMutation(
    fixture,
    "history-secret-scan",
    (raw) => {
      raw.updatePolicy = "enabled";
    },
    /updates must be disabled/,
  );
});

test("repository policy equals fixed code policy and missing aggregate fails closed", async (t) => {
  const config = JSON.parse(
    await readFile("manifests/release-gates.config.json", "utf8"),
  );
  assert.doesNotThrow(() => validateReleaseGatesConfig(config));
  const fixture = await mkdtemp(join(tmpdir(), "cpredict-release-gates-"));
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "manifests"));
  await writeFile(
    join(fixture, "manifests/release-gates.config.json"),
    JSON.stringify(config),
  );
  await writeFile(join(fixture, "manifests/source-manifest.json"), source);
  await assert.rejects(
    checkReleaseGates(fixture),
    /release-gates\.json.*absent or invalid/,
  );
});

test("checkout validator may read the aggregate index but raw evidence cannot self-reference it", async (t) => {
  const fixture = validReleaseGateFixture(source);
  const root = await mkdtemp(
    join(tmpdir(), "cpredict-release-gates-complete-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of fixture.files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await writeFile(join(root, "manifests/source-manifest.json"), source);
  await assert.doesNotReject(checkReleaseGates(root));

  const policy = REQUIRED_GATE_POLICY.find(
    (item) => item.id === "solidity-viair",
  );
  const result = JSON.parse(fixture.files.get(policy.resultPath));
  result.rawEvidence[0].path = "manifests/release-gates.json";
  result.rawEvidence[0].sha256 = hash(
    fixture.files.get("manifests/release-gates.json"),
  );
  assert.throws(
    () => validateGateResult(result, policy, context(fixture)),
    /cannot evidence itself/,
  );
});

test("production gate runner accepts only a fixed gate and external evidence root", () => {
  assert.deepEqual(
    parseGateRunnerArguments([
      "--gate",
      "coverage",
      "--evidence-root",
      "/tmp/evidence",
    ]),
    {
      gate: "coverage",
      evidenceRoot: "/tmp/evidence",
    },
  );
  assert.throws(
    () => parseGateRunnerArguments(["--gate", "coverage"]),
    /evidence-root is required/,
  );
  assert.throws(
    () =>
      runReleaseGate({
        gate: "history-secret-scan",
        evidenceRoot: "/tmp/cpredict-release-runner-history",
      }),
    /pinned GitHub action recorder/,
  );
  assert.throws(
    () =>
      runReleaseGate({
        gate: "commercial-load",
        evidenceRoot: "/tmp/cpredict-release-runner-commercial-load",
      }),
    /protected distributed evidence recorder/,
  );
  assert.throws(
    () =>
      runReleaseGate({
        gate: "unknown",
        evidenceRoot: "/tmp/cpredict-release-runner-unknown",
      }),
    /unknown release gate/,
  );
});

test("commercial-load recorder CLI requires an external signed bundle, pinned key hash, and evidence root", () => {
  assert.deepEqual(
    parseCommercialLoadArguments([
      "--bundle",
      "/tmp/bundle",
      "--trusted-public-key",
      "/tmp/key.pem",
      "--trusted-public-key-sha256",
      "a".repeat(64),
      "--evidence-root",
      "/tmp/evidence",
    ]),
    {
      bundle: "/tmp/bundle",
      trustedPublicKey: "/tmp/key.pem",
      trustedPublicKeySha256: "a".repeat(64),
      evidenceRoot: "/tmp/evidence",
    },
  );
  assert.throws(
    () => parseCommercialLoadArguments(["--bundle", "/tmp/bundle"]),
    /required/,
  );
});

test("commercial-load recorder fails before publishing when GitHub same-SHA identity is absent or invalid", async () => {
  await assert.rejects(
    recordCommercialLoad({
      root: process.cwd(),
      bundle: process.cwd(),
      trustedPublicKey: "package.json",
      trustedPublicKeySha256: "a".repeat(64),
      evidenceRoot: join(
        tmpdir(),
        `cpredict-commercial-load-same-sha-${process.pid}-${Date.now()}`,
      ),
      environment: {},
    }),
    /GITHUB_SHA/,
  );
});

test("commercial-load same-SHA binding rejects one role from a different audit commit", () => {
  const sourceManifestSha256 = "a".repeat(64);
  const auditCommit = "b".repeat(40);
  const roles = Object.fromEntries(
    ["sut", "load", "chain"].map((role) => [
      role,
      {
        releaseBinding: { sourceManifestSha256, gitCommitSha: auditCommit },
      },
    ]),
  );
  assert.doesNotThrow(() =>
    validateCommercialLoadSameSha({ roles, sourceManifestSha256, auditCommit }),
  );
  roles.chain.releaseBinding.gitCommitSha = "c".repeat(40);
  assert.throws(
    () =>
      validateCommercialLoadSameSha({
        roles,
        sourceManifestSha256,
        auditCommit,
      }),
    /chain.*GitHub audit commit/,
  );
});

test("release semantic validators bind commercial-load and economics evidence to the expected GitHub commit", () => {
  const fixture = validReleaseGateFixture(source);
  for (const [gateId, expectedCommitSha, pattern] of [
    [
      "commercial-load",
      "c".repeat(40),
      /commercial-load audit commit binding is stale/,
    ],
    [
      "commercial-economics",
      "d".repeat(40),
      /economics audit commit binding is stale/,
    ],
  ]) {
    const policy = REQUIRED_GATE_POLICY.find((item) => item.id === gateId);
    const result = JSON.parse(fixture.files.get(policy.resultPath));
    assert.throws(
      () =>
        validateGateResult(result, policy, {
          sourceManifestSha256: fixture.sourceHash,
          expectedCommitSha,
          readEvidence: (path) => required(fixture.files, path),
        }),
      pattern,
    );
  }
});

test("production aggregator builds and revalidates the exact external 22-gate index", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "cpredict-release-aggregate-root-"),
  );
  const evidenceRoot = await mkdtemp(
    join(tmpdir(), "cpredict-release-aggregate-evidence-"),
  );
  t.after(async () =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidenceRoot, { recursive: true, force: true }),
    ]),
  );
  const manifest = Buffer.from('{"schemaVersion":1,"files":[]}\n');
  const fixture = validReleaseGateFixture(manifest);
  await mkdir(join(root, "manifests"));
  await writeFile(join(root, "manifests/source-manifest.json"), manifest);
  await writeFile(
    join(root, "manifests/release-gates.config.json"),
    JSON.stringify(fixture.config),
  );
  for (const [path, bytes] of fixture.files) {
    if (
      path === "manifests/release-gates.json" ||
      path === "manifests/release-gates.config.json"
    )
      continue;
    await mkdir(dirname(join(evidenceRoot, path)), { recursive: true });
    await writeFile(join(evidenceRoot, path), bytes);
  }
  const document = await aggregateReleaseGates({ root, evidenceRoot });
  assert.equal(document.gates.length, 22);
  assert.equal((await checkReleaseGates(root, evidenceRoot)).gates.length, 22);
});

function rejectRawMutation(fixture, gateId, mutate, pattern, role) {
  const policy = REQUIRED_GATE_POLICY.find((item) => item.id === gateId);
  const result = JSON.parse(fixture.files.get(policy.resultPath));
  const raw =
    role === undefined
      ? result.rawEvidence[0]
      : result.rawEvidence.find((item) => item.role === role);
  if (raw === undefined)
    throw new Error(`fixture role ${role} is absent for ${gateId}`);
  const files = new Map(fixture.files);
  const value = JSON.parse(files.get(raw.path));
  mutate(value);
  files.set(raw.path, Buffer.from(`${JSON.stringify(value)}\n`));
  raw.sha256 = hash(files.get(raw.path));
  assert.throws(
    () =>
      validateGateResult(result, policy, {
        sourceManifestSha256: fixture.sourceHash,
        readEvidence: (path) => required(files, path),
      }),
    pattern,
  );
}

function context(fixture) {
  return {
    sourceManifestSha256: fixture.sourceHash,
    readEvidence: (path) => required(fixture.files, path),
  };
}

function required(files, path) {
  const value = files.get(path);
  if (value === undefined) throw new Error(`missing fixture ${path}`);
  return value;
}
