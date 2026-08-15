import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArguments as parseBuildArguments } from "./build-ci-attestation-predicate.mjs";
import {
  buildReleaseCiPredicate,
  readConfig,
  validateGitHubVerificationOutput,
  validateReleaseCiPredicate,
} from "./ci-attestation-common.mjs";
import { parseArguments as parseVerifyArguments } from "./verify-ci-attestation.mjs";
import { validReleaseGateFixture } from "./release-gates-fixture.mjs";

const COMMIT = "1".repeat(40);
const sourceManifestBytes = Buffer.from('{"schemaVersion":1}\n');
const config = readConfig(process.cwd());

function fixture() {
  const release = validReleaseGateFixture(sourceManifestBytes);
  const predicate = buildReleaseCiPredicate({
    config,
    gates: release.document,
    sourceManifestBytes,
    environment: validEnvironment(),
  });
  const releaseGatesBytes = Buffer.from(
    `${JSON.stringify(release.document)}\n`,
  );
  return { release, predicate, releaseGatesBytes };
}

function validEnvironment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: config.workflowRef,
    GITHUB_EVENT_NAME: config.workflowEvent,
    GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflowPath}@${config.workflowRef}`,
    GITHUB_WORKFLOW_SHA: COMMIT,
    GITHUB_SHA: COMMIT,
    GITHUB_RUN_ID: "1234567",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: config.signerJob,
    RUNNER_ENVIRONMENT: "github-hosted",
  };
}

function verificationOutput(value = fixture()) {
  const run = value.predicate.workflow;
  const repositoryUri = `https://github.com/${config.repository}`;
  return [
    {
      attestation: { bundle: "cryptographically-verified-by-gh-cli" },
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: config.certificateIdentity,
            issuer: config.oidcIssuer,
            runnerEnvironment: "github-hosted",
            sourceRepositoryURI: repositoryUri,
            sourceRepositoryDigest: COMMIT,
            sourceRepositoryRef: config.workflowRef,
            githubWorkflowRepository: config.repository,
            githubWorkflowRef: config.workflowRef,
            githubWorkflowSHA: COMMIT,
            githubWorkflowTrigger: config.workflowEvent,
            buildSignerURI: config.certificateIdentity,
            buildSignerDigest: COMMIT,
            runInvocationURI: `${repositoryUri}/actions/runs/${run.runId}/attempts/${run.runAttempt}`,
          },
        },
        verifiedTimestamps: [{ type: "timestamp-authority" }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          subject: [
            {
              name: config.subjectName,
              digest: { sha256: sha256(value.releaseGatesBytes) },
            },
          ],
          predicateType: config.predicateType,
          predicate: structuredClone(value.predicate),
        },
      },
    },
  ];
}

test("builds a strict same-SHA predicate binding all 22 gate result hashes", () => {
  const value = fixture();
  assert.equal(value.predicate.commitSha, COMMIT);
  assert.equal(value.predicate.workflow.sha, COMMIT);
  assert.equal(value.predicate.gates.length, 22);
  assert.doesNotThrow(() =>
    validateReleaseCiPredicate(value.predicate, {
      config,
      gates: value.release.document,
      sourceManifestBytes,
      commitSha: COMMIT,
    }),
  );
});

test("predicate builder rejects local, wrong-repository, wrong-workflow and self-hosted contexts", () => {
  const value = validReleaseGateFixture(sourceManifestBytes);
  for (const [field, replacement, pattern] of [
    ["GITHUB_ACTIONS", "false", /restricted to GitHub Actions/],
    ["GITHUB_REPOSITORY", "attacker/fork", /repository mismatch/],
    [
      "GITHUB_WORKFLOW_REF",
      `${config.repository}/.github/workflows/evil.yml@refs/heads/main`,
      /workflow identity mismatch/,
    ],
    ["GITHUB_WORKFLOW_SHA", "2".repeat(40), /workflow SHA/],
    ["GITHUB_JOB", "untrusted", /signer job mismatch/],
    ["RUNNER_ENVIRONMENT", "self-hosted", /GitHub-hosted runner/],
  ]) {
    const environment = { ...validEnvironment(), [field]: replacement };
    assert.throws(
      () =>
        buildReleaseCiPredicate({
          config,
          gates: value.document,
          sourceManifestBytes,
          environment,
        }),
      pattern,
    );
  }
});

