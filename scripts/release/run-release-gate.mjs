import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  copyFileSync,
  lstatSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_GATE_POLICY,
  RELEASE_GATE_RUNNER_ID,
} from "./release-gates-common.mjs";

const GENERIC_GATES = new Set([
  "solidity-viair",
  "solidity-nonir",
  "offchain",
  "secret-scan",
  "release-tools",
]);

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--gate") options.gate = value;
    else if (flag === "--evidence-root") options.evidenceRoot = value;
    else if (flag === "--requirements-source")
      options.requirementsSource = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (options.gate === undefined) throw new Error("--gate is required");
  if (options.evidenceRoot === undefined)
    throw new Error("--evidence-root is required");
  return options;
}

export function runReleaseGate({
  root = process.cwd(),
  gate,
  evidenceRoot,
  requirementsSource,
  environment = process.env,
}) {
  const checkout = realpathSync(root);
  const outputRoot = resolve(evidenceRoot);
  const policy = REQUIRED_GATE_POLICY.find((item) => item.id === gate);
  if (policy === undefined) throw new Error(`unknown release gate ${gate}`);
  if (gate === "history-secret-scan") {
    throw new Error(
      "history-secret-scan is owned by the pinned GitHub action recorder",
    );
  }
  if (gate === "commercial-load") {
    throw new Error(
      "commercial-load is owned by the protected distributed evidence recorder",
    );
  }
  assertOutsideCheckout(checkout, outputRoot);
  const sourceManifestBytes = readFileSync(
    join(checkout, "manifests/source-manifest.json"),
  );
  const sourceManifestSha256 = sha256(sourceManifestBytes);
  mkdirSync(join(outputRoot, "reports/release/logs"), {
    recursive: true,
    mode: 0o700,
  });
  const logPath = `reports/release/logs/${gate}.log`;
  const absoluteLog = join(outputRoot, logPath);
  const logFd = openSync(absoluteLog, "wx", 0o600);
  const commandEnvironment = {
    ...environment,
    CPREDICT_REQUIREMENTS_SOURCE: requirementsSource ?? "",
    CPREDICT_MUTATION_CONFIRM: "I_UNDERSTAND_MUTATION_RUNTIME",
    CPREDICT_LOAD_CONFIRM: "I_UNDERSTAND_RESOURCE_USAGE",
    CPREDICT_RELEASE_EVIDENCE_ROOT: outputRoot,
    CPREDICT_ECONOMICS_OUTPUT_JSON: join(
      outputRoot,
      "reports/release/raw/commercial-economics-result.json",
    ),
    CPREDICT_ECONOMICS_OUTPUT_MD: join(
      outputRoot,
      "reports/release/raw/commercial-economics-report.md",
    ),
    RUN_ID: `release-${environment.GITHUB_RUN_ID ?? "local"}-${environment.GITHUB_RUN_ATTEMPT ?? "1"}`,
  };
  let execution;
  try {
    execution = spawnSync(
      "/bin/bash",
      ["-euo", "pipefail", "-c", policy.command],
      {
        cwd: checkout,
        env: commandEnvironment,
        stdio: ["ignore", logFd, logFd],
        timeout: timeoutFor(gate),
        killSignal: "SIGTERM",
      },
    );
  } finally {
    closeSync(logFd);
  }
  if (execution.error !== undefined) throw execution.error;
  const exitCode = execution.status ?? 255;
  if (exitCode !== 0)
    throw new Error(
      `${gate} command failed with exit ${exitCode}; see ${absoluteLog}`,
    );

  const rawEvidence = collectRawEvidence({
    checkout,
    outputRoot,
    policy,
    logPath,
    sourceManifestSha256,
    commandEnvironment,
  });
  rawEvidence.sort((left, right) =>
    Buffer.compare(Buffer.from(left.role), Buffer.from(right.role)),
  );
  const result = {
    schemaVersion: 1,
    gateId: gate,
    runnerId: RELEASE_GATE_RUNNER_ID,
    command: policy.command,
    executionProfile: "FULL",
    result: "PASS",
    exitCode: 0,
    sourceManifestSha256,
    rawEvidence,
  };
  writeJsonExclusive(outputRoot, policy.resultPath, result);
  return result;
}

