import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  POSTGRES_INTEGRATION_INVENTORY,
  PUBLIC_SITE_POSTGRES_INVENTORY,
  runPostgresIntegration,
  validatePostgresIntegrationResult,
} from "./run-postgres-integration.mjs";

test("accepts the complete PostgreSQL integration inventory with zero skips", () => {
  assert.deepEqual(validatePostgresIntegrationResult(validReport(), "/repo"), {
    files: 5,
    tests: 13,
    passed: 13,
    skipped: 0,
  });
});

test("rejects a skipped PostgreSQL integration suite even when Vitest success is true", () => {
  const report = validReport();
  report.numPassedTests = 12;
  report.numPendingTests = 1;
  report.testResults[1].assertionResults[0].status = "skipped";
  assert.throws(
    () => validatePostgresIntegrationResult(report, "/repo"),
    /pass exactly 13 tests/,
  );
});

test("rejects missing, failed or unexpected PostgreSQL integration files", () => {
  const missing = validReport();
  missing.testResults.pop();
  assert.throws(
    () => validatePostgresIntegrationResult(missing, "/repo"),
    /exactly 5 test files/,
  );

  const failed = validReport();
  failed.numPassedTests = 12;
  failed.numFailedTests = 1;
  assert.throws(
    () => validatePostgresIntegrationResult(failed, "/repo"),
    /pass exactly 13 tests/,
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

test("public-site CI inventory includes every application and financial test and rejects a skipped assertion", () => {
  const inventory = PUBLIC_SITE_POSTGRES_INVENTORY;
  const report = validReport(inventory);
  assert.deepEqual(
    validatePostgresIntegrationResult(report, "/repo", inventory),
    { files: 8, tests: 31, passed: 31, skipped: 0 },
  );
  report.testResults[7].assertionResults[0].status = "skipped";
  assert.throws(
    () => validatePostgresIntegrationResult(report, "/repo", inventory),
    /not executed successfully/,
  );
});

function validReport(inventory = POSTGRES_INTEGRATION_INVENTORY) {
  const count = inventory.reduce((total, entry) => total + entry.tests, 0);
  return {
    success: true,
    numTotalTests: count,
    numPassedTests: count,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: inventory.map((entry) => ({
      name: resolve("/repo", entry.path),
      status: "passed",
      assertionResults: Array.from({ length: entry.tests }, () => ({
        status: "passed",
      })),
    })),
  };
}
