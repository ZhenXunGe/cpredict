#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import {
  validatePendingManifest,
  parseEnvText,
  validateBroadcastDocument,
} from "./deploy-arbitrum-sepolia.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const contractNames = {
  timelock: "TimelockController",
  config: "ProtocolConfigV1",
  emergencyController: "EmergencyControllerV1",
  exposureGuard: "LaunchExposureGuardV1",
  feeVault: "FeeVaultV1",
  bondEscrow: "BondEscrowV1",
  cloneImplementation: "CloneMarketVaultV1",
  fullMarketDeployer: "FullMarketDeployerV1",
  factory: "MarketFactoryV1",
  marketplace: "FixedPriceMarketplaceV1",
  paymaster: "SponsorshipPaymasterV1",
};
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export async function buildTimeV2Runtime({
  previous,
  pending,
  sourceCommit,
  deploymentBlock,
  runtimeCodeHashes,
}) {
  const { appRuntimeSchema } = await import(
    "../../dist/offchain/app-service/src/config.js"
  );
  const { assertDeploymentRollover } = await import(
    "../../dist/offchain/app-service/src/deployment-rollover.js"
  );
  const original = appRuntimeSchema.parse(previous);
  const d = validatePendingManifest(structuredClone(pending), {
    profile: "sandbox",
  });
  assert(
    d.paymentTokenReused === true &&
      equal(d.usdc, original.environment.deployment.paymentToken),
    "new deployment must reuse the current ctUSD",
  );
  assert(
    equal(
      d.paymentTokenRuntimeCodehash,
      runtimeCodeHashes[d.usdc.toLowerCase()],
    ),
    "ctUSD runtime hash mismatch",
  );
  const result = appRuntimeSchema.parse({
    ...original,
    environment: {
      ...original.environment,
      deployment: {
        id: `ctusd-421614-${d.factory.slice(2).toLowerCase()}`,
        protocolVersion: "time-v2",
        manifestHash: `0x${digest(JSON.stringify({ pending: d, sourceCommit, deploymentBlock, runtimeCodeHashes }))}`,
        sourceCommit,
        chainId: 421614,
        deploymentBlock,
        factory: d.factory,
        marketplace: d.marketplace,
        bondEscrow: d.bondEscrow,
        feeVault: d.feeVault,
        paymentToken: d.usdc,
        protocolTreasury: d.protocolTreasury,
        runtimeCodeHashes,
      },
    },
    minimumOperationBlock: deploymentBlock,
  });
  assertDeploymentRollover(original.environment, result.environment);
  return result;
}

/** Accepts only receipts bound to the pinned local creation bytecode. Runtime
 * links and successful live receipts are checked separately by the CLI. */
export async function verifyCreationInputs(pending, broadcast, readArtifact) {
  validateBroadcastDocument(broadcast, 12);
  for (const [key, name] of Object.entries(contractNames)) {
    const tx = broadcast.transactions?.find(
      (t) =>
        t.transactionType === "CREATE" &&
        equal(t.contractAddress, pending[key]),
    );
    assert(
      tx?.contractName === name,
      `missing creation transaction for ${name}`,
    );
    const artifact = await readArtifact(name);
    const code = artifact.bytecode?.object;
    assert(
      typeof code === "string" &&
        code.length > 10 &&
        tx.transaction?.input?.startsWith(code),
      `${name}: creation bytecode does not match current source`,
    );
    assert(
      broadcast.receipts.some(
        (r) =>
          equal(r.transactionHash, tx.hash) &&
          equal(r.contractAddress, pending[key]),
      ),
      `${name}: receipt mismatch`,
    );
  }
  assert(
    !broadcast.transactions.some(
      (t) =>
        t.transactionType === "CREATE" &&
        equal(t.contractAddress, pending.usdc),
    ),
    "ctUSD must be reused, not recreated",
  );
}

