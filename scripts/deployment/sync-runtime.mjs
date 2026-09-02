#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import {
  CHAIN_ID,
  CANONICAL_USDC_KIND,
  ENTRY_POINT,
  PERMIT2,
  SANDBOX_TOKEN_KIND,
  USDC,
  validatePendingManifest,
} from "./deploy-arbitrum-sepolia.mjs";
import {
  canonicalJson,
  readJson,
  sha256Json,
} from "./evidence-lib.mjs";
import { validateCanaryEvidence } from "./validate-canary-evidence.mjs";
import { validateFinalManifest } from "./validate-final-manifest.mjs";
import { validateOpsEvidence } from "./validate-ops-evidence.mjs";
import { validateSourceVerificationEvidence } from "./validate-source-verification.mjs";
import { verifyLiveRpc } from "./verify-live-rpc.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_BOUNDARY = resolve(ROOT, "runtime/arbitrum-sepolia");
const CONTRACT_KEYS = [
  "timelock",
  "config",
  "emergencyController",
  "exposureGuard",
  "feeVault",
  "bondEscrow",
  "cloneImplementation",
  "fullMarketDeployer",
  "factory",
  "marketplace",
  "paymaster",
];

const PAYMENT_TOKENS = Object.freeze({
  [CANONICAL_USDC_KIND]: Object.freeze({
    kind: CANONICAL_USDC_KIND,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    faucetEnabled: false,
    faucetAmount: "0",
  }),
  [SANDBOX_TOKEN_KIND]: Object.freeze({
    kind: SANDBOX_TOKEN_KIND,
    name: "Cpredict Test USD",
    symbol: "ctUSD",
    decimals: 6,
    faucetEnabled: true,
    faucetAmount: "10000000000",
  }),
});

