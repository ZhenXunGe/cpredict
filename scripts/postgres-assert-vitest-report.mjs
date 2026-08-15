import { readFile } from "node:fs/promises";

const [reportPath, label] = process.argv.slice(2);
if (reportPath === undefined || label === undefined) {
  throw new Error(
    "usage: postgres-assert-vitest-report.mjs <report.json> <label>",
  );
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const total = requiredCount(report, "numTotalTests");
const passed = requiredCount(report, "numPassedTests");
const failed = requiredCount(report, "numFailedTests");
const skipped = requiredCount(report, "numPendingTests");
const todo = requiredCount(report, "numTodoTests");

if (
  report.success !== true ||
  total === 0 ||
  failed !== 0 ||
  skipped !== 0 ||
  todo !== 0 ||
  passed !== total
) {
  throw new Error(
    `${label} is not a clean real-database pass: total=${total} passed=${passed} ` +
      `failed=${failed} skipped=${skipped} todo=${todo}`,
  );
}

console.log(
  `POSTGRES_TEST_RESULT=${label} total=${total} passed=${passed} failed=${failed} skipped=${skipped} todo=${todo}`,
);

function requiredCount(report, key) {
  const value = report[key];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Vitest JSON report has invalid ${key}`);
  }
  return value;
}
