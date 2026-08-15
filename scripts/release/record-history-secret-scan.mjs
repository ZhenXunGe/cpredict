import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_GATE_POLICY,
  RELEASE_GATE_RUNNER_ID,
} from "./release-gates-common.mjs";

export function recordHistorySecretScan({
  root = process.cwd(),
  evidenceRoot,
  environment = process.env,
}) {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
  ) {
    throw new Error(
      "history result recording is restricted to the release-audit GitHub workflow",
    );
  }
  if (
    environment.GITHUB_WORKFLOW_REF !==
    "ZhenXunGe/cpredict/.github/workflows/release-audit.yml@refs/heads/main"
  ) {
    throw new Error("history result workflow identity mismatch");
  }
  if (environment.CPREDICT_HISTORY_SCAN_OUTCOME !== "success") {
    throw new Error("pinned full-history TruffleHog action did not succeed");
  }
  const checkout = resolve(root);
  const outputRoot = resolve(evidenceRoot);
  const child = relative(checkout, outputRoot);
  if (
    child === "" ||
    (!child.startsWith("..") && !child.includes(`${sep}..${sep}`))
  ) {
    throw new Error(
      "release evidence root must be outside the source checkout",
    );
  }
  const policy = REQUIRED_GATE_POLICY.find(
    (item) => item.id === "history-secret-scan",
  );
  const sourceManifestSha256 = sha256(
    readFileSync(join(checkout, "manifests/source-manifest.json")),
  );
  const rawPath = "reports/release/raw/history-secret-scan.json";
  const raw = {
    schemaVersion: 1,
    scanner: "trufflehog",
    version: "3.96.0",
    actionCommit: "6f3c981e7b77f235fd2702dd74af25fc4b72bf11",
    executionProfile: "FULL_GIT_HISTORY",
    results: ["verified", "unknown"],
    updatePolicy: "disabled",
    result: "PASS",
    exitCode: 0,
    sourceManifestSha256,
  };
  writeJsonExclusive(outputRoot, rawPath, raw);
  const result = {
    schemaVersion: 1,
    gateId: policy.id,
    runnerId: RELEASE_GATE_RUNNER_ID,
    command: policy.command,
    executionProfile: "FULL",
    result: "PASS",
    exitCode: 0,
    sourceManifestSha256,
    rawEvidence: [
      {
        role: "scan-result",
        path: rawPath,
        sha256: sha256(readFileSync(join(outputRoot, rawPath))),
      },
    ],
  };
  writeJsonExclusive(outputRoot, policy.resultPath, result);
  return result;
}

function writeJsonExclusive(root, path, value) {
  const output = join(root, path);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(output, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    let evidenceRoot;
    for (let index = 2; index < process.argv.length; index += 2) {
      if (process.argv[index] !== "--evidence-root")
        throw new Error(`unknown argument ${process.argv[index]}`);
      evidenceRoot = process.argv[index + 1];
    }
    if (evidenceRoot === undefined)
      throw new Error("--evidence-root is required");
    recordHistorySecretScan({ evidenceRoot });
    process.stdout.write("release gate history-secret-scan: PASS\n");
  } catch (error) {
    process.stderr.write(
      `history secret scan evidence failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