export function parseSyncArgs(argv) {
  if (argv.length === 0 || !["candidate", "final"].includes(argv[0]))
    throw new Error("usage: deploy:sync -- candidate|final [options] [--permit2-relay]");
  const output = { mode: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--permit2-relay") {
      if (output.permit2RelayEnabled === true)
        throw new Error(`duplicate option ${flag}`);
      output.permit2RelayEnabled = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag}: missing value`);
    const key = {
      "--pending": "pending",
      "--manifest": "manifest",
      "--deployment-block": "deploymentBlock",
      "--broadcast": "broadcast",
      "--canary-evidence": "canaryEvidence",
      "--ops-evidence": "opsEvidence",
      "--source-verification-evidence": "sourceVerificationEvidence",
      "--rpc-a": "rpcA",
      "--rpc-b": "rpcB",
      "--output": "output",
    }[flag];
    if (key === undefined) throw new Error(`unknown option ${flag}`);
    if (Object.hasOwn(output, key)) throw new Error(`duplicate option ${flag}`);
    output[key] = value;
  }
  return output;
}

export function buildRuntimePackage({ mode, deployment, deploymentBlock, inputSha256, permit2RelayEnabled = false }) {
  if (deployment.chainId !== CHAIN_ID) throw new Error(`deployment chainId must equal ${CHAIN_ID}`);
  if (mode === "candidate" && deployment.status !== "BOOTSTRAP_SCHEDULED_NOT_FINAL")
    throw new Error("candidate package requires BOOTSTRAP_SCHEDULED_NOT_FINAL input");
  if (mode === "final" && deployment.status !== "FINALIZED_VERIFIED")
    throw new Error("final package requires FINALIZED_VERIFIED input");
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1)
    throw new Error("deploymentBlock must be a positive safe integer");
  const finalMode = mode === "final";
  const paymentTokenKind = finalMode
    ? CANONICAL_USDC_KIND
    : deployment.paymentTokenKind;
  const paymentToken = PAYMENT_TOKENS[paymentTokenKind];
  if (paymentToken === undefined)
    throw new Error("candidate paymentTokenKind must be canonical-usdc or sandbox-test-token");
  const sourceManifestSha256 = finalMode
    ? deployment.source.sourceManifestSha256
    : deployment.sourceManifestSha256;
  const addresses = finalMode
    ? Object.fromEntries(CONTRACT_KEYS.map((key) => [key, deployment.contracts[key].address]))
    : Object.fromEntries(CONTRACT_KEYS.map((key) => [key, deployment[key]]));
  const external = finalMode
    ? Object.fromEntries(
        ["usdc", "permit2", "entryPoint"].map((key) => [
          key,
          deployment.externalContracts[key].address,
        ]),
      )
    : { usdc: deployment.usdc, permit2: deployment.permit2, entryPoint: deployment.entryPoint };
  const actors = finalMode
    ? {
        governanceSafe: deployment.actors.governanceSafe.address,
        emergencySafe: deployment.actors.emergencySafe.address,
        sponsorSigner: deployment.actors.sponsorSigner,
      }
    : {
        governanceSafe: deployment.governanceSafe,
        emergencySafe: deployment.emergencySafe,
        sponsorSigner: deployment.sponsorSigner,
      };
  const budgets = finalMode
    ? {
        policyVersion: deployment.configuration.paymasterPolicyVersion,
        request: deployment.configuration.paymasterMaxCostPerOperation,
        userDay: deployment.configuration.paymasterMaxCostPerUserDay,
        globalDay: deployment.configuration.paymasterMaxCostGlobalDay,
      }
    : {
        policyVersion: deployment.paymasterPolicyVersion,
        request: deployment.paymasterMaxCostPerOperation,
        userDay: deployment.paymasterMaxCostPerUserDay,
        globalDay: deployment.paymasterMaxCostGlobalDay,
      };
  const normalizedAddresses = Object.fromEntries(
    Object.entries(addresses).map(([key, value]) => [key, getAddress(value)]),
  );
  const normalizedExternal = Object.fromEntries(
    Object.entries(external).map(([key, value]) => [key, getAddress(value)]),
  );
  const identity = sha256Json({
    chainId: CHAIN_ID,
    mode,
    factory: normalizedAddresses.factory,
    inputSha256,
    sourceManifestSha256,
    permit2RelayEnabled,
  }).slice(0, 24);
  const runtimeRoot = `runtime/arbitrum-sepolia/${identity}`;
  const runtimeConfig = {
    schemaVersion: "cpredict.web-demo.runtime.v1",
    chain: {
      id: CHAIN_ID,
      name: "Arbitrum Sepolia",
      rpcPath: "/rpc",
      explorerOrigin: "https://sepolia.arbiscan.io",
    },
    deployment: {
      manifestPath: finalMode
        ? "/deployment/final.json"
        : "/deployment/debug-addresses.json",
      requiredStatus: "FINALIZED_VERIFIED",
      allowDebugAddresses: !finalMode,
    },
    paymentToken,
    indexer: { enabled: true, basePath: "/indexer" },
    metadata: { enabled: true, basePath: "/metadata" },
    permit2Relay: { enabled: permit2RelayEnabled, basePath: "/relay" },
    evidence: { uploadEnabled: false, endpointPath: "/evidence" },
  };
  const deploymentAddresses = {
    schemaVersion: "cpredict.deployment-addresses.v1",
    mode: finalMode ? "FINALIZED_VERIFIED" : "DEBUG",
    chainId: CHAIN_ID,
    deploymentIdentity: identity,
    sourceManifestSha256,
    deploymentBlock,
    contracts: normalizedAddresses,
    externalContracts: normalizedExternal,
    paymentToken,
    actors: Object.fromEntries(
      Object.entries(actors).map(([key, value]) => [key, getAddress(value)]),
    ),
  };
  const composeValues = {
    CPREDICT_STACK_RUNTIME_ROOT: runtimeRoot,
    CPREDICT_INDEXER_FACTORY_ADDRESS: normalizedAddresses.factory,
    CPREDICT_INDEXER_CORE_ADDRESSES: [
      normalizedAddresses.factory,
      normalizedAddresses.marketplace,
    ].join(","),
    CPREDICT_INDEXER_DEPLOYMENT_BLOCK: String(deploymentBlock),
    CPREDICT_PAYMASTER_ENTRY_POINT: normalizedExternal.entryPoint,
    CPREDICT_PAYMASTER_ADDRESS: normalizedAddresses.paymaster,
    CPREDICT_PAYMASTER_EXPECTED_SIGNER: getAddress(actors.sponsorSigner),
    CPREDICT_PAYMASTER_POLICY_VERSION: String(budgets.policyVersion),
    CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST: String(budgets.request),
    CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY: String(budgets.userDay),
    CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY: String(budgets.globalDay),
    CPREDICT_RELAY_FACTORY_ADDRESS: normalizedAddresses.factory,
    CPREDICT_RELAY_PAYMENT_ASSET_ADDRESS: normalizedExternal.usdc,
    CPREDICT_RELAY_PERMIT2_ADDRESS: normalizedExternal.permit2,
  };
  const files = {
    "web-demo/runtime-config.json": prettyJson(runtimeConfig),
    "sdk/deployment-addresses.json": prettyJson(deploymentAddresses),
    "indexer/deployment.json": prettyJson({
      schemaVersion: "cpredict.indexer-deployment.v1",
      chainId: CHAIN_ID,
      factory: normalizedAddresses.factory,
      coreAddresses: [normalizedAddresses.factory, normalizedAddresses.marketplace],
      deploymentBlock,
      sourceManifestSha256,
    }),
    "paymaster/deployment.json": prettyJson({
      schemaVersion: "cpredict.paymaster-deployment.v1",
      chainId: CHAIN_ID,
      entryPoint: normalizedExternal.entryPoint,
      paymaster: normalizedAddresses.paymaster,
      signer: getAddress(actors.sponsorSigner),
      budgets,
      sourceManifestSha256,
    }),
    "compose.env": envText(composeValues),
  };
  if (finalMode) files["web-demo/deployment/final.json"] = prettyJson(deployment);
  else {
    files["web-demo/deployment/debug-addresses.json"] = prettyJson({
      ...deploymentAddresses,
      status: "DEBUG_NOT_FINALIZED",
      warning: "Candidate addresses require live code and wiring checks; this is not final evidence.",
    });
    files["HUMAN-REVIEW.md"] = candidateChecklist(deploymentAddresses);
  }
  const fileHashes = Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, contents]) => [path, sha256Text(contents)]),
  );
  const packageManifest = {
    schemaVersion: "cpredict.runtime-package.v1",
    mode: finalMode ? "FINALIZED_VERIFIED" : "DEBUG",
    chainId: CHAIN_ID,
    deploymentIdentity: identity,
    sourceManifestSha256,
    inputSha256,
    generatedAt: new Date().toISOString(),
    files: fileHashes,
  };
  files["package-manifest.json"] = prettyJson(packageManifest);
  return { identity, runtimeRoot, composeValues, files, packageManifest };
}

export async function writeRuntimePackage(pkg, {
  outputRoot = RUNTIME_BOUNDARY,
  runtimeBoundary = RUNTIME_BOUNDARY,
} = {}) {
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalBoundary = await realpath(resolve(runtimeBoundary));
  const canonicalRoot = await realpath(root);
  assertWithin(canonicalRoot, canonicalBoundary, "output root");
  const destination = resolve(canonicalRoot, pkg.identity);
  assertWithin(destination, canonicalRoot, "deployment package");
  try {
    const existing = await readJson(resolve(destination, "package-manifest.json"));
    if (existing.inputSha256 !== pkg.packageManifest.inputSha256)
      throw new Error(`${destination}: existing package has a different input SHA-256`);
    await writeCurrentEnv(canonicalRoot, pkg.composeValues);
    return { directory: destination, idempotent: true };
  } catch (error) {
    if (error.message.includes("different input")) throw error;
  }
  const staging = resolve(canonicalRoot, `.staging-${pkg.identity}-${process.pid}`);
  assertWithin(staging, canonicalRoot, "staging directory");
  await rm(staging, { recursive: true, force: true });
  try {
    for (const [path, contents] of Object.entries(pkg.files)) {
      const target = resolve(staging, path);
      assertWithin(target, staging, `runtime output ${path}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, contents, { mode: 0o644, flag: "wx" });
    }
    await rename(staging, destination);
    await writeCurrentEnv(canonicalRoot, pkg.composeValues);
    return { directory: destination, idempotent: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseSyncArgs(argv);
  const localSourceManifestPath = resolve(ROOT, "manifests/source-manifest.json");
  const localSourceManifestSha256 = await sha256File(localSourceManifestPath);
  let deployment;
  let deploymentBlock;
  let inputSha256;
  if (options.mode === "candidate") {
    if (!options.pending) throw new Error("candidate requires --pending <pending.json>");
    deployment = validatePendingManifest(await readJson(resolveInput(options.pending)));
    deployment.sourceManifestSha256 = localSourceManifestSha256;
    deploymentBlock = await resolveDeploymentBlock(options);
    inputSha256 = await sha256File(resolveInput(options.pending));
  } else {
    for (const key of ["manifest", "canaryEvidence", "opsEvidence", "sourceVerificationEvidence", "rpcA", "rpcB"])
      if (!options[key]) throw new Error(`final requires --${camelToKebab(key)} <value>`);
    deployment = await readJson(resolveInput(options.manifest));
    validateFinalManifest(deployment);
    if (deployment.source.sourceManifestSha256 !== localSourceManifestSha256)
      throw new Error("final manifest sourceManifestSha256 does not match the current source manifest");
    const canary = await readJson(resolveInput(options.canaryEvidence));
    const ops = await readJson(resolveInput(options.opsEvidence));
    const sourceVerification = await readJson(resolveInput(options.sourceVerificationEvidence));
    const canaryResult = validateCanaryEvidence(canary);
    const opsResult = validateOpsEvidence(ops);
    const sourceResult = await validateSourceVerificationEvidence(
      sourceVerification,
      deployment,
      resolveInput(options.sourceVerificationEvidence),
    );
    if (canonicalJson(sourceResult.manifestRecords) !== canonicalJson(deployment.sourceVerification))
      throw new Error("source verification evidence does not match final manifest records");
    if (canaryResult.sha256 !== deployment.canaryEvidence.evidenceSha256)
      throw new Error("canary evidence SHA-256 does not match final manifest");
    await verifyLiveRpc(deployment, [options.rpcA, options.rpcB]);
    deploymentBlock = Math.min(
      ...CONTRACT_KEYS.map((key) => deployment.contracts[key].deploymentBlock),
    );
    inputSha256 = sha256Json({
      manifest: await sha256File(resolveInput(options.manifest)),
      canary: canaryResult.sha256,
      ops: opsResult.sha256,
      sourceVerification: sourceResult.sha256,
    });
  }
  const pkg = buildRuntimePackage({
    mode: options.mode,
    deployment,
    deploymentBlock,
    inputSha256,
    permit2RelayEnabled: options.permit2RelayEnabled === true,
  });
  const result = await writeRuntimePackage(pkg, {
    outputRoot: options.output ? resolveInput(options.output) : RUNTIME_BOUNDARY,
  });
  process.stdout.write(
    `${options.mode.toUpperCase()} runtime package ${result.directory}${result.idempotent ? " (idempotent)" : ""}\n`,
  );
}

