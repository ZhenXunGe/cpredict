import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReleaseGates } from "./release-gates-common.mjs";

export const RELEASE_CI_ATTESTATION_CONFIG_PATH =
  "manifests/release-ci-attestation.config.json";
export const RELEASE_CI_ATTESTATION_PREDICATE_SCHEMA_VERSION = 2;

export async function buildPredicateFromCheckout(
  root,
  evidenceRoot,
  environment = process.env,
) {
  const config = readConfig(root);
  const gates = await checkReleaseGates(root, evidenceRoot);
  const sourceManifestBytes = readFileSync(
    join(root, "manifests/source-manifest.json"),
  );
  return buildReleaseCiPredicate({
    config,
    gates,
    sourceManifestBytes,
    environment,
  });
}

export function buildReleaseCiPredicate({
  config,
  gates,
  sourceManifestBytes,
  environment,
}) {
  validateAttestationConfig(config);
  const expectedWorkflowRef = `${config.repository}/${config.workflowPath}@${config.workflowRef}`;
  assert(
    environment.GITHUB_ACTIONS === "true",
    "predicate creation is restricted to GitHub Actions",
  );
  assert(
    environment.GITHUB_REPOSITORY === config.repository,
    "attestation repository mismatch",
  );
  assert(
    environment.GITHUB_REF === config.workflowRef,
    "attestation workflow ref mismatch",
  );
  assert(
    environment.GITHUB_EVENT_NAME === config.workflowEvent,
    "attestation workflow event mismatch",
  );
  assert(
    environment.GITHUB_WORKFLOW_REF === expectedWorkflowRef,
    "attestation workflow identity mismatch",
  );
  assert(
    environment.GITHUB_JOB === config.signerJob,
    "attestation signer job mismatch",
  );
  assert(
    environment.RUNNER_ENVIRONMENT === "github-hosted",
    "attestation signer must use a GitHub-hosted runner",
  );
  const commitSha = requireCommit(environment.GITHUB_SHA, "GITHUB_SHA");
  assert(
    environment.GITHUB_WORKFLOW_SHA === commitSha,
    "attestation workflow SHA must equal source commit SHA",
  );
  const runId = requirePositiveInteger(
    environment.GITHUB_RUN_ID,
    "GITHUB_RUN_ID",
  );
  const runAttempt = requirePositiveInteger(
    environment.GITHUB_RUN_ATTEMPT,
    "GITHUB_RUN_ATTEMPT",
  );
  const predicate = {
    schemaVersion: RELEASE_CI_ATTESTATION_PREDICATE_SCHEMA_VERSION,
    repository: config.repository,
    commitSha,
    sourceManifestSha256: sha256(sourceManifestBytes),
    workflow: {
      path: config.workflowPath,
      ref: config.workflowRef,
      sha: commitSha,
      event: config.workflowEvent,
      job: config.signerJob,
      runId,
      runAttempt,
    },
    gates: gates.gates.map((gate) => ({ ...gate })),
  };
  validateReleaseCiPredicate(predicate, {
    config,
    gates,
    sourceManifestBytes,
    commitSha,
  });
  return predicate;
}

