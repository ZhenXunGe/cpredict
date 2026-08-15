import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseMutationSummary,
  renderMutationSummary,
} from "./parse-mutation-summary.mjs";

const line = (mutantClass, caught, compiled) =>
  `INFO:Slither-Mutate:${mutantClass} mutants: ${caught} caught of ${compiled} (99.0% caught)`;

test("parses one complete contract and renders the exact score", () => {
  const result = parseMutationSummary(
    [
      line("Revert", 16, 16),
      line("Comment", 29, 29),
      line("Tweak", 88, 90),
    ].join("\n"),
  );
  assert.equal(result.compiled, 135);
  assert.equal(result.caught, 133);
  assert.equal(result.passed, true);
  assert.equal(
    renderMutationSummary(result, "bounded mutation gate"),
    "compiled mutants: 135\ncaught mutants: 133\nmutation score: 98.52%\nbounded mutation gate: PASS (>=90%)",
  );
});

test("supports the full runner exact per-contract inventory", () => {
  const log = [
    line("Revert", 2, 2),
    line("Comment", 3, 3),
    line("Tweak", 4, 4),
    line("Revert", 1, 1),
    line("Comment", 1, 1),
    line("Tweak", 1, 1),
  ].join("\n");
  const result = parseMutationSummary(log, { expectedContracts: 2 });
  assert.deepEqual(
    [result.caught, result.compiled, result.passed],
    [12, 12, true],
  );
});

test("binds each summary triplet to the exact ordered contract inventory", () => {
  const log = [
    "INFO:Slither-Mutate:Done mutating Alpha.",
    line("Revert", 2, 2),
    line("Comment", 3, 3),
    line("Tweak", 4, 4),
    "INFO:Slither-Mutate:Done mutating Beta.",
    line("Revert", 1, 1),
    line("Comment", 1, 1),
    line("Tweak", 1, 1),
  ].join("\n");
  const result = parseMutationSummary(log, {
    expectedContractNames: ["Alpha", "Beta"],
  });
  assert.deepEqual(result.completedContracts, ["Alpha", "Beta"]);
  assert.throws(
    () =>
      parseMutationSummary(log, { expectedContractNames: ["Beta", "Alpha"] }),
    /completed contract inventory Alpha,Beta; expected Beta,Alpha/,
  );
});

test("rejects a summary triplet that is not scoped by a completion marker", () => {
  assert.throws(
    () =>
      parseMutationSummary(
        [line("Revert", 1, 1), line("Comment", 1, 1), line("Tweak", 1, 1)].join(
          "\n",
        ),
        { expectedContractNames: ["FeeVaultV1"] },
      ),
    /summary appears before a completion marker/,
  );
});

test("full runner pins the exact unique production contract inventory", () => {
  const runner = readFileSync(
    new URL("./run-mutation-full.sh", import.meta.url),
    "utf8",
  );
  const block = runner.match(/expected_contracts=\(\n([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, "expected_contracts array is missing");
  const contracts = block.trim().split(/\s+/);
  assert.deepEqual(contracts, [
    "BondEscrowV1",
    "CloneMarketVaultV1",
    "EmergencyControllerV1",
    "FeeVaultV1",
    "FixedPriceMarketplaceV1",
    "FullMarketDeployerV1",
    "FullMarketVaultV1",
    "LaunchExposureGuardV1",
    "MarketFactoryV1",
    "MarketVaultCoreV1",
    "ProtocolConfigV1",
    "SponsorshipPaymasterV1",
  ]);
  assert.equal(new Set(contracts).size, contracts.length);
  const sourcesBlock = runner.match(/expected_sources=\(\n([\s\S]*?)\n\)/)?.[1];
  assert.ok(sourcesBlock, "expected_sources array is missing");
  const sources = sourcesBlock.trim().split(/\s+/);
  assert.equal(sources.length, contracts.length);
  assert.equal(new Set(sources).size, sources.length);
  assert.doesNotMatch(runner, /"\$mutator" src \\/);
});

test("bounded runner targets the exact FeeVault source and stages evidence", () => {
  const runner = readFileSync(
    new URL("./run-mutation-feevault.sh", import.meta.url),
    "utf8",
  );
  assert.match(runner, /"\$mutator" src\/core\/FeeVaultV1\.sol \\/);
  assert.doesNotMatch(runner, /"\$mutator" \. \\/);
  assert.match(runner, /\.mutation-feevault-evidence\.XXXXXX/);
  assert.match(runner, /--expected-contract FeeVaultV1/);
});

test("synthetic lifecycle fixture cleans process groups and publishes atomically", () => {
  const fixture = new URL("./run-mutation-lifecycle.test.sh", import.meta.url);
  const result = spawnSync("bash", [fixture.pathname], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /mutation lifecycle fixture: PASS/);
});

test("full runner remains explicitly opt-in and cannot silently lower the campaign", () => {
  const runner = readFileSync(
    new URL("./run-mutation-full.sh", import.meta.url),
    "utf8",
  );
  assert.match(runner, /CPREDICT_MUTATION_CONFIRM/);
  assert.match(runner, /--expected-contracts 12/);
  assert.match(runner, /--threshold-percent 90/);
  assert.match(runner, /completed_contracts" -eq 12/);
  assert.match(runner, /\.mutation-full-evidence\.XXXXXX/);
});

test("fails closed when a class is missing", () => {
  assert.throws(
    () =>
      parseMutationSummary(
        [line("Revert", 1, 1), line("Comment", 1, 1)].join("\n"),
      ),
    /Tweak summary count 0; expected 1/,
  );
});

test("fails closed on a duplicate class", () => {
  assert.throws(
    () =>
      parseMutationSummary(
        [
          line("Revert", 1, 1),
          line("Revert", 1, 1),
          line("Comment", 1, 1),
          line("Tweak", 1, 1),
        ].join("\n"),
      ),
    /Revert summary count 2; expected 1/,
  );
});

test("returns a failing score below the threshold", () => {
  const result = parseMutationSummary(
    [line("Revert", 8, 10), line("Comment", 9, 10), line("Tweak", 9, 10)].join(
      "\n",
    ),
  );
  assert.equal(result.scorePercent.toFixed(2), "86.67");
  assert.equal(result.passed, false);
  assert.match(
    renderMutationSummary(result, "bounded mutation gate"),
    /FAIL \(>=90%\)$/,
  );
});

test("fails closed on malformed and impossible accounting", () => {
  assert.throws(
    () =>
      parseMutationSummary(
        [
          "INFO:Slither-Mutate:Revert mutants: bad caught of 1",
          line("Comment", 1, 1),
          line("Tweak", 1, 1),
        ].join("\n"),
      ),
    /malformed Revert summary/,
  );
  assert.throws(
    () =>
      parseMutationSummary(
        [line("Revert", 2, 1), line("Comment", 1, 1), line("Tweak", 1, 1)].join(
          "\n",
        ),
      ),
    /invalid Revert caught\/compiled accounting/,
  );
});
