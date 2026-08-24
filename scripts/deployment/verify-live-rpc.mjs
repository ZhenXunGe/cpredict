#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import {
  ZERO_ADDRESS,
  canonicalJson,
  readJson,
  sha256Json,
} from "./evidence-lib.mjs";
import { validateFinalManifest } from "./validate-final-manifest.mjs";

export const DEPLOYMENT_READ_ABIS = {
  factory: parseAbi([
    "function governance() view returns (address)",
    "function config() view returns (address)",
    "function emergencyController() view returns (address)",
    "function exposureGuard() view returns (address)",
    "function bondEscrow() view returns (address)",
    "function feeVault() view returns (address)",
    "function fullMarketDeployer() view returns (address)",
    "function cloneImplementation() view returns (address)",
    "function paymentToken() view returns (address)",
    "function permit2() view returns (address)",
    "function marketplace() view returns (address)",
    "function active() view returns (bool)",
    "function deprecated() view returns (bool)",
    "function activationFingerprint() view returns (bytes32)",
    "function dependencyFingerprint() view returns (bytes32)",
    "function dependencyFingerprintFor(address) view returns (bytes32)",
  ]),
  config: parseAbi([
    "function governance() view returns (address)",
    "function paymentToken() view returns (address)",
    "function protocolTreasury() view returns (address)",
    "function creationFee() view returns (uint128)",
    "function protocolShareBps() view returns (uint16)",
    "function earlyBirdShareBps() view returns (uint16)",
    "function platformC2CFeeBps() view returns (uint16)",
    "function maxCreatorRakeBps() view returns (uint16)",
    "function maxCreatorC2CFeeBps() view returns (uint16)",
    "function maxFullMarketCap() view returns (uint128)",
    "function maxCloneMarketCap() view returns (uint128)",
    "function maxPerUserPrimaryCap() view returns (uint128)",
  ]),
  emergencyController: parseAbi([
    "function governance() view returns (address)",
    "function emergencySafe() view returns (address)",
    "function pausedFlags() view returns (uint256)",
    "function pauseExpiresAt() view returns (uint64)",
  ]),
  exposureGuard: parseAbi([
    "function governance() view returns (address)",
    "function factory() view returns (address)",
    "function exposureCap() view returns (uint256)",
    "function retired() view returns (bool)",
  ]),
  feeVault: parseAbi([
    "function governance() view returns (address)",
    "function paymentToken() view returns (address)",
    "function factory() view returns (address)",
    "function authorizedAccruer(address) view returns (bool)",
  ]),
  bondEscrow: parseAbi([
    "function governance() view returns (address)",
    "function paymentToken() view returns (address)",
    "function factory() view returns (address)",
  ]),
  fullMarketDeployer: parseAbi([
    "function governance() view returns (address)",
    "function factory() view returns (address)",
  ]),
  marketplace: parseAbi([
    "function factory() view returns (address)",
    "function emergencyController() view returns (address)",
    "function feeVault() view returns (address)",
    "function paymentToken() view returns (address)",
    "function permit2() view returns (address)",
  ]),
  paymaster: parseAbi([
    "function governance() view returns (address)",
    "function emergencyController() view returns (address)",
    "function entryPoint() view returns (address)",
    "function sponsorSigner() view returns (address)",
    "function maxCostPerOperation() view returns (uint256)",
    "function maxCostPerUserPerDay() view returns (uint256)",
    "function maxCostGlobalPerDay() view returns (uint256)",
    "function policyVersion() view returns (uint32)",
  ]),
  timelock: parseAbi([
    "function getMinDelay() view returns (uint256)",
    "function hasRole(bytes32,address) view returns (bool)",
  ]),
  safe: parseAbi([
    "function getThreshold() view returns (uint256)",
    "function getOwners() view returns (address[])",
  ]),
  erc20Metadata: parseAbi(["function decimals() view returns (uint8)"]),
};
const ABIS = DEPLOYMENT_READ_ABIS;