export function validateReleaseCiPredicate(predicate, expected) {
  validateAttestationConfig(expected.config);
  exactObject(
    predicate,
    [
      "schemaVersion",
      "repository",
      "commitSha",
      "sourceManifestSha256",
      "workflow",
      "gates",
    ],
    "release CI predicate",
  );
  assert(
    predicate.schemaVersion === RELEASE_CI_ATTESTATION_PREDICATE_SCHEMA_VERSION,
    "release CI predicate schema drift",
  );
  assert(
    predicate.repository === expected.config.repository,
    "release CI predicate repository mismatch",
  );
  assert(
    predicate.commitSha ===
      requireCommit(expected.commitSha, "expected commit SHA"),
    "release CI predicate commit mismatch",
  );
  assert(
    predicate.sourceManifestSha256 === sha256(expected.sourceManifestBytes),
    "release CI predicate source manifest mismatch",
  );
  exactObject(
    predicate.workflow,
    ["path", "ref", "sha", "event", "job", "runId", "runAttempt"],
    "release CI predicate workflow",
  );
  assert(
    predicate.workflow.path === expected.config.workflowPath,
    "release CI predicate workflow path mismatch",
  );
  assert(
    predicate.workflow.ref === expected.config.workflowRef,
    "release CI predicate workflow ref mismatch",
  );
  assert(
    predicate.workflow.sha === predicate.commitSha,
    "release CI predicate workflow SHA mismatch",
  );
  assert(
    predicate.workflow.event === expected.config.workflowEvent,
    "release CI predicate event mismatch",
  );
  assert(
    predicate.workflow.job === expected.config.signerJob,
    "release CI predicate signer job mismatch",
  );
  assert(
    Number.isSafeInteger(predicate.workflow.runId) &&
      predicate.workflow.runId > 0,
    "release CI predicate run ID invalid",
  );
  assert(
    Number.isSafeInteger(predicate.workflow.runAttempt) &&
      predicate.workflow.runAttempt > 0,
    "release CI predicate run attempt invalid",
  );
  assert(
    Array.isArray(predicate.gates) && predicate.gates.length === 22,
    "release CI predicate must bind exactly 22 gates",
  );
  assert(
    JSON.stringify(predicate.gates) === JSON.stringify(expected.gates.gates),
    "release CI predicate gate result inventory mismatch",
  );
  return predicate;
}

