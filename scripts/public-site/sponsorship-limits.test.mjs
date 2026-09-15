import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleSponsorshipLimits } from "./sponsorship-limits.mjs";
test("scales both lanes, weekly reserves and identity quotas while preserving the gas ceiling", () => {
  const lane = {
    projectWei: "80000000000000000",
    accountWei: "40000000000000000",
    subjectWei: "60000000000000000",
    projectOperations: 200,
    accountOperations: 30,
    subjectOperations: 50,
  };
  const before = {
    exposure: lane,
    exit: { ...lane },
    weekly: {
      window: "shanghai-monday",
      projectWei: "100000000000000000",
      exitReserveWei: "20000000000000000",
    },
    maxCostPerOperation: "5000000000000000",
    methodDailyOperations: 20,
    providerHardLimitWei: "100000000000000000",
    providerHardLimitUsd: "12.05",
    providerHardLimitPeriodSeconds: 604800,
    policyOperator: "and",
    passOnError: false,
    validitySeconds: 120,
  };
  const after = scaleSponsorshipLimits(before, 20);
  for (const name of ["exposure", "exit"]) {
    for (const k of ["projectWei", "accountWei", "subjectWei"])
      assert.equal(BigInt(after[name][k]), BigInt(before[name][k]) * 20n);
    for (const k of [
      "projectOperations",
      "accountOperations",
      "subjectOperations",
    ])
      assert.equal(after[name][k], before[name][k] * 20);
  }
  assert.equal(after.weekly.projectWei, "2000000000000000000");
  assert.equal(after.weekly.exitReserveWei, "400000000000000000");
  assert.equal(after.maxCostPerOperation, before.maxCostPerOperation);
  for (const limit of ["projectWei", "exitReserveWei"])
    assert.equal(
      BigInt(after.weekly[limit]) / BigInt(after.maxCostPerOperation),
      (BigInt(before.weekly[limit]) / BigInt(before.maxCostPerOperation)) * 20n,
    );
  assert.equal(after.methodDailyOperations, 400);
  assert.equal(after.providerHardLimitUsd, "241.00");
  assert.equal(after.providerHardLimitWei, "2000000000000000000");
  assert.equal(
    after.providerHardLimitPeriodSeconds,
    before.providerHardLimitPeriodSeconds,
  );
  assert.equal(after.passOnError, false);
  assert.equal(after.policyOperator, "and");
  assert.equal(after.validitySeconds, 120);
  assert.equal(before.methodDailyOperations, 20);
});