export const TIMELOCK_ROLE_IDS = {
  defaultAdmin: `0x${"00".repeat(32)}`,
  proposer: keccak256(stringToHex("PROPOSER_ROLE")),
  executor: keccak256(stringToHex("EXECUTOR_ROLE")),
  canceller: keccak256(stringToHex("CANCELLER_ROLE")),
};
const ROLE_IDS = TIMELOCK_ROLE_IDS;
const ROLE_GRANTED = keccak256(
  stringToHex("RoleGranted(bytes32,address,address)"),
);
const ROLE_REVOKED = keccak256(
  stringToHex("RoleRevoked(bytes32,address,address)"),
);

function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function comparable(value) {
  const normalize = (item) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "string") return item.toLowerCase();
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [key, normalize(nested)]),
      );
    return item;
  };
  return canonicalJson(normalize(value));
}

class Rpc {
  constructor(url) {
    this.url = url;
    this.id = 0;
  }

  async request(method, params) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body.error)
      throw new Error(
        `RPC ${method} error ${body.error.code}: ${body.error.message}`,
      );
    if (body.result === undefined || body.result === null)
      throw new Error(`RPC ${method}: missing result`);
    return body.result;
  }

  async call(address, abi, functionName, args, block) {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.request("eth_call", [
      { to: address, data },
      block,
    ]);
    return decodeFunctionResult({ abi, functionName, data: result });
  }
}

function assertEqual(actual, expected, label) {
  if (comparable(actual) !== comparable(expected))
    throw new Error(
      `${label}: expected ${comparable(expected)}, got ${comparable(actual)}`,
    );
}

function endpointFingerprint(url) {
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    sha256: createHash("sha256").update(url).digest("hex"),
  };
}

