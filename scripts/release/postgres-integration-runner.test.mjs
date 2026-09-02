import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  POSTGRES_INTEGRATION_INVENTORY,
  runPostgresIntegration,
  validatePostgresIntegrationResult,
} from "./run-postgres-integration.mjs";

test("accepts the complete PostgreSQL integration inventory with zero skips", () => {
  assert.deepEqual(validatePostgresIntegrationResult(validReport(), "/repo"), {
    files: 4,
    tests: 10,
    passed: 10,
    skipped: 0,
  });
});

test("rejects a skipped PostgreSQL integration suite even when Vitest success is true", () => {
  const report = validReport();
  report.numPassedTests = 9;
  report.numPendingTests = 1;
  report.testResults[1].assertionResults[0].status = "skipped";
  assert.throws(
    () => validatePostgresIntegrationResult(report, "/repo"),
    /pass exactly 10 tests/,
  );
});

test("rejects missing, failed or unexpected PostgreSQL integration files", () => {
  const missing = validReport();
  missing.testResults.pop();
  assert.throws(
    () => validatePostgresIntegrationResult(missing, "/repo"),
    /exactly 4 test files/,
  );

  const failed = validReport();
  failed.numPassedTests = 9;
  failed.numFailedTests = 1;
  assert.throws(
    () => validatePostgresIntegrationResult(failed, "/repo"),
    /pass exactly 10 tests/,
  );

  const unexpected = validReport();
  unexpected.testResults[1].name = "/repo/offchain/other.integration.test.ts";
  assert.throws(
    () => validatePostgresIntegrationResult(unexpected, "/repo"),
    /file inventory changed/,
  );
});

test("runner refuses to start without TEST_DATABASE_URL", () => {
  assert.throws(
    () => runPostgresIntegration("/repo", {}),
    /TEST_DATABASE_URL is required.*refusing a skipped run/,
  );
});

function validReport() {
  return {
    success: true,
    numTotalTests: 10,
    numPassedTests: 10,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: POSTGRES_INTEGRATION_INVENTORY.map((entry) => ({
      name: resolve("/repo", entry.path),
      status: "passed",
      assertionResults: Array.from({ length: entry.tests }, () => ({
        status: "passed",
      })),
    })),
  };
}