async function resolveDeploymentBlock(options) {
  if (options.deploymentBlock !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.deploymentBlock))
      throw new Error("--deployment-block must be a positive integer");
    const value = Number(options.deploymentBlock);
    if (!Number.isSafeInteger(value)) throw new Error("deployment block is outside safe integer range");
    return value;
  }
  let broadcastPath = options.broadcast;
  if (!broadcastPath) {
    const statePath = resolve(ROOT, "deployments/arbitrum-sepolia/runtime/state.json");
    try {
      const state = await readJson(statePath);
      broadcastPath = state.deploymentBroadcast?.path;
    } catch {
      // The actionable error below is intentionally stable.
    }
  }
  if (!broadcastPath)
    throw new Error("candidate needs --deployment-block or a Foundry --broadcast receipt file");
  const broadcast = await readJson(resolveInput(broadcastPath));
  if (!Array.isArray(broadcast.receipts) || broadcast.receipts.length === 0)
    throw new Error("broadcast receipt file must contain receipts[]");
  const blocks = broadcast.receipts.map((receipt, index) => {
    const raw = receipt.blockNumber;
    const value = typeof raw === "string" && raw.startsWith("0x") ? Number(BigInt(raw)) : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`broadcast receipt[${index}].blockNumber is invalid`);
    return value;
  });
  return Math.min(...blocks);
}