async function readState(rpc, manifest, block) {
  const c = manifest.contracts;
  const e = manifest.externalContracts;
  const call = (key, name, args = []) =>
    rpc.call(c[key].address, ABIS[key], name, args, block);
  const state = {
    factory: {},
    config: {},
    emergencyController: {},
    exposureGuard: {},
    feeVault: {},
    bondEscrow: {},
    fullMarketDeployer: {},
    marketplace: {},
    paymaster: {},
    timelock: {},
    safes: {},
    external: {},
    cloneImplementation: {},
  };
  const calls = [];
  function queue(target, key, name, args = []) {
    calls.push(
      call(target, name, args).then((value) => {
        state[key][name + (args.length ? `:${lower(args[0])}` : "")] = value;
      }),
    );
  }
  for (const name of [
    "governance",
    "config",
    "emergencyController",
    "exposureGuard",
    "bondEscrow",
    "feeVault",
    "fullMarketDeployer",
    "cloneImplementation",
    "paymentToken",
    "permit2",
    "marketplace",
    "active",
    "deprecated",
    "activationFingerprint",
    "dependencyFingerprint",
  ])
    queue("factory", "factory", name);
  queue("factory", "factory", "dependencyFingerprintFor", [
    c.marketplace.address,
  ]);
  for (const name of [
    "governance",
    "paymentToken",
    "protocolTreasury",
    "creationFee",
    "protocolShareBps",
    "earlyBirdShareBps",
    "platformC2CFeeBps",
    "maxCreatorRakeBps",
    "maxCreatorC2CFeeBps",
    "maxFullMarketCap",
    "maxCloneMarketCap",
    "maxPerUserPrimaryCap",
  ])
    queue("config", "config", name);
  for (const name of [
    "governance",
    "emergencySafe",
    "pausedFlags",
    "pauseExpiresAt",
  ])
    queue("emergencyController", "emergencyController", name);
  for (const name of ["governance", "factory", "exposureCap", "retired"])
    queue("exposureGuard", "exposureGuard", name);
  for (const name of ["governance", "paymentToken", "factory"])
    queue("feeVault", "feeVault", name);
  queue("feeVault", "feeVault", "authorizedAccruer", [c.factory.address]);
  queue("feeVault", "feeVault", "authorizedAccruer", [c.marketplace.address]);
  for (const name of ["governance", "paymentToken", "factory"])
    queue("bondEscrow", "bondEscrow", name);
  for (const name of ["governance", "factory"])
    queue("fullMarketDeployer", "fullMarketDeployer", name);
  for (const name of [
    "factory",
    "emergencyController",
    "feeVault",
    "paymentToken",
    "permit2",
  ])
    queue("marketplace", "marketplace", name);
  for (const name of [
    "governance",
    "emergencyController",
    "entryPoint",
    "sponsorSigner",
    "maxCostPerOperation",
    "maxCostPerUserPerDay",
    "maxCostGlobalPerDay",
    "policyVersion",
  ])
    queue("paymaster", "paymaster", name);
  calls.push(
    rpc
      .call(c.timelock.address, ABIS.timelock, "getMinDelay", [], block)
      .then((value) => {
        state.timelock.getMinDelay = value;
      }),
  );
  for (const [role, roleId] of Object.entries(ROLE_IDS)) {
    for (const address of [
      c.timelock.address,
      manifest.actors.governanceSafe.address,
      manifest.actors.emergencySafe.address,
      manifest.actors.deployer,
      ZERO_ADDRESS,
    ]) {
      calls.push(
        rpc
          .call(
            c.timelock.address,
            ABIS.timelock,
            "hasRole",
            [roleId, address],
            block,
          )
          .then((value) => {
            state.timelock[`hasRole:${role}:${lower(address)}`] = value;
          }),
      );
    }
  }
  for (const [key, safe] of [
    ["governanceSafe", manifest.actors.governanceSafe],
    ["emergencySafe", manifest.actors.emergencySafe],
  ]) {
    calls.push(
      rpc
        .call(safe.address, ABIS.safe, "getThreshold", [], block)
        .then((value) => {
          state.safes[`${key}:threshold`] = value;
        }),
    );
    calls.push(
      rpc
        .call(safe.address, ABIS.safe, "getOwners", [], block)
        .then((value) => {
          state.safes[`${key}:owners`] = [...value].map(lower).sort();
        }),
    );
  }
  calls.push(
    rpc
      .call(e.usdc.address, ABIS.erc20Metadata, "decimals", [], block)
      .then((value) => {
        state.external.usdcDecimals = value;
      }),
  );
  await Promise.all(calls);
  state.cloneImplementation.initializedSlot = await rpc.request(
    "eth_getStorageAt",
    [c.cloneImplementation.address, "0x5", block],
  );

  const code = {};
  for (const [group, keys] of [
    ["contracts", Object.keys(c)],
    ["externalContracts", Object.keys(e)],
  ]) {
    for (const key of keys) {
      const address = manifest[group][key].address;
      const runtime = await rpc.request("eth_getCode", [address, block]);
      if (runtime === "0x")
        throw new Error(`${group}.${key}: no runtime code at reference block`);
      code[`${group}.${key}`] = keccak256(runtime);
    }
  }
  for (const [key, safe] of [
    ["governanceSafe", manifest.actors.governanceSafe],
    ["emergencySafe", manifest.actors.emergencySafe],
  ]) {
    const runtime = await rpc.request("eth_getCode", [safe.address, block]);
    if (runtime === "0x")
      throw new Error(`actors.${key}: no runtime code at reference block`);
    code[`actors.${key}`] = keccak256(runtime);
  }
  return { state, code };
}

