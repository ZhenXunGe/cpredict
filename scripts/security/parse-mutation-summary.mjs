#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const MUTANT_CLASSES = ["Revert", "Comment", "Tweak"];
const STRICT_SUMMARY =
  /(?:^|:)(Revert|Comment|Tweak) mutants:\s+([0-9]+) caught of ([0-9]+)(?:\s+\([^\r\n]*\))?\s*$/;
const SUMMARY_MARKER = /(?:^|:)(Revert|Comment|Tweak) mutants:/;
const DONE_MARKER = /(?:^|:)Done mutating ([A-Za-z_][A-Za-z0-9_]*)\.\s*$/;

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function parseMutationSummary(log, options = {}) {
  const expectedContractNames = options.expectedContractNames;
  const expectedContracts =
    options.expectedContracts ?? expectedContractNames?.length ?? 1;
  const thresholdPercent = options.thresholdPercent ?? 90;
  requirePositiveSafeInteger(expectedContracts, "expectedContracts");
  requirePositiveSafeInteger(thresholdPercent, "thresholdPercent");
  if (thresholdPercent > 100)
    throw new Error("thresholdPercent must not exceed 100");
  if (typeof log !== "string" || log.length === 0)
    throw new Error("mutation log is empty");
  if (expectedContractNames !== undefined) {
    if (
      !Array.isArray(expectedContractNames) ||
      expectedContractNames.length !== expectedContracts
    ) {
      throw new Error(
        "expected contract-name inventory does not match expectedContracts",
      );
    }
    if (new Set(expectedContractNames).size !== expectedContractNames.length) {
      throw new Error("expected contract-name inventory contains duplicates");
    }
    for (const name of expectedContractNames) {
      if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`invalid expected contract name: ${String(name)}`);
      }
    }
  }

  const rows = [];
  const completedContracts = [];
  const contractRows = new Map();
  let activeContract;
  for (const line of log.split(/\r?\n/)) {
    const doneMatch = line.match(DONE_MARKER);
    if (doneMatch) {
      activeContract = doneMatch[1];
      if (contractRows.has(activeContract)) {
        throw new Error(`duplicate completion marker for ${activeContract}`);
      }
      completedContracts.push(activeContract);
      contractRows.set(activeContract, []);
      continue;
    }
    if (!SUMMARY_MARKER.test(line)) continue;
    const match = line.match(STRICT_SUMMARY);
    if (!match)
      throw new Error(
        `malformed ${line.match(SUMMARY_MARKER)?.[1] ?? "mutation"} summary`,
      );
    const caught = Number(match[2]);
    const compiled = Number(match[3]);
    if (!Number.isSafeInteger(caught) || !Number.isSafeInteger(compiled)) {
      throw new Error("mutation counts exceed safe integer range");
    }
    if (compiled < 0 || caught < 0 || caught > compiled) {
      throw new Error(`invalid ${match[1]} caught/compiled accounting`);
    }
    const row = { mutantClass: match[1], caught, compiled };
    rows.push(row);
    if (expectedContractNames !== undefined) {
      if (activeContract === undefined)
        throw new Error(
          `${match[1]} summary appears before a completion marker`,
        );
      const scopedRows = contractRows.get(activeContract);
      if (scopedRows.some((entry) => entry.mutantClass === match[1])) {
        throw new Error(`duplicate ${match[1]} summary for ${activeContract}`);
      }
      scopedRows.push(row);
    }
  }

  if (expectedContractNames !== undefined) {
    if (completedContracts.length !== expectedContracts) {
      throw new Error(
        `completed contract count ${completedContracts.length}; expected ${expectedContracts}`,
      );
    }
    if (
      JSON.stringify(completedContracts) !==
      JSON.stringify(expectedContractNames)
    ) {
      throw new Error(
        `completed contract inventory ${completedContracts.join(",")}; expected ${expectedContractNames.join(",")}`,
      );
    }
    for (const contractName of expectedContractNames) {
      const scopedRows = contractRows.get(contractName) ?? [];
      const classes = scopedRows.map((row) => row.mutantClass);
      if (JSON.stringify(classes) !== JSON.stringify(MUTANT_CLASSES)) {
        throw new Error(
          `${contractName} summary class inventory ${classes.join(",")}; expected ${MUTANT_CLASSES.join(",")}`,
        );
      }
    }
  }

  for (const mutantClass of MUTANT_CLASSES) {
    const count = rows.filter((row) => row.mutantClass === mutantClass).length;
    if (count !== expectedContracts) {
      throw new Error(
        `${mutantClass} summary count ${count}; expected ${expectedContracts}`,
      );
    }
  }
  if (rows.length !== expectedContracts * MUTANT_CLASSES.length) {
    throw new Error(
      `summary inventory ${rows.length}; expected ${expectedContracts * MUTANT_CLASSES.length}`,
    );
  }

  const compiled = rows.reduce((sum, row) => sum + row.compiled, 0);
  const caught = rows.reduce((sum, row) => sum + row.caught, 0);
  if (!Number.isSafeInteger(compiled) || !Number.isSafeInteger(caught)) {
    throw new Error("aggregate mutation counts exceed safe integer range");
  }
  if (compiled === 0) throw new Error("zero compiled mutants");

  const scorePercent = (caught * 100) / compiled;
  const passed = caught * 100 >= compiled * thresholdPercent;
  return {
    caught,
    compiled,
    scorePercent,
    passed,
    thresholdPercent,
    completedContracts,
    rows,
  };
}

export function renderMutationSummary(result, label) {
  if (typeof label !== "string" || label.length === 0)
    throw new Error("label is required");
  return [
    `compiled mutants: ${result.compiled}`,
    `caught mutants: ${result.caught}`,
    `mutation score: ${result.scorePercent.toFixed(2)}%`,
    `${label}: ${result.passed ? "PASS" : "FAIL"} (>=${result.thresholdPercent}%)`,
  ].join("\n");
}

function parseCli(argv) {
  const options = {
    expectedContracts: 1,
    expectedContractNames: [],
    thresholdPercent: 90,
    label: "mutation gate",
  };
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    const value = argv[position + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for ${flag}`);
    position += 1;
    if (flag === "--input") options.input = value;
    else if (flag === "--expected-contracts")
      options.expectedContracts = Number(value);
    else if (flag === "--expected-contract")
      options.expectedContractNames.push(value);
    else if (flag === "--threshold-percent")
      options.thresholdPercent = Number(value);
    else if (flag === "--label") options.label = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.input) throw new Error("--input is required");
  if (options.expectedContractNames.length === 0)
    delete options.expectedContractNames;
  return options;
}

function main() {
  let label = "mutation gate";
  try {
    const options = parseCli(process.argv.slice(2));
    label = options.label;
    const result = parseMutationSummary(
      fs.readFileSync(options.input, "utf8"),
      options,
    );
    process.stdout.write(`${renderMutationSummary(result, label)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${label}: FAIL (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main();
