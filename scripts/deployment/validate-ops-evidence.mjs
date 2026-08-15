#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  REQUIRED_DRILLS,
  assertAddress,
  assertExactKeys,
  assertHash,
  assertInteger,
  assertRuntimeEvidence,
  assertSha256,
  assertString,
  assertTimestamp,
  assertUnique,
  readJson,
  sha256Json,
} from "./evidence-lib.mjs";

function validateArtifact(artifact, path) {
  assertExactKeys(artifact, ["kind", "uri", "sha256", "capturedAt"], path);
  if (
    ![
      "RPC_RESPONSE",
      "METRICS",
      "ALERT_RECEIPT",
      "DATABASE_REPORT",
      "KMS_ATTESTATION",
      "RUNBOOK_LOG",
      "TRANSACTION_RECEIPT",
    ].includes(artifact.kind)
  )
    throw new Error(`${path}.kind: unsupported artifact kind`);
  if (
    !/^(https:\/\/|ipfs:\/\/|s3:\/\/|gs:\/\/|artifact:)/.test(
      assertString(artifact.uri, `${path}.uri`),
    )
  )
    throw new Error(
      `${path}.uri: must be a durable evidence URI, not a local template path`,
    );
  assertSha256(artifact.sha256, `${path}.sha256`);
  assertTimestamp(artifact.capturedAt, `${path}.capturedAt`);
}

export function validateOpsEvidence(evidence) {
  assertExactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceClass",
      "status",
      "chainId",
      "generatedAt",
      "deploymentManifestSha256",
      "referenceBlock",
      "operators",
      "drills",
      "signoff",
    ],
    "ops",
  );
  assertRuntimeEvidence(evidence, "cpredict.base-sepolia.ops-drill.v1", "ops");
  if (evidence.status !== "COMPLETE")
    throw new Error("ops.status: must equal COMPLETE");
  assertTimestamp(evidence.generatedAt, "ops.generatedAt");
  assertSha256(
    evidence.deploymentManifestSha256,
    "ops.deploymentManifestSha256",
  );
  assertExactKeys(
    evidence.referenceBlock,
    ["number", "hash"],
    "ops.referenceBlock",
  );
  assertInteger(evidence.referenceBlock.number, "ops.referenceBlock.number", {
    min: 1,
  });
  assertHash(evidence.referenceBlock.hash, "ops.referenceBlock.hash");
  if (!Array.isArray(evidence.operators) || evidence.operators.length < 2)
    throw new Error(
      "ops.operators: at least two independent operators are required",
    );
  const operators = evidence.operators.map((operator, i) => {
    assertExactKeys(operator, ["address", "role"], `ops.operators[${i}]`);
    const address = assertAddress(
      operator.address,
      `ops.operators[${i}].address`,
    );
    if (
      !["DEPLOYMENT_OPERATOR", "SECURITY_REVIEWER", "ONCALL_OPERATOR"].includes(
        operator.role,
      )
    )
      throw new Error(`ops.operators[${i}].role: invalid role`);
    return address;
  });
  assertUnique(operators, "ops.operators addresses");

  if (
    !Array.isArray(evidence.drills) ||
    evidence.drills.length !== REQUIRED_DRILLS.length
  )
    throw new Error(
      `ops.drills: must contain exactly ${REQUIRED_DRILLS.length} required drills`,
    );
  const ids = [];
  for (const [i, drill] of evidence.drills.entries()) {
    const path = `ops.drills[${i}]`;
    assertExactKeys(
      drill,
      [
        "id",
        "status",
        "startedAt",
        "completedAt",
        "artifacts",
        "observedOutcome",
      ],
      path,
    );
    if (!REQUIRED_DRILLS.includes(drill.id))
      throw new Error(`${path}.id: unknown drill`);
    ids.push(drill.id);
    if (drill.status !== "PASS")
      throw new Error(`${path}.status: must equal PASS`);
    assertTimestamp(drill.startedAt, `${path}.startedAt`);
    assertTimestamp(drill.completedAt, `${path}.completedAt`);
    if (Date.parse(drill.completedAt) < Date.parse(drill.startedAt))
      throw new Error(`${path}.completedAt: precedes startedAt`);
    if (!Array.isArray(drill.artifacts) || drill.artifacts.length === 0)
      throw new Error(
        `${path}.artifacts: at least one evidence artifact is required`,
      );
    drill.artifacts.forEach((artifact, j) =>
      validateArtifact(artifact, `${path}.artifacts[${j}]`),
    );
    const kinds = drill.artifacts.map((artifact) => artifact.kind);
    const requireKind = (kind) => {
      if (!kinds.includes(kind))
        throw new Error(`${path}.artifacts: ${drill.id} requires ${kind}`);
    };
    if (
      [
        "roles.independentRpcSnapshot",
        "incident.rpcDivergence",
        "rpc.failover",
      ].includes(drill.id)
    ) {
      const rpcArtifacts = drill.artifacts.filter(
        (artifact) => artifact.kind === "RPC_RESPONSE",
      );
      if (
        rpcArtifacts.length < 2 ||
        new Set(rpcArtifacts.map((artifact) => artifact.uri)).size < 2
      )
        throw new Error(
          `${path}.artifacts: ${drill.id} requires two independent RPC_RESPONSE artifacts`,
        );
    }
    if (drill.id === "monitoring.metricsScrape") requireKind("METRICS");
    if (drill.id === "monitoring.alertDelivery") requireKind("ALERT_RECEIPT");
    if (
      [
        "emergency.pauseNewRisk",
        "emergency.exitStillAvailable",
        "emergency.autoExpiry",
      ].includes(drill.id)
    )
      requireKind("TRANSACTION_RECEIPT");
    if (["indexer.reorgRecovery", "indexer.backupRestore"].includes(drill.id))
      requireKind("DATABASE_REPORT");
    if (drill.id === "paymaster.kmsRotation") requireKind("KMS_ATTESTATION");
    assertString(drill.observedOutcome, `${path}.observedOutcome`);
  }
  assertUnique(ids, "ops.drills ids");
  for (const required of REQUIRED_DRILLS)
    if (!ids.includes(required))
      throw new Error(`ops.drills: missing ${required}`);

  assertExactKeys(
    evidence.signoff,
    [
      "deploymentOperator",
      "securityReviewer",
      "oncallOperator",
      "signedAt",
      "statementSha256",
    ],
    "ops.signoff",
  );
  for (const key of [
    "deploymentOperator",
    "securityReviewer",
    "oncallOperator",
  ]) {
    const address = assertAddress(evidence.signoff[key], `ops.signoff.${key}`);
    if (!operators.includes(address))
      throw new Error(`ops.signoff.${key}: signer not listed in operators`);
  }
  assertUnique(
    [
      evidence.signoff.deploymentOperator,
      evidence.signoff.securityReviewer,
      evidence.signoff.oncallOperator,
    ],
    "ops.signoff signers",
  );
  assertTimestamp(evidence.signoff.signedAt, "ops.signoff.signedAt");
  assertSha256(evidence.signoff.statementSha256, "ops.signoff.statementSha256");
  return { evidence, sha256: sha256Json(evidence) };
}

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "usage: node scripts/deployment/validate-ops-evidence.mjs <ops-evidence.json>",
    );
  const result = validateOpsEvidence(await readJson(path));
  process.stdout.write(
    `PASS Base Sepolia operations evidence ${result.sha256}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