async function readRoleLogs(rpc, manifest, block) {
  const last = Number(BigInt(block));
  const logs = [];
  for (
    let first = manifest.contracts.timelock.deploymentBlock;
    first <= last;
    first += 2_000
  ) {
    const end = Math.min(first + 1_999, last);
    logs.push(
      ...(await rpc.request("eth_getLogs", [
        {
          address: manifest.contracts.timelock.address,
          fromBlock: hexBlock(first),
          toBlock: hexBlock(end),
          topics: [[ROLE_GRANTED, ROLE_REVOKED]],
        },
      ])),
    );
  }
  return logs
    .map((log) => ({
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: lower(log.transactionHash),
      logIndex: Number(BigInt(log.logIndex)),
      event:
        lower(log.topics[0]) === lower(ROLE_GRANTED) ? "granted" : "revoked",
      role: lower(log.topics[1]),
      account: `0x${log.topics[2].slice(-40)}`.toLowerCase(),
      sender: `0x${log.topics[3].slice(-40)}`.toLowerCase(),
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function reconstructRoles(logs) {
  const sets = Object.fromEntries(
    Object.entries(ROLE_IDS).map(([key]) => [key, new Set()]),
  );
  const byId = Object.fromEntries(
    Object.entries(ROLE_IDS).map(([key, value]) => [lower(value), key]),
  );
  for (const log of logs) {
    const name = byId[log.role];
    if (!name) continue;
    if (log.event === "granted") sets[name].add(log.account);
    else sets[name].delete(log.account);
  }
  return Object.fromEntries(
    Object.entries(sets).map(([key, value]) => [key, [...value].sort()]),
  );
}

function assertDeploymentState(manifest, snapshot, roleLogs) {
  const { state, code } = snapshot;
  const c = manifest.contracts;
  const e = manifest.externalContracts;
  for (const [key, expected] of Object.entries({
    ...c,
    ...Object.fromEntries(
      Object.entries(e).map(([k, v]) => [`external:${k}`, v]),
    ),
  })) {
    const path = key.startsWith("external:")
      ? `externalContracts.${key.slice(9)}`
      : `contracts.${key}`;
    assertEqual(
      code[path],
      expected.runtimeCodehash,
      `${path}.runtimeCodehash`,
    );
  }
  for (const key of ["governanceSafe", "emergencySafe"])
    assertEqual(
      code[`actors.${key}`],
      manifest.actors[key].runtimeCodehash,
      `actors.${key}.runtimeCodehash`,
    );
  const expectedFactory = {
    governance: c.timelock.address,
    config: c.config.address,
    emergencyController: c.emergencyController.address,
    exposureGuard: c.exposureGuard.address,
    bondEscrow: c.bondEscrow.address,
    feeVault: c.feeVault.address,
    fullMarketDeployer: c.fullMarketDeployer.address,
    cloneImplementation: c.cloneImplementation.address,
    paymentToken: e.usdc.address,
    permit2: e.permit2.address,
    marketplace: c.marketplace.address,
    active: true,
    deprecated: false,
    activationFingerprint: manifest.bootstrap.factoryActivationFingerprint,
    dependencyFingerprint: manifest.bootstrap.factoryActivationFingerprint,
    [`dependencyFingerprintFor:${lower(c.marketplace.address)}`]:
      manifest.bootstrap.factoryActivationFingerprint,
  };
  for (const [key, value] of Object.entries(expectedFactory))
    assertEqual(state.factory[key], value, `factory.${key}`);
  const cfg = manifest.configuration;
  const expectedConfig = {
    governance: c.timelock.address,
    paymentToken: e.usdc.address,
    protocolTreasury: manifest.actors.protocolTreasury,
    creationFee: BigInt(cfg.creationFee),
    protocolShareBps: cfg.protocolShareBps,
    earlyBirdShareBps: cfg.earlyBirdShareBps,
    platformC2CFeeBps: cfg.platformC2CFeeBps,
    maxCreatorRakeBps: cfg.maxCreatorRakeBps,
    maxCreatorC2CFeeBps: cfg.maxCreatorC2CFeeBps,
    maxFullMarketCap: BigInt(cfg.maxFullMarketCap),
    maxCloneMarketCap: BigInt(cfg.maxCloneMarketCap),
    maxPerUserPrimaryCap: BigInt(cfg.maxPerUserPrimaryCap),
  };
  for (const [key, value] of Object.entries(expectedConfig))
    assertEqual(state.config[key], value, `config.${key}`);
  for (const [key, value] of Object.entries({
    governance: c.timelock.address,
    emergencySafe: manifest.actors.emergencySafe.address,
    pausedFlags: 0n,
  }))
    assertEqual(
      state.emergencyController[key],
      value,
      `emergencyController.${key}`,
    );
  for (const [key, value] of Object.entries({
    governance: c.timelock.address,
    factory: c.factory.address,
    exposureCap: BigInt(cfg.initialExposureCap),
    retired: false,
  }))
    assertEqual(state.exposureGuard[key], value, `exposureGuard.${key}`);
  for (const target of ["feeVault", "bondEscrow"]) {
    for (const [key, value] of Object.entries({
      governance: c.timelock.address,
      paymentToken: e.usdc.address,
      factory: c.factory.address,
    }))
      assertEqual(state[target][key], value, `${target}.${key}`);
  }
  assertEqual(
    state.feeVault[`authorizedAccruer:${lower(c.factory.address)}`],
    true,
    "feeVault factory authorization",
  );
  assertEqual(
    state.feeVault[`authorizedAccruer:${lower(c.marketplace.address)}`],
    true,
    "feeVault marketplace authorization",
  );
  for (const [key, value] of Object.entries({
    governance: c.timelock.address,
    factory: c.factory.address,
  }))
    assertEqual(
      state.fullMarketDeployer[key],
      value,
      `fullMarketDeployer.${key}`,
    );
  for (const [key, value] of Object.entries({
    factory: c.factory.address,
    emergencyController: c.emergencyController.address,
    feeVault: c.feeVault.address,
    paymentToken: e.usdc.address,
    permit2: e.permit2.address,
  }))
    assertEqual(state.marketplace[key], value, `marketplace.${key}`);
  for (const [key, value] of Object.entries({
    governance: c.timelock.address,
    emergencyController: c.emergencyController.address,
    entryPoint: e.entryPoint.address,
    sponsorSigner: manifest.actors.sponsorSigner,
    maxCostPerOperation: BigInt(cfg.paymasterMaxCostPerOperation),
    maxCostPerUserPerDay: BigInt(cfg.paymasterMaxCostPerUserDay),
    maxCostGlobalPerDay: BigInt(cfg.paymasterMaxCostGlobalDay),
    policyVersion: cfg.paymasterPolicyVersion,
  }))
    assertEqual(state.paymaster[key], value, `paymaster.${key}`);
  assertEqual(
    state.external.usdcDecimals,
    6,
    "externalContracts.usdc.decimals",
  );
  assertEqual(
    BigInt(state.cloneImplementation.initializedSlot),
    1n,
    "cloneImplementation locked initializer storage slot",
  );
  assertEqual(state.timelock.getMinDelay, 3600n, "timelock.getMinDelay");
  for (const [safeKey, safe] of [
    ["governanceSafe", manifest.actors.governanceSafe],
    ["emergencySafe", manifest.actors.emergencySafe],
  ]) {
    assertEqual(
      state.safes[`${safeKey}:threshold`],
      BigInt(safe.threshold),
      `${safeKey}.threshold`,
    );
    assertEqual(
      state.safes[`${safeKey}:owners`],
      safe.owners.map(lower).sort(),
      `${safeKey}.owners`,
    );
  }
  const reconstructed = reconstructRoles(roleLogs);
  for (const role of ["defaultAdmin", "proposer", "canceller", "executor"]) {
    assertEqual(
      reconstructed[role],
      manifest.roles[role].map(lower).sort(),
      `timelock ${role} role event reconstruction`,
    );
    for (const address of [
      c.timelock.address,
      manifest.actors.governanceSafe.address,
      manifest.actors.emergencySafe.address,
      manifest.actors.deployer,
      ZERO_ADDRESS,
    ]) {
      assertEqual(
        state.timelock[`hasRole:${role}:${lower(address)}`],
        reconstructed[role].includes(lower(address)),
        `timelock hasRole ${role} ${address}`,
      );
    }
  }
  return { roleEventsSha256: sha256Json(roleLogs) };
}

export async function verifyLiveRpc(manifest, rpcUrls) {
  validateFinalManifest(manifest, { allowPendingCanary: true });
  if (!Array.isArray(rpcUrls) || rpcUrls.length !== 2)
    throw new Error("exactly two independent RPC URLs are required");
  const endpoints = rpcUrls.map(endpointFingerprint);
  if (
    endpoints[0].sha256 === endpoints[1].sha256 ||
    endpoints[0].origin === endpoints[1].origin
  )
    throw new Error("RPC providers must have distinct URLs and origins");
  const rpcs = rpcUrls.map((url) => new Rpc(url));
  const blockTag = hexBlock(manifest.referenceBlock.number);
  const results = [];
  const finality = [];
  for (const rpc of rpcs) {
    const chainId = Number(BigInt(await rpc.request("eth_chainId", [])));
    if (chainId !== 421_614)
      throw new Error(`RPC chainId ${chainId} is not Arbitrum Sepolia`);
    const block = await rpc.request("eth_getBlockByNumber", [blockTag, false]);
    if (lower(block.hash) !== lower(manifest.referenceBlock.hash))
      throw new Error("RPC reference block hash mismatch");
    if (Number(BigInt(block.timestamp)) !== manifest.referenceBlock.timestamp)
      throw new Error("RPC reference block timestamp mismatch");
    if (
      Number(BigInt(block.l1BlockNumber)) !==
      manifest.referenceBlock.l1BlockNumber
    )
      throw new Error("RPC reference block L1 block number mismatch");
    const finalizedBlock = await rpc.request("eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    if (!finalizedBlock?.number || !finalizedBlock?.hash)
      throw new Error("RPC does not expose an Arbitrum finalized block");
    if (BigInt(finalizedBlock.number) < BigInt(blockTag))
      throw new Error("RPC reference block is not finalized on Arbitrum");
    const latest = await rpc.request("eth_blockNumber", []);
    if (
      BigInt(latest) - BigInt(blockTag) <
      BigInt(manifest.referenceBlock.confirmations)
    )
      throw new Error("RPC does not prove required confirmations");
    const snapshot = await readState(rpc, manifest, blockTag);
    const logs = await readRoleLogs(rpc, manifest, blockTag);
    results.push({
      chainId,
      block: {
        number: manifest.referenceBlock.number,
        hash: lower(block.hash),
        timestamp: Number(BigInt(block.timestamp)),
        l1BlockNumber: Number(BigInt(block.l1BlockNumber)),
      },
      snapshot,
      logs,
    });
    finality.push({
      providerSha256: endpoints[finality.length].sha256,
      finalizedBlockNumber: Number(BigInt(finalizedBlock.number)),
      finalizedBlockHash: lower(finalizedBlock.hash),
      finalizedL1BlockNumber: Number(BigInt(finalizedBlock.l1BlockNumber)),
    });
  }
  if (comparable(results[0]) !== comparable(results[1]))
    throw new Error("independent RPC results diverge at reference block");
  const stateValidation = assertDeploymentState(
    manifest,
    results[0].snapshot,
    results[0].logs,
  );
  const evidence = {
    schemaVersion: "cpredict.arbitrum-sepolia.rpc-verification.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    chainId: 421_614,
    referenceBlock: results[0].block,
    providers: endpoints,
    finality,
    roleEventsSha256: stateValidation.roleEventsSha256,
    stateSha256: sha256Json(results[0].snapshot),
  };
  const digest = createHash("sha256")
    .update(canonicalJson(evidence))
    .digest("hex");
  if (
    stateValidation.roleEventsSha256 !== manifest.roles.roleEventsSha256 ||
    digest !== manifest.referenceBlock.rpcEvidenceSha256
  ) {
    throw new Error(
      `evidence bindings mismatch; set roles.roleEventsSha256=${stateValidation.roleEventsSha256} and referenceBlock.rpcEvidenceSha256=${digest}, then rerun the strict verifier`,
    );
  }
  return { evidence, digest };
}

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "usage: ARBITRUM_SEPOLIA_RPC_URL_A=... ARBITRUM_SEPOLIA_RPC_URL_B=... node scripts/deployment/verify-live-rpc.mjs <final-manifest.json>",
    );
  const urls = [
    process.env.ARBITRUM_SEPOLIA_RPC_URL_A,
    process.env.ARBITRUM_SEPOLIA_RPC_URL_B,
  ];
  if (urls.some((url) => !url))
    throw new Error(
      "ARBITRUM_SEPOLIA_RPC_URL_A and ARBITRUM_SEPOLIA_RPC_URL_B are required",
    );
  const result = await verifyLiveRpc(await readJson(path), urls);
  process.stdout.write(
    `${JSON.stringify(result.evidence, null, 2)}\nPASS live RPC verification ${result.digest}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
