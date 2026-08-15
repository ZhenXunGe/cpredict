import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkReleaseGates } from "./release-gates-common.mjs";
import {
  readConfig,
  validateGitHubVerificationOutput,
} from "./ci-attestation-common.mjs";

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (
      ![
        "--verification-json",
        "--commit",
        "--evidence-root",
        "--run-id",
      ].includes(flag)
    )
      throw new Error(`unknown argument ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value for ${flag}`);
    if (flag === "--verification-json") options.verificationJson = value;
    if (flag === "--commit") options.commitSha = value;
    if (flag === "--evidence-root") options.evidenceRoot = value;
    if (flag === "--run-id") options.runId = Number(value);
    index += 1;
  }
  if (options.verificationJson === undefined)
    throw new Error("--verification-json is required");
  if (options.commitSha === undefined) throw new Error("--commit is required");
  if (options.evidenceRoot === undefined)
    throw new Error("--evidence-root is required");
  if (!Number.isSafeInteger(options.runId) || options.runId <= 0)
    throw new Error("--run-id must be a positive integer");
  return options;
}

export async function verifyFromFiles({
  root = process.cwd(),
  evidenceRoot,
  verificationJson,
  commitSha,
  runId,
}) {
  const [verificationBytes, releaseGatesBytes, sourceManifestBytes] =
    await Promise.all([
      readFile(resolve(verificationJson)),
      readFile(resolve(evidenceRoot, "manifests/release-gates.json")),
      readFile(resolve(root, "manifests/source-manifest.json")),
    ]);
  let output;
  try {
    output = JSON.parse(verificationBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `GitHub verification output is invalid JSON: ${error.message}`,
    );
  }
  const gates = await checkReleaseGates(root, evidenceRoot);
  return validateGitHubVerificationOutput(output, {
    config: readConfig(root),
    gates,
    sourceManifestBytes,
    releaseGatesBytes,
    commitSha,
    runId,
  });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const predicate = await verifyFromFiles(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      `GitHub release CI attestation valid: commit ${predicate.commitSha}; ${predicate.gates.length} gates; run ${predicate.workflow.runId}/${predicate.workflow.runAttempt}`,
    );
  } catch (error) {
    console.error(
      `GitHub release CI attestation rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
