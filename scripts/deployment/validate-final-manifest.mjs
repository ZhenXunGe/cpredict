#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  CONTRACT_KEYS,
  EXTERNAL_KEYS,
  ZERO_ADDRESS,
  assertAddress,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertInteger,
  assertObject,
  assertRuntimeEvidence,
  assertSha256,
  assertString,
  assertTimestamp,
  assertUnique,
  normalizeAddressSet,
  readJson,
  sha256Json,
  validateReceipt,
} from "./evidence-lib.mjs";

const ROOT_KEYS = [
  "schemaVersion",
  "evidenceClass",
  "status",
  "chainId",
  "network",
  "generatedAt",
  "source",
  "referenceBlock",
  "actors",
  "externalContracts",
  "contracts",
  "transactions",
  "bootstrap",
  "configuration",
  "roles",
  "sourceVerification",
  "canaryEvidence",
];

function validateCodeRecord(record, path, { includeConstructor = false } = {}) {
  const keys = [
    "address",
    "runtimeCodehash",
    "deploymentTx",
    "deploymentBlock",
    "deploymentBlockHash",
  ];
  if (includeConstructor) keys.push("constructorArgs", "receiptStatus");
  assertExactKeys(record, keys, path);
  assertAddress(record.address, `${path}.address`);
  assertHash(record.runtimeCodehash, `${path}.runtimeCodehash`);
  assertHash(record.deploymentTx, `${path}.deploymentTx`);
  assertInteger(record.deploymentBlock, `${path}.deploymentBlock`, { min: 1 });
  assertHash(record.deploymentBlockHash, `${path}.deploymentBlockHash`);
  if (includeConstructor) {
    if (record.receiptStatus !== 1)
      throw new Error(`${path}.receiptStatus: must equal 1`);
    if (!Array.isArray(record.constructorArgs))
      throw new Error(`${path}.constructorArgs: must be an array`);
    for (const [i, arg] of record.constructorArgs.entries()) {
      assertExactKeys(
        arg,
        ["name", "type", "value"],
        `${path}.constructorArgs[${i}]`,
      );
      assertString(arg.name, `${path}.constructorArgs[${i}].name`);
      assertString(arg.type, `${path}.constructorArgs[${i}].type`);
      const validScalar = (value) =>
        ["string", "number", "boolean"].includes(typeof value);
      if (
        !validScalar(arg.value) &&
        !(Array.isArray(arg.value) && arg.value.every(validScalar))
      ) {
        throw new Error(
          `${path}.constructorArgs[${i}].value: must be a scalar or scalar array`,
        );
      }
    }
  }
}

function assertConstructor(record, expected, path) {
  const normalizeValue = (value) =>
    Array.isArray(value)
      ? value.map((item) => String(item).toLowerCase())
      : String(value).toLowerCase();
  const actual = record.constructorArgs.map(({ name, type, value }) => ({
    name,
    type,
    value: normalizeValue(value),
  }));
  const normalizedExpected = expected.map(({ name, type, value }) => ({
    name,
    type,
    value: normalizeValue(value),
  }));
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `${path}.constructorArgs: do not match deployed wiring/configuration`,
    );
  }
}

function validateSource(source) {
  assertExactKeys(
    source,
    [
      "commit",
      "tag",
      "sourceManifestSha256",
      "compiler",
      "foundry",
      "optimizer",
      "optimizerRuns",
      "viaIR",
      "evmVersion",
    ],
    "manifest.source",
  );
  if (!/^[0-9a-f]{40}$/.test(source.commit))
    throw new Error(
      "manifest.source.commit: must be a full lowercase commit SHA",
    );
  assertString(source.tag, "manifest.source.tag");
  assertSha256(
    source.sourceManifestSha256,
    "manifest.source.sourceManifestSha256",
  );
  if (source.compiler !== "0.8.36")
    throw new Error("manifest.source.compiler: must equal 0.8.36");
  if (source.foundry !== "1.7.1")
    throw new Error("manifest.source.foundry: must equal 1.7.1");
  if (source.optimizer !== true || source.viaIR !== true)
    throw new Error(
      "manifest.source: production optimizer and viaIR must both be true",
    );
  assertInteger(source.optimizerRuns, "manifest.source.optimizerRuns", {
    min: 1,
  });
  assertString(source.evmVersion, "manifest.source.evmVersion");
}

