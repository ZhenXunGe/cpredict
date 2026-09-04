import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const POSTGRES_INTEGRATION_INVENTORY = Object.freeze([
  Object.freeze({
    path: "offchain/indexer/test/postgres.integration.test.ts",
    tests: 4,
  }),
  Object.freeze({
    path: "offchain/paymaster-service/test/postgres-budget.integration.test.ts",
    tests: 2,
  }),
  Object.freeze({
    path: "offchain/permit2-relay-service/test/postgres-intent-store.integration.test.ts",
    tests: 3,
  }),
  Object.freeze({
    path: "offchain/metadata-service/test/postgres.integration.test.ts",
    tests: 2,
  }),
  Object.freeze({
    path: "offchain/workers/test/postgres-state.integration.test.ts",
    tests: 2,
  }),
]);
export const POSTGRES_INTEGRATION_FILES = Object.freeze(
  POSTGRES_INTEGRATION_INVENTORY.map((entry) => entry.path),
);
const EXPECTED_TESTS = POSTGRES_INTEGRATION_INVENTORY.reduce(
  (total, entry) => total + entry.tests,
  0,
);

export function validatePostgresIntegrationResult(
  report,
  root = process.cwd(),
) {
  assertObject(report, "Vitest JSON report");
  assert(
    report.success === true,
    "PostgreSQL integration Vitest report is not successful",
  );
  assert(
    report.numTotalTests === EXPECTED_TESTS,
    `PostgreSQL integration must discover exactly ${EXPECTED_TESTS} tests`,
  );
  assert(
    report.numPassedTests === EXPECTED_TESTS,
    `PostgreSQL integration must pass exactly ${EXPECTED_TESTS} tests`,
  );
  assert(
    report.numFailedTests === 0,
    "PostgreSQL integration reports failed tests",
  );
  assert(
    report.numPendingTests === 0,
    "PostgreSQL integration reports skipped/pending tests",
  );
  assert(
    report.numTodoTests === 0,
    "PostgreSQL integration reports todo tests",
  );
  assert(
    Array.isArray(report.testResults),
    "PostgreSQL integration testResults must be an array",
  );
  assert(
    report.testResults.length === POSTGRES_INTEGRATION_FILES.length,
    `PostgreSQL integration must execute exactly ${POSTGRES_INTEGRATION_FILES.length} test files`,
  );

  const expected = POSTGRES_INTEGRATION_FILES.map((path) =>
    resolve(root, path),
  ).sort();
  const actual = report.testResults
    .map((result) => resolve(result.name))
    .sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    "PostgreSQL integration file inventory changed",
  );
  for (const result of report.testResults) {
    assert(
      result.status === "passed",
      `PostgreSQL integration file did not pass: ${result.name}`,
    );
    assert(
      Array.isArray(result.assertionResults),
      `missing assertionResults for ${result.name}`,
    );
    const inventory = POSTGRES_INTEGRATION_INVENTORY.find(
      (entry) => resolve(root, entry.path) === resolve(result.name),
    );
    assert(
      inventory !== undefined,
      `unexpected PostgreSQL integration file: ${result.name}`,
    );
    assert(
      result.assertionResults.length === inventory.tests,
      `unexpected test count in ${result.name}`,
    );
    assert(
      result.assertionResults.every(
        (assertion) => assertion.status === "passed",
      ),
      `PostgreSQL integration assertion was not executed successfully: ${result.name}`,
    );
  }
  return {
    files: POSTGRES_INTEGRATION_FILES.length,
    tests: EXPECTED_TESTS,
    passed: EXPECTED_TESTS,
    skipped: 0,
  };
}

export function runPostgresIntegration(
  root = process.cwd(),
  environment = process.env,
) {
  const databaseUrl = environment.TEST_DATABASE_URL;
  if (
    typeof databaseUrl !== "string" ||
    !/^postgres(?:ql)?:\/\//.test(databaseUrl)
  ) {
    throw new Error(
      "TEST_DATABASE_URL is required for PostgreSQL integration; refusing a skipped run",
    );
  }
  const vitest = resolve(root, "node_modules/.bin/vitest");
  const result = spawnSync(
    vitest,
    ["run", ...POSTGRES_INTEGRATION_FILES, "--reporter=json", "--maxWorkers=1"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error !== undefined)
    throw new Error(`cannot execute local Vitest: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `PostgreSQL integration Vitest exited ${result.status}: ${redact(result.stderr || result.stdout)}`,
    );
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `PostgreSQL integration emitted invalid JSON: ${error.message}`,
    );
  }
  return validatePostgresIntegrationResult(report, root);
}

function redact(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "<redacted-postgres-url>")
    .slice(0, 4_000);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = runPostgresIntegration();
    console.log(
      `PostgreSQL integration gate passed: ${result.files} files, ${result.tests} tests, ` +
        `${result.passed} passed, ${result.skipped} skipped`,
    );
  } catch (error) {
    console.error(
      `PostgreSQL integration gate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