async function writeCurrentEnv(root, values) {
  const path = resolve(root, "current.env");
  const temporary = resolve(root, `.current.env.${process.pid}.tmp`);
  await writeFile(temporary, envText(values), { mode: 0o644 });
  await rename(temporary, path);
}

function candidateChecklist(addresses) {
  return `# Arbitrum Sepolia DEBUG candidate\n\n` +
    `${addresses.paymentToken.kind === SANDBOX_TOKEN_KIND ? "WARNING: This candidate uses unrestricted-mint ctUSD for demonstrations only. It is not USDC and has no monetary value.\n\n" : ""}` +
    `This package is not finalized runtime evidence. Before final sync:\n\n` +
    `- [ ] Verify both independent RPC origins, codehashes and deployment blocks.\n` +
    `- [ ] Verify Factory wiring and activation fingerprint.\n` +
    `- [ ] Finalize Timelock bootstrap and revoke temporary deployer roles.\n` +
    `- [ ] Verify all 11 Cpredict contracts on Arbiscan.\n` +
    `- [ ] Complete the real three-wallet and 24-hour timeout canary.\n` +
    `- [ ] Complete ops evidence and regenerate with deploy:sync final.\n\n` +
    `Factory: ${addresses.contracts.factory}\n`;
}

function envText(values) {
  return `${Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n")}\n`;
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256Text(await readFile(path));
}

function resolveInput(path) {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function assertWithin(path, parent, label) {
  const child = relative(parent, path);
  if (child === "" || child === ".") return;
  if (child.startsWith("..") || isAbsolute(child))
    throw new Error(`${label} escapes its allowed directory`);
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
