import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toEventSelector, toFunctionSelector } from "viem";
import { sourceManifestPaths } from "./manifest-inventory.mjs";

const root = process.cwd();
const contracts = {
  ProtocolConfigV1: "ProtocolConfigV1.sol",
  EmergencyControllerV1: "EmergencyControllerV1.sol",
  LaunchExposureGuardV1: "LaunchExposureGuardV1.sol",
  BondEscrowV1: "BondEscrowV1.sol",
  FeeVaultV1: "FeeVaultV1.sol",
  FullMarketDeployerV1: "FullMarketDeployerV1.sol",
  MarketFactoryV1: "MarketFactoryV1.sol",
  FullMarketVaultV1: "FullMarketVaultV1.sol",
  CloneMarketVaultV1: "CloneMarketVaultV1.sol",
  FixedPriceMarketplaceV1: "FixedPriceMarketplaceV1.sol",
  SponsorshipPaymasterV1: "SponsorshipPaymasterV1.sol",
};

await mkdir(join(root, "generated/abi"), { recursive: true });
await mkdir(join(root, "generated/registries"), { recursive: true });
await mkdir(join(root, "generated/storage-layout"), { recursive: true });

const events = [];
const errors = [];
const bytecode = [];
const selectors = [];
for (const [contract, source] of Object.entries(contracts)) {
  const artifactPath = join(root, "out", source, `${contract}.json`);
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  await writeJson(
    join(root, "generated/abi", `${contract}.json`),
    artifact.abi,
  );
  await writeJson(
    join(root, "generated/storage-layout", `${contract}.json`),
    artifact.storageLayout ?? { storage: [], types: {} },
  );
  for (const [signature, selector] of Object.entries(
    artifact.methodIdentifiers ?? {},
  )) {
    selectors.push({ contract, signature, selector: `0x${selector}` });
  }
  for (const item of artifact.abi) {
    if (item.type !== "event" && item.type !== "error") continue;
    const signature = `${item.name}(${item.inputs.map((input) => canonicalType(input)).join(",")})`;
    const record = {
      contract,
      name: item.name,
      signature,
      selector:
        item.type === "event"
          ? toEventSelector(signature)
          : toFunctionSelector(signature),
      inputs: item.inputs,
    };
    (item.type === "event" ? events : errors).push(record);
  }
  const deployed = artifact.deployedBytecode?.object ?? "0x";
  const creation = artifact.bytecode?.object ?? "0x";
  bytecode.push({
    contract,
    creationBytecodeSha256: sha256(creation),
    runtimeBytecodeSha256: sha256(deployed),
    creationBytes: bytesLength(creation),
    runtimeBytes: bytesLength(deployed),
  });
}
events.sort(bySignature);
errors.sort(bySignature);
selectors.sort(bySignature);
await writeJson(join(root, "generated/registries/events.json"), events);
await writeJson(join(root, "generated/registries/errors.json"), errors);
await writeJson(join(root, "generated/registries/selectors.json"), selectors);
await writeJson(join(root, "generated/registries/bytecode.json"), bytecode);

const files = [];
for (const path of await sourceManifestPaths(root)) {
  files.push({ path, sha256: sha256(await readFile(join(root, path))) });
}
await writeJson(join(root, "manifests/source-manifest.json"), {
  schemaVersion: 1,
  compiler: "0.8.36",
  evmVersion: "cancun",
  optimizer: { enabled: true, runs: 200, viaIR: true },
  metadata: { bytecodeHash: "none", cborMetadata: false },
  files,
  bytecode,
});

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const suffix = input.type.slice("tuple".length);
  return `(${input.components.map((component) => canonicalType(component)).join(",")})${suffix}`;
}

function bytesLength(value) {
  return value.startsWith("0x") ? (value.length - 2) / 2 : value.length / 2;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bySignature(a, b) {
  return `${a.signature}:${a.contract}`.localeCompare(
    `${b.signature}:${b.contract}`,
  );
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
