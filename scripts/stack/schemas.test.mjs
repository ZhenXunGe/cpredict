import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildRuntimePackage } from "../deployment/sync-runtime.mjs";

const schemaNames = [
  "runtime-package",
  "source-verification",
  "canary-state",
  "backup-manifest",
  "local-ops-drill",
];

async function schema(name) {
  return JSON.parse(
    await readFile(new URL(`../../manifests/${name}.schema.json`, import.meta.url), "utf8"),
  );
}

test("deployment and operations schemas compile as JSON Schema 2020-12", async () => {
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
  for (const name of schemaNames) assert.equal(typeof ajv.compile(await schema(name)), "function", name);
});

test("candidate runtime package conforms to its checked-in schema", async () => {
  const address = (digit) => `0x${digit.repeat(40)}`;
  const deployment = {
    chainId: 421614,
    status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    sourceManifestSha256: "a".repeat(64),
    timelock: address("1"), config: address("2"), emergencyController: address("3"),
    exposureGuard: address("4"), feeVault: address("5"), bondEscrow: address("6"),
    cloneImplementation: address("7"), fullMarketDeployer: address("8"), factory: address("9"),
    marketplace: address("a"), paymaster: address("b"), governanceSafe: address("c"),
    emergencySafe: address("d"), temporaryAdmin: address("e"), protocolTreasury: address("f"),
    sponsorSigner: address("e"), paymasterPolicyVersion: 1,
    paymasterMaxCostPerOperation: "1", paymasterMaxCostPerUserDay: "2",
    paymasterMaxCostGlobalDay: "3",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  };
  const value = buildRuntimePackage({
    mode: "candidate", deployment, deploymentBlock: 1, inputSha256: "b".repeat(64),
  }).packageManifest;
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
  const validate = ajv.compile(await schema("runtime-package"));
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
});
