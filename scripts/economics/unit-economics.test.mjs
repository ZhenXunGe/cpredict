import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  calculateScenario,
  ceilDiv,
  floorDiv,
  gasCostAtomic,
  maximumClaimsWithinBudget,
  minimumPrincipalForRake,
  stringifyBigInts,
} from "./unit-economics.mjs";
import { trialScenarios } from "./scenarios.mjs";

test("floorDiv and ceilDiv cover exact and remainder boundaries", () => {
  assert.equal(floorDiv(10n, 5n), 2n);
  assert.equal(ceilDiv(10n, 5n), 2n);
  assert.equal(floorDiv(10n, 6n), 1n);
  assert.equal(ceilDiv(10n, 6n), 2n);
  assert.equal(ceilDiv(0n, 7n), 0n);
});

test("gas conversion exposes both bounds without floating point", () => {
  const exact = gasCostAtomic(100_000n, 10_000_000n, 3_000n * 100_000_000n, 6);
  assert.equal(exact.floor, 3_000n);
  assert.equal(exact.ceil, 3_000n);
  const remainder = gasCostAtomic(1n, 1n, 1n, 6);
  assert.equal(remainder.floor, 0n);
  assert.equal(remainder.ceil, 1n);
});

test("trial scenarios conserve payer ceilings and produce break-even values", () => {
  for (const input of trialScenarios) {
    const result = calculateScenario(input);
    const payers = result.resolved.payerCostAtomicCeil;
    assert.equal(
      payers.sponsor + payers.operator + payers.users,
      result.resolved.totalCostAtomic.budgetedComponentCeil,
    );
    assert.ok(result.economics.minimumBreakEvenSettlementPoolAtomic > 0n);
    assert.ok(
      result.economics.minimumBreakEvenLifecyclePoolAtomic >=
        result.economics.minimumBreakEvenSettlementPoolAtomic,
    );
    assert.equal(
      (result.economics.minimumBreakEvenSettlementPoolAtomic * input.rakeBps) /
        10_000n >=
        result.resolved.totalCostAtomic.budgetedComponentCeil,
      true,
    );
    assert.equal(
      result.timeoutVoided.payerCostAtomicCeil.sponsor +
        result.timeoutVoided.payerCostAtomicCeil.operator +
        result.timeoutVoided.payerCostAtomicCeil.users,
      result.timeoutVoided.totalCostAtomic.budgetedComponentCeil,
    );
  }
});

test("Full 5k and Clone 500 trial outputs are locked", () => {
  const full = calculateScenario(trialScenarios[0]);
  assert.equal(full.resolved.totalCostAtomic.budgetedComponentCeil, 391_499n);
  assert.equal(full.economics.minimumBreakEvenSettlementPoolAtomic, 7_829_980n);
  assert.equal(
    full.resolved.sponsorBudget.maximumFullySubsidizedClaims,
    13_086n,
  );
  assert.equal(
    full.timeoutVoided.totalCostAtomic.budgetedComponentCeil,
    1_550_994n,
  );

  const clone = calculateScenario(trialScenarios[1]);
  assert.equal(clone.resolved.totalCostAtomic.budgetedComponentCeil, 87_000n);
  assert.equal(
    clone.economics.minimumBreakEvenSettlementPoolAtomic,
    1_740_000n,
  );
  assert.equal(
    clone.resolved.sponsorBudget.maximumFullySubsidizedClaims,
    3_270n,
  );
  assert.equal(
    clone.timeoutVoided.totalCostAtomic.budgetedComponentCeil,
    324_000n,
  );
});

test("partial sponsorship rounds claimant selection upward and assigns remainder to users", () => {
  const input = {
    ...trialScenarios[1],
    sponsorShareBps: 3_333n,
    counts: { ...trialScenarios[1].counts, winnerClaimants: 10n },
  };
  const result = calculateScenario(input);
  assert.equal(result.resolved.sponsoredClaims, 4n);
  assert.equal(result.resolved.userPaidClaims, 6n);
  assert.equal(
    result.resolved.payerCostAtomicCeil.sponsor +
      result.resolved.payerCostAtomicCeil.operator +
      result.resolved.payerCostAtomicCeil.users,
    result.resolved.totalCostAtomic.budgetedComponentCeil,
  );
});

test("maximum subsidized claims accounts for batch cost steps", () => {
  const unitCost = (gas) => ({ floor: gas, ceil: gas });
  const maximum = maximumClaimsWithinBudget({
    budgetAtomic: 35n,
    fixedCostAtomic: 5n,
    claimGas: 3n,
    paymasterBatchGas: 2n,
    aaBatchSize: 4n,
    unitCost,
  });
  assert.equal(maximum, 8n); // 5 + 8*3 + 2 batches*2 = 33; claim 9 costs 38.
});

test("zero sponsor budget cannot fund fixed finalization", () => {
  const result = calculateScenario({
    ...trialScenarios[0],
    sponsorBudgetAtomic: 0n,
  });
  assert.equal(result.resolved.sponsorBudget.maximumFullySubsidizedClaims, 0n);
  assert.equal(result.resolved.sponsorBudget.sufficient, false);
});

test("minimum principal implements exact upward break-even rounding", () => {
  assert.equal(minimumPrincipalForRake(1n, 500n), 20n);
  assert.equal(minimumPrincipalForRake(2n, 333n), 61n);
  assert.equal((61n * 333n) / 10_000n, 2n);
  assert.equal((60n * 333n) / 10_000n, 1n);
});

test("BigInt model handles uint256 boundary inputs without floating point overflow", () => {
  const max = (1n << 256n) - 1n;
  const converted = gasCostAtomic(max, max, max, 18);
  assert.ok(converted.ceil > max);
  assert.equal(converted.ceil >= converted.floor, true);
  assert.throws(() => gasCostAtomic(max + 1n, 1n, 1n, 6), /uint256/);
});

test("invalid ranges fail closed", () => {
  assert.throws(() => ceilDiv(1n, 0n), /positive/);
  assert.throws(
    () => calculateScenario({ ...trialScenarios[0], rakeBps: 0n }),
    /rakeBps/,
  );
  assert.throws(
    () => calculateScenario({ ...trialScenarios[0], sponsorShareBps: 10_001n }),
    /sponsorShareBps/,
  );
  assert.throws(
    () => calculateScenario({ ...trialScenarios[0], usdcDecimals: 19 }),
    /usdcDecimals/,
  );
});

test("generator is deterministic and emits string-encoded integers", async () => {
  const generator = new URL("./generate-report.mjs", import.meta.url);
  execFileSync(process.execPath, [generator.pathname], { stdio: "pipe" });
  const output = new URL(
    "../../reports/economics/micro-pool-unit-economics.json",
    import.meta.url,
  );
  const first = await readFile(output);
  execFileSync(process.execPath, [generator.pathname], { stdio: "pipe" });
  const second = await readFile(output);
  assert.equal(
    createHash("sha256").update(first).digest("hex"),
    createHash("sha256").update(second).digest("hex"),
  );
  const parsed = JSON.parse(second);
  assert.equal(typeof parsed.trials[0].rakeAtomic, "string");
  assert.deepEqual(stringifyBigInts({ value: 1n }), { value: "1" });
});