function validateSafe(safe, expectedThreshold, path) {
  assertExactKeys(
    safe,
    [
      "address",
      "owners",
      "threshold",
      "runtimeCodehash",
      "deploymentTx",
      "deploymentBlock",
      "deploymentBlockHash",
    ],
    path,
  );
  const address = assertAddress(safe.address, `${path}.address`);
  assertHash(safe.runtimeCodehash, `${path}.runtimeCodehash`);
  assertHash(safe.deploymentTx, `${path}.deploymentTx`);
  assertInteger(safe.deploymentBlock, `${path}.deploymentBlock`, { min: 1 });
  assertHash(safe.deploymentBlockHash, `${path}.deploymentBlockHash`);
  const owners = normalizeAddressSet(safe.owners, `${path}.owners`);
  if (owners.length !== 6)
    throw new Error(`${path}.owners: must contain exactly 6 distinct owners`);
  if (safe.threshold !== expectedThreshold)
    throw new Error(`${path}.threshold: must equal ${expectedThreshold}`);
  if (owners.includes(address))
    throw new Error(
      `${path}.owners: Safe contract must not be listed as its own owner`,
    );
  return address;
}

export function validateFinalManifest(
  manifest,
  { allowPendingCanary = false, allowPendingSourceVerification = false } = {},
) {
  assertExactKeys(manifest, ROOT_KEYS, "manifest");
  assertRuntimeEvidence(
    manifest,
    "cpredict.arbitrum-sepolia.deployment.v1",
    "manifest",
  );
  const allowedStatus = allowPendingCanary
    ? ["BOOTSTRAP_FINALIZED_PENDING_CANARY", "FINALIZED_VERIFIED"]
    : ["FINALIZED_VERIFIED"];
  if (!allowedStatus.includes(manifest.status))
    throw new Error(
      `manifest.status: must equal ${allowedStatus.join(" or ")}`,
    );
  if (manifest.network !== "arbitrum-sepolia")
    throw new Error("manifest.network: must equal arbitrum-sepolia");
  assertTimestamp(manifest.generatedAt, "manifest.generatedAt");
  validateSource(manifest.source);

  assertExactKeys(
    manifest.referenceBlock,
    [
      "number",
      "hash",
      "timestamp",
      "parentChainId",
      "l1BlockNumber",
      "finality",
      "confirmations",
      "rpcEvidenceSha256",
    ],
    "manifest.referenceBlock",
  );
  assertInteger(
    manifest.referenceBlock.number,
    "manifest.referenceBlock.number",
    { min: 1 },
  );
  assertHash(manifest.referenceBlock.hash, "manifest.referenceBlock.hash");
  assertInteger(
    manifest.referenceBlock.timestamp,
    "manifest.referenceBlock.timestamp",
    { min: 1 },
  );
  if (manifest.referenceBlock.parentChainId !== 11_155_111)
    throw new Error(
      "manifest.referenceBlock.parentChainId: must equal Ethereum Sepolia 11155111",
    );
  assertInteger(
    manifest.referenceBlock.l1BlockNumber,
    "manifest.referenceBlock.l1BlockNumber",
    { min: 1 },
  );
  if (manifest.referenceBlock.finality !== "FINALIZED")
    throw new Error(
      "manifest.referenceBlock.finality: must equal FINALIZED",
    );
  assertInteger(
    manifest.referenceBlock.confirmations,
    "manifest.referenceBlock.confirmations",
    { min: 1 },
  );
  assertSha256(
    manifest.referenceBlock.rpcEvidenceSha256,
    "manifest.referenceBlock.rpcEvidenceSha256",
  );
  if (
    !allowPendingCanary &&
    /^0+$/.test(manifest.referenceBlock.rpcEvidenceSha256)
  )
    throw new Error(
      "manifest.referenceBlock.rpcEvidenceSha256: zero placeholder is forbidden in final evidence",
    );

  assertExactKeys(
    manifest.actors,
    [
      "deployer",
      "governanceSafe",
      "emergencySafe",
      "protocolTreasury",
      "sponsorSigner",
    ],
    "manifest.actors",
  );
  const deployer = assertAddress(
    manifest.actors.deployer,
    "manifest.actors.deployer",
  );
  const governanceSafe = validateSafe(
    manifest.actors.governanceSafe,
    4,
    "manifest.actors.governanceSafe",
  );
  const emergencySafe = validateSafe(
    manifest.actors.emergencySafe,
    2,
    "manifest.actors.emergencySafe",
  );
  assertAddress(
    manifest.actors.protocolTreasury,
    "manifest.actors.protocolTreasury",
  );
  assertAddress(manifest.actors.sponsorSigner, "manifest.actors.sponsorSigner");
  assertUnique(
    [
      deployer,
      governanceSafe,
      emergencySafe,
      manifest.actors.protocolTreasury,
      manifest.actors.sponsorSigner,
    ],
    "manifest.actors privileged addresses",
  );

  assertExactKeys(
    manifest.externalContracts,
    EXTERNAL_KEYS,
    "manifest.externalContracts",
  );
  for (const key of EXTERNAL_KEYS)
    validateCodeRecord(
      manifest.externalContracts[key],
      `manifest.externalContracts.${key}`,
    );
  const canonicalExternalAddresses = {
    usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
  };
  for (const [key, address] of Object.entries(canonicalExternalAddresses)) {
    if (manifest.externalContracts[key].address.toLowerCase() !== address)
      throw new Error(
        `manifest.externalContracts.${key}.address: not the V1 canonical Arbitrum Sepolia address`,
      );
  }
  assertExactKeys(manifest.contracts, CONTRACT_KEYS, "manifest.contracts");
  for (const key of CONTRACT_KEYS)
    validateCodeRecord(manifest.contracts[key], `manifest.contracts.${key}`, {
      includeConstructor: true,
    });
  assertUnique(
    [
      ...CONTRACT_KEYS.map((key) => manifest.contracts[key].address),
      ...EXTERNAL_KEYS.map((key) => manifest.externalContracts[key].address),
    ],
    "manifest deployed/external addresses",
  );

  assertExactKeys(
    manifest.transactions,
    ["deployment", "bootstrapSchedule", "bootstrapFinalize"],
    "manifest.transactions",
  );
  for (const key of ["deployment", "bootstrapSchedule", "bootstrapFinalize"])
    validateReceipt(manifest.transactions[key], `manifest.transactions.${key}`);
  if (
    manifest.transactions.bootstrapFinalize.timestamp <
    manifest.transactions.bootstrapSchedule.timestamp + 3600
  ) {
    throw new Error(
      "manifest.transactions.bootstrapFinalize.timestamp: timelock delay was not observed",
    );
  }

  assertExactKeys(
    manifest.bootstrap,
    [
      "minimumDelaySeconds",
      "operationId",
      "salt",
      "factoryActivationFingerprint",
      "scheduledAt",
      "executedAt",
    ],
    "manifest.bootstrap",
  );
  if (manifest.bootstrap.minimumDelaySeconds !== 3600)
    throw new Error("manifest.bootstrap.minimumDelaySeconds: must equal 3600");
  assertHash(manifest.bootstrap.operationId, "manifest.bootstrap.operationId");
  assertHash(manifest.bootstrap.salt, "manifest.bootstrap.salt");
  assertHash(
    manifest.bootstrap.factoryActivationFingerprint,
    "manifest.bootstrap.factoryActivationFingerprint",
  );
  assertInteger(
    manifest.bootstrap.scheduledAt,
    "manifest.bootstrap.scheduledAt",
    { min: 1 },
  );
  assertInteger(
    manifest.bootstrap.executedAt,
    "manifest.bootstrap.executedAt",
    { min: 1 },
  );
  if (manifest.bootstrap.executedAt < manifest.bootstrap.scheduledAt + 3600)
    throw new Error("manifest.bootstrap.executedAt: too early");

  const cfg = manifest.configuration;
  assertExactKeys(
    cfg,
    [
      "initialExposureCap",
      "creationFee",
      "protocolShareBps",
      "earlyBirdShareBps",
      "platformC2CFeeBps",
      "maxCreatorRakeBps",
      "maxCreatorC2CFeeBps",
      "maxFullMarketCap",
      "maxCloneMarketCap",
      "maxPerUserPrimaryCap",
      "paymasterMaxCostPerOperation",
      "paymasterMaxCostPerUserDay",
      "paymasterMaxCostGlobalDay",
      "paymasterPolicyVersion",
    ],
    "manifest.configuration",
  );
  for (const key of Object.keys(cfg)) {
    if (key.endsWith("Bps") || key === "paymasterPolicyVersion")
      assertInteger(cfg[key], `manifest.configuration.${key}`, {
        min: key === "paymasterPolicyVersion" ? 1 : 0,
      });
    else assertDecimalString(cfg[key], `manifest.configuration.${key}`);
  }
  if (cfg.initialExposureCap !== "50000000000")
    throw new Error(
      "manifest.configuration.initialExposureCap: must equal Arbitrum Sepolia launch cap 50000000000",
    );
  const bounded = (key, maximum) => {
    const value = key.endsWith("Bps") ? BigInt(cfg[key]) : BigInt(cfg[key]);
    if (value < 0n || value > BigInt(maximum))
      throw new Error(
        `manifest.configuration.${key}: exceeds V1 hard bound ${maximum}`,
      );
  };
  bounded("creationFee", 100_000_000);
  bounded("protocolShareBps", 5_000);
  bounded("earlyBirdShareBps", 5_000);
  bounded("platformC2CFeeBps", 200);
  bounded("maxCreatorRakeBps", 1_000);
  bounded("maxCreatorC2CFeeBps", 200);
  bounded("maxFullMarketCap", 5_000_000_000);
  bounded("maxCloneMarketCap", 500_000_000);
  bounded("maxPerUserPrimaryCap", 100_000_000);
  if (
    BigInt(cfg.maxFullMarketCap) === 0n ||
    BigInt(cfg.maxCloneMarketCap) === 0n ||
    BigInt(cfg.maxPerUserPrimaryCap) === 0n
  )
    throw new Error(
      "manifest.configuration: market and user caps must be positive",
    );
  if (!(
    BigInt(cfg.paymasterMaxCostPerOperation) > 0n &&
    BigInt(cfg.paymasterMaxCostPerOperation) <=
      BigInt(cfg.paymasterMaxCostPerUserDay) &&
    BigInt(cfg.paymasterMaxCostPerUserDay) <=
      BigInt(cfg.paymasterMaxCostGlobalDay)
  ))
    throw new Error(
      "manifest.configuration: Paymaster budgets must satisfy 0 < per-op <= per-user-day <= global-day",
    );

  const roles = manifest.roles;
  assertExactKeys(
    roles,
    [
      "defaultAdmin",
      "proposer",
      "canceller",
      "executor",
      "temporaryDeployerRolesCleared",
      "roleEventsSha256",
    ],
    "manifest.roles",
  );
  const defaultAdmins = normalizeAddressSet(
    roles.defaultAdmin,
    "manifest.roles.defaultAdmin",
  );
  const proposers = normalizeAddressSet(
    roles.proposer,
    "manifest.roles.proposer",
  );
  const cancellers = normalizeAddressSet(
    roles.canceller,
    "manifest.roles.canceller",
  );
  const executors = normalizeAddressSet(
    roles.executor,
    "manifest.roles.executor",
  );
  const timelock = manifest.contracts.timelock.address.toLowerCase();
  if (JSON.stringify(defaultAdmins) !== JSON.stringify([timelock]))
    throw new Error(
      "manifest.roles.defaultAdmin: must contain only the Timelock itself",
    );
  if (JSON.stringify(proposers) !== JSON.stringify([governanceSafe]))
    throw new Error(
      "manifest.roles.proposer: must contain only Governance Safe",
    );
  if (JSON.stringify(cancellers) !== JSON.stringify([governanceSafe]))
    throw new Error(
      "manifest.roles.canceller: must contain only Governance Safe",
    );
  if (JSON.stringify(executors) !== JSON.stringify([ZERO_ADDRESS]))
    throw new Error(
      "manifest.roles.executor: must be permissionless zero address only",
    );
  if (roles.temporaryDeployerRolesCleared !== true)
    throw new Error(
      "manifest.roles.temporaryDeployerRolesCleared: must be true",
    );
  if (
    [...defaultAdmins, ...proposers, ...cancellers, ...executors].includes(
      deployer,
    )
  )
    throw new Error("manifest.roles: temporary deployer role remains");
  assertSha256(roles.roleEventsSha256, "manifest.roles.roleEventsSha256");
  if (!allowPendingCanary && /^0+$/.test(roles.roleEventsSha256))
    throw new Error(
      "manifest.roles.roleEventsSha256: zero placeholder is forbidden in final evidence",
    );

  if (
    !Array.isArray(manifest.sourceVerification) ||
    manifest.sourceVerification.length !== CONTRACT_KEYS.length
  ) {
    throw new Error(
      `manifest.sourceVerification: must contain exactly ${CONTRACT_KEYS.length} records`,
    );
  }
  const verifiedNames = [];
  for (const [i, item] of manifest.sourceVerification.entries()) {
    const path = `manifest.sourceVerification[${i}]`;
    assertExactKeys(
      item,
      [
        "contract",
        "address",
        "status",
        "explorerUrl",
        "constructorArgsVerified",
        "runtimeBytecodeVerified",
      ],
      path,
    );
    if (!CONTRACT_KEYS.includes(item.contract))
      throw new Error(`${path}.contract: unknown contract`);
    verifiedNames.push(item.contract);
    if (
      assertAddress(item.address, `${path}.address`) !==
      manifest.contracts[item.contract].address.toLowerCase()
    )
      throw new Error(`${path}.address: contract address mismatch`);
    const verified =
      item.status === "VERIFIED" &&
      item.constructorArgsVerified === true &&
      item.runtimeBytecodeVerified === true;
    const pending =
      allowPendingSourceVerification &&
      item.status === "PENDING" &&
      item.constructorArgsVerified === false &&
      item.runtimeBytecodeVerified === false;
    if (!verified && !pending)
      throw new Error(`${path}: source, constructor and runtime verification must all pass or be explicitly PENDING`);
    let explorer;
    try {
      explorer = new URL(item.explorerUrl);
    } catch {
      throw new Error(`${path}.explorerUrl: must be a valid URL`);
    }
    if (
      explorer.protocol !== "https:" ||
      explorer.hostname !== "sepolia.arbiscan.io" ||
      explorer.pathname.toLowerCase() !==
        `/address/${item.address.toLowerCase()}`
    )
      throw new Error(
        `${path}.explorerUrl: must be the exact Arbitrum Sepolia Arbiscan address URL`,
      );
  }
  assertUnique(verifiedNames, "manifest.sourceVerification contracts");

  assertExactKeys(
    manifest.canaryEvidence,
    ["evidenceSha256", "status"],
    "manifest.canaryEvidence",
  );
  assertSha256(
    manifest.canaryEvidence.evidenceSha256,
    "manifest.canaryEvidence.evidenceSha256",
  );
  if (manifest.status === "FINALIZED_VERIFIED") {
    if (
      manifest.canaryEvidence.status !== "COMPLETE" ||
      /^0+$/.test(manifest.canaryEvidence.evidenceSha256)
    )
      throw new Error(
        "manifest.canaryEvidence: final manifest requires COMPLETE and a non-zero evidence SHA-256",
      );
  } else if (
    !allowPendingCanary ||
    manifest.canaryEvidence.status !== "PENDING" ||
    !/^0+$/.test(manifest.canaryEvidence.evidenceSha256)
  ) {
    throw new Error(
      "manifest.canaryEvidence: pending candidate requires PENDING and a zero placeholder",
    );
  }

  const c = manifest.contracts;
  const e = manifest.externalContracts;
  assertConstructor(
    c.timelock,
    [
      { name: "minDelay", type: "uint256", value: "3600" },
      {
        name: "proposers",
        type: "address[]",
        value: [
          manifest.actors.governanceSafe.address,
          manifest.actors.deployer,
        ],
      },
      { name: "executors", type: "address[]", value: [ZERO_ADDRESS] },
      { name: "admin", type: "address", value: manifest.actors.deployer },
    ],
    "manifest.contracts.timelock",
  );
  assertConstructor(
    c.config,
    [
      { name: "governance_", type: "address", value: c.timelock.address },
      { name: "paymentToken_", type: "address", value: e.usdc.address },
      {
        name: "treasury_",
        type: "address",
        value: manifest.actors.protocolTreasury,
      },
    ],
    "manifest.contracts.config",
  );
  assertConstructor(
    c.emergencyController,
    [
      { name: "governance_", type: "address", value: c.timelock.address },
      {
        name: "emergencySafe_",
        type: "address",
        value: manifest.actors.emergencySafe.address,
      },
    ],
    "manifest.contracts.emergencyController",
  );
  for (const key of ["feeVault", "bondEscrow"])
    assertConstructor(
      c[key],
      [
        { name: "governance_", type: "address", value: c.timelock.address },
        { name: "paymentToken_", type: "address", value: e.usdc.address },
      ],
      `manifest.contracts.${key}`,
    );
  assertConstructor(
    c.exposureGuard,
    [
      { name: "governance_", type: "address", value: c.timelock.address },
      { name: "initialCap", type: "uint256", value: cfg.initialExposureCap },
    ],
    "manifest.contracts.exposureGuard",
  );
  assertConstructor(
    c.fullMarketDeployer,
    [{ name: "governance_", type: "address", value: c.timelock.address }],
    "manifest.contracts.fullMarketDeployer",
  );
  assertConstructor(
    c.cloneImplementation,
    [],
    "manifest.contracts.cloneImplementation",
  );
  assertConstructor(
    c.marketplace,
    [
      { name: "factory_", type: "address", value: c.factory.address },
      {
        name: "emergencyController_",
        type: "address",
        value: c.emergencyController.address,
      },
      { name: "feeVault_", type: "address", value: c.feeVault.address },
      { name: "paymentToken_", type: "address", value: e.usdc.address },
      { name: "permit2_", type: "address", value: e.permit2.address },
    ],
    "manifest.contracts.marketplace",
  );
  assertConstructor(
    c.factory,
    [
      { name: "governance_", type: "address", value: c.timelock.address },
      { name: "config_", type: "address", value: c.config.address },
      {
        name: "emergencyController_",
        type: "address",
        value: c.emergencyController.address,
      },
      {
        name: "exposureGuard_",
        type: "address",
        value: c.exposureGuard.address,
      },
      { name: "bondEscrow_", type: "address", value: c.bondEscrow.address },
      { name: "feeVault_", type: "address", value: c.feeVault.address },
      {
        name: "fullMarketDeployer_",
        type: "address",
        value: c.fullMarketDeployer.address,
      },
      {
        name: "cloneImplementation_",
        type: "address",
        value: c.cloneImplementation.address,
      },
      { name: "permit2_", type: "address", value: e.permit2.address },
    ],
    "manifest.contracts.factory",
  );
  assertConstructor(
    c.paymaster,
    [
      { name: "governance_", type: "address", value: c.timelock.address },
      {
        name: "emergencyController_",
        type: "address",
        value: c.emergencyController.address,
      },
      { name: "entryPoint_", type: "address", value: e.entryPoint.address },
      {
        name: "sponsorSigner_",
        type: "address",
        value: manifest.actors.sponsorSigner,
      },
      {
        name: "maxCostPerOperation_",
        type: "uint256",
        value: cfg.paymasterMaxCostPerOperation,
      },
      {
        name: "maxCostPerUserPerDay_",
        type: "uint256",
        value: cfg.paymasterMaxCostPerUserDay,
      },
      {
        name: "maxCostGlobalPerDay_",
        type: "uint256",
        value: cfg.paymasterMaxCostGlobalDay,
      },
    ],
    "manifest.contracts.paymaster",
  );

  return {
    manifest,
    sha256: sha256Json(manifest),
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
  };
}

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "usage: node scripts/deployment/validate-final-manifest.mjs <final-manifest.json>",
    );
  const result = validateFinalManifest(await readJson(path));
  process.stdout.write(`PASS final deployment manifest ${result.sha256}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
