#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONTRACTS = {
  ProtocolConfigV1: {
    constructor: ["address", "address", "address"],
    functions: [
      "governance()address",
      "paymentToken()address",
      "protocolTreasury()address",
      "creationFee()uint128",
      "protocolShareBps()uint16",
      "earlyBirdShareBps()uint16",
      "platformC2CFeeBps()uint16",
      "maxCreatorRakeBps()uint16",
      "maxCreatorC2CFeeBps()uint16",
      "maxFullMarketCap()uint128",
      "maxCloneMarketCap()uint128",
      "maxPerUserPrimaryCap()uint128",
    ],
  },
  EmergencyControllerV1: {
    constructor: ["address", "address"],
    functions: [
      "governance()address",
      "emergencySafe()address",
      "pausedFlags()uint256",
      "pauseExpiresAt()uint64",
    ],
  },
  LaunchExposureGuardV1: {
    constructor: ["address", "uint256"],
    functions: [
      "governance()address",
      "factory()address",
      "exposureCap()uint256",
      "retired()bool",
    ],
  },
  FeeVaultV1: {
    constructor: ["address", "address"],
    functions: [
      "governance()address",
      "paymentToken()address",
      "factory()address",
      "authorizedAccruer(address)bool",
    ],
  },
  BondEscrowV1: {
    constructor: ["address", "address"],
    functions: [
      "governance()address",
      "paymentToken()address",
      "factory()address",
    ],
  },
  FullMarketDeployerV1: {
    constructor: ["address"],
    functions: ["governance()address", "factory()address"],
  },
  CloneMarketVaultV1: { constructor: [], functions: [] },
  MarketFactoryV1: {
    constructor: [
      "address",
      "address",
      "address",
      "address",
      "address",
      "address",
      "address",
      "address",
      "uint64",
      "address",
    ],
    functions: [
      "governance()address",
      "config()address",
      "emergencyController()address",
      "exposureGuard()address",
      "bondEscrow()address",
      "feeVault()address",
      "fullMarketDeployer()address",
      "cloneImplementation()address",
      "paymentToken()address",
      "permit2()address",
      "resolutionWindow()uint64",
      "marketplace()address",
      "active()bool",
      "deprecated()bool",
      "activationFingerprint()bytes32",
      "dependencyFingerprint()bytes32",
      "dependencyFingerprintFor(address)bytes32",
    ],
  },
  FixedPriceMarketplaceV1: {
    constructor: ["address", "address", "address", "address", "address"],
    functions: [
      "factory()address",
      "emergencyController()address",
      "feeVault()address",
      "paymentToken()address",
      "permit2()address",
    ],
  },
  SponsorshipPaymasterV1: {
    constructor: [
      "address",
      "address",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint256",
    ],
    functions: [
      "governance()address",
      "emergencyController()address",
      "entryPoint()address",
      "sponsorSigner()address",
      "maxCostPerOperation()uint256",
      "maxCostPerUserPerDay()uint256",
      "maxCostGlobalPerDay()uint256",
      "policyVersion()uint32",
    ],
  },
};

function signature(item) {
  return `${item.name}(${item.inputs.map((input) => input.type).join(",")})${item.outputs.map((output) => output.type).join(",")}`;
}

export async function validateDeploymentAbis(root = "generated/abi") {
  for (const [contract, expected] of Object.entries(CONTRACTS)) {
    const path = `${root}/${contract}.json`;
    const abi = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(abi)) throw new Error(`${path}: ABI must be an array`);
    const constructor = abi.find((item) => item.type === "constructor");
    const actualConstructor =
      constructor?.inputs.map((input) => input.type) ?? [];
    if (
      JSON.stringify(actualConstructor) !== JSON.stringify(expected.constructor)
    )
      throw new Error(`${contract}: constructor ABI drift`);
    const functions = new Set(
      abi.filter((item) => item.type === "function").map(signature),
    );
    for (const required of expected.functions)
      if (!functions.has(required))
        throw new Error(`${contract}: missing verifier getter ${required}`);
  }
  const layoutRoot = root.replace(/\/abi\/?$/, "/storage-layout");
  const cloneLayout = JSON.parse(
    await readFile(`${layoutRoot}/CloneMarketVaultV1.json`, "utf8"),
  );
  const initialized = cloneLayout.storage?.find(
    (item) => item.label === "_initialized",
  );
  if (
    !initialized ||
    initialized.slot !== "5" ||
    initialized.offset !== 0 ||
    initialized.type !== "t_bool"
  )
    throw new Error("CloneMarketVaultV1: _initialized storage lock slot drift");
  return { contracts: Object.keys(CONTRACTS).length };
}

async function main() {
  const result = await validateDeploymentAbis(
    process.argv[2] ?? "generated/abi",
  );
  process.stdout.write(
    `PASS deployment ABI compatibility ${result.contracts} contracts\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