function collectRawEvidence({
  checkout,
  outputRoot,
  policy,
  logPath,
  sourceManifestSha256,
  commandEnvironment,
}) {
  if (policy.validator === "requirements") {
    return [
      copyEvidence(
        checkout,
        outputRoot,
        "traceability",
        "manifests/requirements-traceability.json",
      ),
    ];
  }
  if (policy.validator === "sbom") {
    return [
      copyEvidence(checkout, outputRoot, "licenses", "manifests/licenses.json"),
      copyEvidence(checkout, outputRoot, "sbom", "manifests/sbom.spdx.json"),
    ];
  }
  if (policy.validator === "generated") {
    return [
      copyEvidence(
        checkout,
        outputRoot,
        "bytecode",
        "generated/registries/bytecode.json",
      ),
    ];
  }
  if (GENERIC_GATES.has(policy.id)) {
    const path = `reports/release/raw/${policy.id}.json`;
    writeJsonExclusive(
      outputRoot,
      path,
      commandEvidence(policy, sourceManifestSha256, "CPREDICT_COMMAND_RESULT"),
    );
    return [{ role: "command-result", ...descriptor(outputRoot, path) }];
  }
  if (policy.validator === "coverage") {
    for (const path of coveragePaths(checkout))
      copyPath(checkout, outputRoot, path);
    return [
      {
        role: "checksums",
        ...descriptor(outputRoot, "reports/coverage/full.sha256"),
      },
      {
        role: "summary",
        ...descriptor(outputRoot, "reports/coverage/full.summary.txt"),
      },
    ];
  }
  if (policy.validator === "security") {
    const evidencePath =
      policy.evidenceGate === "solidity-smtchecker"
        ? "reports/security/smtchecker-evidence.json"
        : `reports/security/${policy.evidenceGate}-evidence.json`;
    const metadata = JSON.parse(
      readFileSync(join(checkout, evidencePath), "utf8"),
    );
    if (metadata.result !== "PASS" || metadata.validatorExitCode !== 0) {
      throw new Error(`${policy.id} produced non-PASS security metadata`);
    }
    copyPath(checkout, outputRoot, evidencePath);
    for (const item of [...metadata.inputs, ...metadata.evidence])
      copyPath(checkout, outputRoot, item.path);
    return [
      { role: "security-evidence", ...descriptor(outputRoot, evidencePath) },
    ];
  }
  if (policy.validator === "gas") {
    const logs = ["protocol", "permit2", "paymaster", "code-sizes"];
    for (const name of logs)
      copyPath(checkout, outputRoot, `reports/gas-gates/${name}.log`);
    const parsed = parseGasEvidence(outputRoot, policy, sourceManifestSha256);
    const path = "reports/release/raw/gas-size.json";
    writeJsonExclusive(outputRoot, path, parsed);
    return [{ role: "gas-result", ...descriptor(outputRoot, path) }];
  }
  if (policy.validator === "postgresql") {
    const text = readFileSync(join(outputRoot, logPath), "utf8");
    for (const marker of [
      "POSTGRES_VERSION=postgres (PostgreSQL) 17.10",
      "POSTGRES_GATE_TOTALS=14/14/0/0/0",
      "POSTGRES_STATUS_AFTER_STOP=3",
      "POSTGRES_READY_AFTER_STOP=2",
      "POSTGRES_DATA_DIRECTORY_REMOVED=true",
    ])
      if (!text.includes(marker))
        throw new Error(`PostgreSQL log missing ${marker}`);
    const path = "reports/release/raw/postgresql.json";
    writeJsonExclusive(outputRoot, path, {
      ...commandEvidence(
        policy,
        sourceManifestSha256,
        "CPREDICT_POSTGRESQL_GATE",
      ),
      postgresVersion: "17.10",
      totals: { total: 9, passed: 9, failed: 0, skipped: 0, todo: 0 },
      cleanup: { pgCtlStatus: 3, pgIsReady: 2, dataDirectoryRemoved: true },
    });
    return [{ role: "postgresql-result", ...descriptor(outputRoot, path) }];
  }
  if (policy.validator === "economics") {
    const inputSource = requiredExternalPath(
      commandEnvironment.CPREDICT_ECONOMICS_INPUT,
      "CPREDICT_ECONOMICS_INPUT",
    );
    const policySource = requiredExternalPath(
      commandEnvironment.CPREDICT_ECONOMICS_POLICY,
      "CPREDICT_ECONOMICS_POLICY",
    );
    const input = JSON.parse(readFileSync(inputSource, "utf8"));
    const assessmentPath =
      "reports/release/raw/commercial-economics-result.json";
    const reportPath = "reports/release/raw/commercial-economics-report.md";
    const assessment = JSON.parse(
      readFileSync(join(outputRoot, assessmentPath), "utf8"),
    );
    if (
      assessment.overallStatus !== "PASS" ||
      !Array.isArray(assessment.gates) ||
      assessment.gates.length !== 7 ||
      assessment.gates.some((item) => item.status !== "PASS")
    ) {
      throw new Error(
        "commercial-economics did not produce seven PASS decisions",
      );
    }
    const now = Date.now();
    if (
      Date.parse(assessment.assessmentTime) > now ||
      now > Date.parse(assessment.validUntil)
    ) {
      throw new Error(
        "commercial-economics assessment is future-dated or expired",
      );
    }
    if (
      input.deploymentBinding?.sourceManifestSha256 !==
      `sha256:${sourceManifestSha256}`
    ) {
      throw new Error(
        "commercial-economics input is not bound to this source manifest",
      );
    }
    if (
      !/^[0-9a-f]{40}$/.test(commandEnvironment.GITHUB_SHA ?? "") ||
      input.deploymentBinding.auditCommit !== commandEnvironment.GITHUB_SHA
    ) {
      throw new Error(
        "commercial-economics input is not bound to the GitHub audit commit",
      );
    }
    const inputPath = "reports/release/raw/commercial-economics-input.json";
    const policyPath = "reports/release/raw/commercial-economics-policy.json";
    copyExternalEvidence(inputSource, outputRoot, inputPath);
    copyExternalEvidence(policySource, outputRoot, policyPath);
    return [
      { role: "assessment", ...descriptor(outputRoot, assessmentPath) },
      { role: "input", ...descriptor(outputRoot, inputPath) },
      { role: "policy", ...descriptor(outputRoot, policyPath) },
      { role: "report", ...descriptor(outputRoot, reportPath) },
    ];
  }
  if (policy.validator === "deployment") {
    const text = readFileSync(join(outputRoot, logPath), "utf8");
    for (const marker of [
      "# tests 18",
      "# pass 18",
      "# fail 0",
      "# skipped 0",
      "# todo 0",
    ]) {
      if (!text.includes(marker))
        throw new Error(`deployment tooling log missing ${marker}`);
    }
    const path = "reports/release/raw/deployment-tooling.json";
    writeJsonExclusive(outputRoot, path, {
      ...commandEvidence(
        policy,
        sourceManifestSha256,
        "CPREDICT_DEPLOYMENT_TOOLING_GATE",
      ),
      totals: { total: 18, passed: 18, failed: 0, skipped: 0, todo: 0 },
    });
    return [{ role: "deployment-result", ...descriptor(outputRoot, path) }];
  }
  throw new Error(
    `release evidence collector has no implementation for ${policy.id}`,
  );
}