export function validateGitHubVerificationOutput(output, expected) {
  validateAttestationConfig(expected.config);
  assert(
    Array.isArray(output) && output.length === 1,
    "expected exactly one GitHub-verified attestation",
  );
  const result = output[0]?.verificationResult;
  assertObject(result, "GitHub verification result");
  const certificate = result.signature?.certificate;
  assertObject(certificate, "GitHub attestation certificate");
  assert(
    Array.isArray(result.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0,
    "attestation has no verified timestamp",
  );
  const commitSha = requireCommit(expected.commitSha, "expected commit SHA");
  const repositoryUri = `https://github.com/${expected.config.repository}`;
  const expectedRunUri = `${repositoryUri}/actions/runs/${result.statement?.predicate?.workflow?.runId}/attempts/${result.statement?.predicate?.workflow?.runAttempt}`;
  for (const [field, value] of [
    ["subjectAlternativeName", expected.config.certificateIdentity],
    ["issuer", expected.config.oidcIssuer],
    ["runnerEnvironment", "github-hosted"],
    ["sourceRepositoryURI", repositoryUri],
    ["sourceRepositoryDigest", commitSha],
    ["sourceRepositoryRef", expected.config.workflowRef],
    ["githubWorkflowRepository", expected.config.repository],
    ["githubWorkflowRef", expected.config.workflowRef],
    ["githubWorkflowSHA", commitSha],
    ["githubWorkflowTrigger", expected.config.workflowEvent],
    ["buildSignerURI", expected.config.certificateIdentity],
    ["buildSignerDigest", commitSha],
    ["runInvocationURI", expectedRunUri],
  ])
    assert(
      certificate[field] === value,
      `attestation certificate ${field} mismatch`,
    );

  const statement = result.statement;
  exactObject(
    statement,
    ["_type", "subject", "predicateType", "predicate"],
    "attestation statement",
  );
  assert(
    statement._type === "https://in-toto.io/Statement/v1",
    "attestation statement type mismatch",
  );
  assert(
    statement.predicateType === expected.config.predicateType,
    "attestation predicate type mismatch",
  );
  assert(
    Array.isArray(statement.subject) && statement.subject.length === 1,
    "attestation must have exactly one subject",
  );
  exactObject(statement.subject[0], ["name", "digest"], "attestation subject");
  exactObject(
    statement.subject[0].digest,
    ["sha256"],
    "attestation subject digest",
  );
  assert(
    statement.subject[0].name === expected.config.subjectName,
    "attestation subject name mismatch",
  );
  assert(
    statement.subject[0].digest.sha256 === sha256(expected.releaseGatesBytes),
    "attestation subject digest mismatch",
  );
  validateReleaseCiPredicate(statement.predicate, {
    config: expected.config,
    gates: expected.gates,
    sourceManifestBytes: expected.sourceManifestBytes,
    commitSha,
  });
  if (expected.runId !== undefined) {
    assert(
      Number.isSafeInteger(expected.runId) && expected.runId > 0,
      "expected audit run ID invalid",
    );
    assert(
      statement.predicate.workflow.runId === expected.runId,
      "release CI predicate run ID mismatch",
    );
  }
  return statement.predicate;
}

export function validateAttestationConfig(config) {
  exactObject(
    config,
    [
      "schemaVersion",
      "repository",
      "workflowPath",
      "workflowRef",
      "workflowEvent",
      "signerJob",
      "certificateIdentity",
      "oidcIssuer",
      "signerWorkflow",
      "predicateType",
      "subjectName",
      "attestAction",
    ],
    "release CI attestation config",
  );
  assert(
    config.schemaVersion === 2,
    "release CI attestation config schema drift",
  );
  assert(
    config.repository === "ZhenXunGe/cpredict",
    "release CI attestation repository drift",
  );
  assert(
    config.workflowPath === ".github/workflows/release-audit.yml",
    "release CI attestation workflow path drift",
  );
  assert(
    config.workflowRef === "refs/heads/main" &&
      config.workflowEvent === "workflow_dispatch",
    "release CI attestation workflow trigger drift",
  );
  assert(
    config.signerJob === "attest-release-gates",
    "release CI attestation signer job drift",
  );
  assert(
    config.certificateIdentity ===
      `https://github.com/${config.repository}/${config.workflowPath}@${config.workflowRef}`,
    "release CI certificate identity drift",
  );
  assert(
    config.oidcIssuer === "https://token.actions.githubusercontent.com",
    "release CI OIDC issuer drift",
  );
  assert(
    config.signerWorkflow ===
      `github.com/${config.repository}/${config.workflowPath}`,
    "release CI signer workflow drift",
  );
  assert(
    config.predicateType ===
      "https://github.com/ZhenXunGe/cpredict/attestations/release-gates/v2",
    "release CI predicate type drift",
  );
  assert(
    config.subjectName === "manifests/release-gates.json",
    "release CI subject name drift",
  );
  exactObject(
    config.attestAction,
    ["repository", "version", "commit"],
    "release CI attest action",
  );
  assert(
    config.attestAction.repository === "actions/attest",
    "release CI attest action repository drift",
  );
  assert(
    config.attestAction.version === "v4.2.1",
    "release CI attest action version drift",
  );
  assert(
    config.attestAction.commit === "508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    "release CI attest action commit drift",
  );
}

export function readConfig(root) {
  const bytes = readFileSync(join(root, RELEASE_CI_ATTESTATION_CONFIG_PATH));
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${RELEASE_CI_ATTESTATION_CONFIG_PATH} is invalid JSON: ${error.message}`,
    );
  }
  validateAttestationConfig(config);
  return config;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireCommit(value, label) {
  assert(
    typeof value === "string" && /^[0-9a-f]{40}$/.test(value),
    `${label} must be a full lowercase SHA-1 commit`,
  );
  return value;
}

function requirePositiveInteger(value, label) {
  assert(
    typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    `${label} must be a positive integer`,
  );
  const parsed = Number(value);
  assert(
    Number.isSafeInteger(parsed),
    `${label} exceeds the safe integer range`,
  );
  return parsed;
}

function exactObject(value, keys, label) {
  assertObject(value, label);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unknown or missing keys`,
  );
}

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
