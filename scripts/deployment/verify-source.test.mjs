import assert from "node:assert/strict";
import test from "node:test";
import {
  buildForgeVerificationCommand,
  canReuseEvidence,
  encodeConstructorArgs,
  redactCommand,
  verificationSucceeded,
} from "./verify-source.mjs";

test("constructor encoder handles scalar and array values deterministically", () => {
  const encoded = encodeConstructorArgs([
    { name: "delay", type: "uint256", value: "3600" },
    { name: "owners", type: "address[]", value: ["0x1111111111111111111111111111111111111111"] },
    { name: "enabled", type: "bool", value: true },
  ]);
  assert.match(encoded, /^0x[0-9a-f]+$/);
  assert.equal(encodeConstructorArgs([]), "0x");
});

test("constructor encoder rejects malformed integer and arrays", () => {
  assert.throws(() => encodeConstructorArgs([{ name: "x", type: "uint256", value: "no" }]));
  assert.throws(() => encodeConstructorArgs([{ name: "x", type: "address[]", value: "no" }]));
});

test("Arbiscan command is chain/settings locked and never contains an API key", () => {
  const command = buildForgeVerificationCommand({
    address: "0x1111111111111111111111111111111111111111",
    source: "src/X.sol:X",
    constructorArgs: "0x1234",
    compiler: "0.8.36",
    optimizerRuns: 200,
    viaIR: true,
    evmVersion: "cancun",
  });
  assert.deepEqual(command.slice(command.indexOf("--chain"), command.indexOf("--chain") + 2), ["--chain", "421614"]);
  assert.deepEqual(command.slice(command.indexOf("--retries"), command.indexOf("--retries") + 2), ["--retries", "0"]);
  assert.equal(command.includes("--via-ir"), true);
  assert.doesNotMatch(command.join(" "), /API_KEY|secret/i);
  assert.match(redactCommand(command), /sha256:/);
});

test("idempotency requires exact input and all 11 verified records", () => {
  const sha = "a".repeat(64);
  const evidence = { inputSha256: sha, status: "COMPLETE", contracts: Array.from({ length: 11 }, () => ({ status: "VERIFIED" })) };
  assert.equal(canReuseEvidence(evidence, sha), true);
  assert.equal(canReuseEvidence(evidence, "b".repeat(64)), false);
  evidence.contracts[3].status = "FAILED";
  assert.equal(canReuseEvidence(evidence, sha), false);
  assert.equal(verificationSucceeded(0, "Contract already verified"), true);
  assert.equal(verificationSucceeded(1, "verified"), false);
});