function parseGasEvidence(outputRoot, policy, sourceManifestSha256) {
  const suites = ["protocol", "permit2", "paymaster"];
  const tests = [];
  for (const suite of suites) {
    const text = readFileSync(
      join(outputRoot, `reports/gas-gates/${suite}.log`),
      "utf8",
    );
    for (const match of text.matchAll(
      /^\[PASS\] (testGasGate[A-Za-z0-9_]+)\(\) \(gas: ([0-9]+)\)$/gm,
    )) {
      tests.push({ name: match[1], outerTestGas: Number(match[2]) });
    }
  }
  tests.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  if (
    tests.length !== 10 ||
    new Set(tests.map((item) => item.name)).size !== 10
  ) {
    throw new Error(
      `gas gate expected 10 unique PASS tests, observed ${tests.length}`,
    );
  }
  const sizeText = readFileSync(
    join(outputRoot, "reports/gas-gates/code-sizes.log"),
    "utf8",
  );
  const sizes = [];
  for (const name of [
    "FullMarketVaultV1",
    "CloneMarketVaultV1",
    "MarketFactoryV1",
    "FullMarketDeployerV1",
    "SponsorshipPaymasterV1",
  ]) {
    const match = sizeText.match(
      new RegExp(`\\| ${name}\\s+\\| ([0-9,]+)\\s+\\| ([0-9,]+)\\s+\\|`),
    );
    if (match === null) throw new Error(`code-size log missing ${name}`);
    sizes.push({
      contract: name,
      runtimeBytes: Number(match[1].replaceAll(",", "")),
      initcodeBytes: Number(match[2].replaceAll(",", "")),
    });
  }
  return {
    ...commandEvidence(policy, sourceManifestSha256, "CPREDICT_GAS_GATE"),
    tests,
    sizes,
  };
}