test("accepts policy data only after gh cryptographic verification output is bound exactly", () => {
  const value = fixture();
  const output = verificationOutput(value);
  const predicate = validateGitHubVerificationOutput(output, expected(value));
  assert.equal(predicate.workflow.runId, 1234567);
});

test("rejects wrong SHA, workflow, repository, subject, issuer, runner and tampered predicate", () => {
  const mutations = [
    [
      (output) => {
        output[0].verificationResult.signature.certificate.sourceRepositoryDigest =
          "2".repeat(40);
      },
      /sourceRepositoryDigest mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.signature.certificate.githubWorkflowRef =
          "refs/heads/evil";
      },
      /githubWorkflowRef mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.signature.certificate.githubWorkflowRepository =
          "attacker/fork";
      },
      /githubWorkflowRepository mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.statement.subject[0].name =
          "arbitrary.json";
      },
      /subject name mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.statement.subject[0].digest.sha256 =
          "0".repeat(64);
      },
      /subject digest mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.signature.certificate.issuer =
          "https://issuer.invalid";
      },
      /issuer mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.signature.certificate.runnerEnvironment =
          "self-hosted";
      },
      /runnerEnvironment mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.statement.predicate.commitSha = "2".repeat(
          40,
        );
      },
      /predicate commit mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.statement.predicate.gates[0].sha256 =
          "0".repeat(64);
      },
      /gate result inventory mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.statement.predicate.workflow.path =
          ".github/workflows/evil.yml";
      },
      /workflow path mismatch/,
    ],
    [
      (output) => {
        output[0].verificationResult.verifiedTimestamps = [];
      },
      /no verified timestamp/,
    ],
  ];
  for (const [mutate, pattern] of mutations) {
    const value = fixture();
    const output = verificationOutput(value);
    mutate(output);
    assert.throws(
      () => validateGitHubVerificationOutput(output, expected(value)),
      pattern,
    );
  }
});

test("missing or duplicate verified attestations fail closed", () => {
  const value = fixture();
  assert.throws(
    () => validateGitHubVerificationOutput([], expected(value)),
    /exactly one/,
  );
  const one = verificationOutput(value)[0];
  assert.throws(
    () =>
      validateGitHubVerificationOutput(
        [one, structuredClone(one)],
        expected(value),
      ),
    /exactly one/,
  );
});

test("attestation CLI argument parsers reject unknown and incomplete inputs", () => {
  assert.deepEqual(
    parseBuildArguments([
      "--output",
      "/tmp/predicate.json",
      "--evidence-root",
      "/tmp/evidence",
    ]),
    {
      output: "/tmp/predicate.json",
      evidenceRoot: "/tmp/evidence",
    },
  );
  assert.throws(() => parseBuildArguments([]), /required/);
  assert.throws(() => parseBuildArguments(["--arbitrary", "x"]), /unknown/);
  assert.deepEqual(
    parseVerifyArguments([
      "--verification-json",
      "/tmp/verified.json",
      "--commit",
      COMMIT,
      "--evidence-root",
      "/tmp/evidence",
      "--run-id",
      "1234567",
    ]),
    {
      verificationJson: "/tmp/verified.json",
      commitSha: COMMIT,
      evidenceRoot: "/tmp/evidence",
      runId: 1234567,
    },
  );
  assert.throws(
    () => parseVerifyArguments(["--verification-json", "/tmp/verified.json"]),
    /--commit is required/,
  );
});

test("the pinned attest action configuration is an exact immutable v4.2.1 commit", async () => {
  const repositoryConfig = JSON.parse(
    await readFile("manifests/release-ci-attestation.config.json", "utf8"),
  );
  assert.deepEqual(repositoryConfig.attestAction, {
    repository: "actions/attest",
    version: "v4.2.1",
    commit: "508db95dd578ae2727ebd6217d5ba78e4fbda05d",
  });
});

function expected(value) {
  return {
    config,
    gates: value.release.document,
    sourceManifestBytes,
    releaseGatesBytes: value.releaseGatesBytes,
    commitSha: COMMIT,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