async function main() {
  const { values: v } = parseArgs({
    options: Object.fromEntries(
      ["previous", "state", "pending", "provider-env", "output"].map((k) => [
        k,
        { type: "string" },
      ]),
    ),
  });
  for (const key of ["previous", "state", "pending", "provider-env", "output"])
    assert(v[key], `--${key} required`);
  const readJson = async (p) => JSON.parse(await readFile(resolve(p), "utf8"));
  const previous = await readJson(v.previous),
    state = await readJson(v.state),
    pending = await readJson(v.pending);
  assert(
    state.status === "FINALIZED_PENDING_EVIDENCE_VERIFICATION" &&
      !state.source?.dirty,
    "requires finalized deployment from a clean source revision",
  );
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert(
    head.status === 0 && head.stdout.trim() === state.source.commit,
    "checkout differs from deployment source",
  );
  assert(
    digest(await readFile("manifests/source-manifest.json")) ===
      state.source.sourceManifestSha256,
    "source manifest differs from deployment source",
  );
  const documents = [];
  for (const evidence of [state.deploymentBroadcast, state.finalizeBroadcast]) {
    const bytes = await readFile(evidence.path);
    assert(
      digest(bytes) === evidence.sha256,
      "broadcast evidence digest mismatch",
    );
    const document = JSON.parse(bytes);
    validateBroadcastDocument(document, 1);
    documents.push(document);
  }
  await verifyCreationInputs(pending, documents[0], (name) =>
    readJson(`out/${name}.sol/${name}.json`),
  );
  const provider = parseEnvText(await readFile(v["provider-env"], "utf8"));
  assert(
    provider.CPREDICT_APP_RPC_URL,
    "provider file is missing CPREDICT_APP_RPC_URL",
  );
  const client = createPublicClient({
    transport: http(provider.CPREDICT_APP_RPC_URL, {
      retryCount: 0,
      timeout: 20000,
    }),
  });
  assert((await client.getChainId()) === 421614, "wrong chain");
  const receipts = [];
  for (const receipt of documents.flatMap((d) => d.receipts)) {
    const live = await client.getTransactionReceipt({
      hash: receipt.transactionHash,
    });
    assert(
      live.status === "success" && equal(live.blockHash, receipt.blockHash),
      "receipt not canonical or failed",
    );
    receipts.push({
      transactionHash: live.transactionHash,
      blockNumber: live.blockNumber.toString(),
      blockHash: live.blockHash,
    });
  }
  const addresses = [
    pending.factory,
    pending.marketplace,
    pending.bondEscrow,
    pending.feeVault,
    pending.usdc,
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      addresses.map(async (address) => {
        const code = await client.getCode({ address });
        assert(code && code !== "0x", "deployed code missing");
        return [address.toLowerCase(), keccak256(code)];
      }),
    ),
  );
  const abi = parseAbi([
    "function active() view returns(bool)",
    "function activationFingerprint() view returns(bytes32)",
    "function resolutionWindow() view returns(uint64)",
  ]);
  assert(
    await client.readContract({
      address: pending.factory,
      abi,
      functionName: "active",
    }),
    "factory is not active",
  );
  assert(
    equal(
      await client.readContract({
        address: pending.factory,
        abi,
        functionName: "activationFingerprint",
      }),
      pending.factoryActivationFingerprint,
    ),
    "activation fingerprint mismatch",
  );
  assert(
    (await client.readContract({
      address: pending.factory,
      abi,
      functionName: "resolutionWindow",
    })) === BigInt(pending.marketResolutionWindowSeconds),
    "resolution window mismatch",
  );
  const deploymentBlock = receipts
    .reduce(
      (n, r) => (BigInt(r.blockNumber) < n ? BigInt(r.blockNumber) : n),
      BigInt(receipts[0].blockNumber),
    )
    .toString();
  const runtime = await buildTimeV2Runtime({
    previous,
    pending,
    sourceCommit: state.source.commit,
    deploymentBlock,
    runtimeCodeHashes: hashes,
  });
  const { verifyDeployment } = await import(
    "../../dist/offchain/app-service/src/chain.js"
  );
  await verifyDeployment(client, runtime.environment);
  const output = resolve(v.output);
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    resolve(output, "ctusd.runtime.json"),
    JSON.stringify(runtime, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    resolve(output, "site-config.json"),
    JSON.stringify(
      {
        version: 1,
        defaultEnvironment: runtime.environment.id,
        environments: [runtime.environment],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  await writeFile(
    resolve(output, "chain-evidence.json"),
    JSON.stringify(
      {
        sourceCommit: state.source.commit,
        deployment: runtime.environment.deployment,
        receipts,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  console.log(
    JSON.stringify({
      output,
      deploymentId: runtime.environment.deployment.id,
      deploymentBlock,
      receipts: receipts.length,
      status: "prepared-not-activated-on-site",
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error?.shortMessage ??
        "time-v2 preparation failed; inspect inputs without exposing provider URLs",
    );
    process.exitCode = 1;
  });
}