function coveragePaths(checkout) {
  const checksumPath = join(checkout, "reports/coverage/full.sha256");
  const rows = readFileSync(checksumPath, "utf8").trim().split("\n");
  const paths = new Set([
    "reports/coverage/full.sha256",
    "reports/coverage/full.summary.txt",
  ]);
  for (const row of rows) {
    const match = row.match(
      /^[0-9a-f]{64}  (reports\/coverage\/[A-Za-z0-9._-]+)$/,
    );
    if (match === null)
      throw new Error(`invalid coverage checksum row: ${row}`);
    paths.add(match[1]);
  }
  return [...paths];
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

function copyEvidence(checkout, outputRoot, role, path) {
  copyPath(checkout, outputRoot, path);
  return { role, ...descriptor(outputRoot, path) };
}

function copyPath(checkout, outputRoot, path) {
  const source = resolve(checkout, path);
  const relativePath = relative(checkout, source);
  if (relativePath.startsWith("..") || relativePath.includes(`${sep}..${sep}`))
    throw new Error(`evidence path escapes checkout: ${path}`);
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`evidence must be a regular non-symlink file: ${path}`);
  const destination = resolve(outputRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, 0);
}

function requiredExternalPath(value, name) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is required`);
  const path = resolve(value);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${name} must be a regular non-symlink file`);
  return path;
}

function copyExternalEvidence(source, outputRoot, path) {
  const destination = resolve(outputRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, 0);
}

function writeJsonExclusive(outputRoot, path, value) {
  const destination = resolve(outputRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const fd = openSync(destination, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function descriptor(outputRoot, path) {
  return { path, sha256: sha256(readFileSync(join(outputRoot, path))) };
}

function timeoutFor(gate) {
  if (gate === "mutation") return 21_600_000;
  if (gate === "commercial-economics") return 120_000;
  if (["echidna", "medusa"].includes(gate)) return 2_400_000;
  return 1_200_000;
}

function assertOutsideCheckout(checkout, outputRoot) {
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const actualOutputRoot = realpathSync(outputRoot);
  const relativePath = relative(checkout, actualOutputRoot);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`${sep}..${sep}`))
  ) {
    throw new Error(
      "release evidence root must be outside the source checkout",
    );
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
    const result = runReleaseGate(parseArguments(process.argv.slice(2)));
    process.stdout.write(`release gate ${result.gateId}: PASS\n`);
  } catch (error) {
    process.stderr.write(
      `release gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
