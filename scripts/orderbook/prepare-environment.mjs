#!/usr/bin/env node
// Read-only candidate preparation; never updates a live site-config or sends transactions.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import {
  environmentSchema,
  sameAddress,
  secureUrl,
} from "../../dist/offchain/app-core/src/contracts.js";
import { verifyDeployment } from "../../dist/offchain/app-service/src/chain.js";
import { validatePendingManifest } from "../deployment/deploy-arbitrum-sepolia.mjs";

const factoryAbi = parseAbi([
  "function active() view returns(bool)",
  "function activationFingerprint() view returns(bytes32)",
]);
const recoveryAbi = parseAbi([
  "function receiverRecoveryVersion() pure returns(uint256)",
]);
const policyAbi = parseAbi([
  "function factory() view returns(address)",
  "function marketplace() view returns(address)",
  "function paymentToken() view returns(address)",
  "function bondEscrow() view returns(address)",
  "function feeVault() view returns(address)",
  "function paymaster() view returns(address)",
]);
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildCandidate({
  template,
  pending,
  sourceCommit,
  deploymentBlock,
  id,
  prefix,
  codeHashes,
}) {
  const previous = environmentSchema.parse(template);
  validatePendingManifest(pending);
  if (pending.marketplaceVersion !== "orderbook-v2")
    throw Error("orderbook_version_required");
  if (sameAddress(previous.deployment.factory, pending.factory))
    throw Error("new_factory_required");
  if (!sameAddress(previous.deployment.paymentToken, pending.usdc))
    throw Error("payment_asset_must_be_preserved");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw Error("source_commit_required");
  if (!/^[1-9][0-9]*$/.test(deploymentBlock))
    throw Error("deployment_block_required");
  if (
    !/^\/[a-zA-Z0-9_-]+$/.test(prefix) ||
    Object.values(previous.services).some(
      (p) => p === prefix || p.startsWith(`${prefix}/`),
    )
  )
    throw Error("distinct_service_prefix_required");
  if (id === previous.id) throw Error("distinct_environment_id_required");
  for (const value of [
    pending.factory,
    pending.marketplace,
    pending.bondEscrow,
    pending.feeVault,
    pending.usdc,
    pending.tradingSessionPolicy,
  ])
    if (!/^0x[0-9a-f]{64}$/.test(codeHashes[value.toLowerCase()] ?? ""))
      throw Error("verified_code_hash_required");
  return environmentSchema.parse({
    ...previous,
    id,
    label: `${previous.asset} 求购撮合演练`,
    historical: false,
    deployment: {
      ...previous.deployment,
      id,
      protocolVersion: "time-v2",
      marketplaceVersion: "orderbook-v2",
      orderbookReceiverRecovery: true,
      sourceCommit,
      deploymentBlock,
      manifestHash: `0x${sha(pending)}`,
      factory: pending.factory,
      marketplace: pending.marketplace,
      bondEscrow: pending.bondEscrow,
      feeVault: pending.feeVault,
      paymentToken: pending.usdc,
      protocolTreasury: pending.protocolTreasury,
      runtimeCodeHashes: codeHashes,
    },
    services: Object.fromEntries(
      ["app", "indexer", "metadata", "rpc"].map((k) => [k, `${prefix}/${k}`]),
    ),
    features: {
      ...previous.features,
      automaticClaims: true,
      newExposure: false,
      faucet: false,
    },
    quickTrading: previous.quickTrading
      ? {
          ...previous.quickTrading,
          enabled: false,
          policy: pending.tradingSessionPolicy,
          policyCodeHash:
            codeHashes[pending.tradingSessionPolicy.toLowerCase()],
          paymaster: pending.tradingSessionPaymaster,
        }
      : undefined,
  });
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ""),
      value = args[i + 1];
    if (
      ![
        "pending",
        "template",
        "source-commit",
        "deployment-block",
        "id",
        "prefix",
        "output",
      ].includes(key) ||
      !value ||
      options[key]
    )
      throw Error("invalid_candidate_arguments");
    options[key] = value;
  }
  if (Object.keys(options).length !== 7)
    throw Error("all_candidate_arguments_required");
  const rpcUrl = secureUrl.parse(process.env.CPREDICT_ORDERBOOK_VERIFY_RPC_URL);
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: 8000 }),
  });
  if ((await client.getChainId()) !== 421614) throw Error("rpc_chain_mismatch");
  const pending = validatePendingManifest(
    JSON.parse(await readFile(options.pending, "utf8")),
  );
  if (pending.marketplaceVersion !== "orderbook-v2")
    throw Error("orderbook_version_required");
  const template = JSON.parse(await readFile(options.template, "utf8"));
  const head = await client.getBlock({ blockTag: "latest" });
  if (BigInt(options["deployment-block"]) > head.number)
    throw Error("deployment_block_in_future");
  const codeHashes = {};
  for (const address of [
    pending.factory,
    pending.marketplace,
    pending.bondEscrow,
    pending.feeVault,
    pending.usdc,
    pending.tradingSessionPolicy,
    pending.tradingSessionPaymaster,
  ]) {
    const code = await client.getCode({ address, blockNumber: head.number });
    if (!code || code === "0x") throw Error("deployment_contract_missing");
    codeHashes[address.toLowerCase()] = keccak256(code);
  }
  if (
    codeHashes[pending.tradingSessionPaymaster.toLowerCase()] !==
    pending.tradingSessionPaymasterCodehash.toLowerCase()
  )
    throw Error("session_paymaster_codehash_mismatch");
  if (
    (await client.readContract({
      address: pending.marketplace,
      abi: recoveryAbi,
      functionName: "receiverRecoveryVersion",
      blockNumber: head.number,
    })) !== 1n
  )
    throw Error("receiver_recovery_contract_required");
  if (
    !(await client.readContract({
      address: pending.factory,
      abi: factoryAbi,
      functionName: "active",
      blockNumber: head.number,
    }))
  )
    throw Error("factory_bootstrap_incomplete");
  if (
    (
      await client.readContract({
        address: pending.factory,
        abi: factoryAbi,
        functionName: "activationFingerprint",
        blockNumber: head.number,
      })
    ).toLowerCase() !== pending.factoryActivationFingerprint
  )
    throw Error("factory_fingerprint_mismatch");
  for (const key of [
    "factory",
    "marketplace",
    "paymentToken",
    "bondEscrow",
    "feeVault",
    "paymaster",
  ]) {
    const expected =
      key === "paymentToken"
        ? pending.usdc
        : key === "paymaster"
          ? pending.tradingSessionPaymaster
          : pending[key];
    const actual = await client.readContract({
      address: pending.tradingSessionPolicy,
      abi: policyAbi,
      functionName: key,
      blockNumber: head.number,
    });
    if (!sameAddress(actual, expected))
      throw Error("session_policy_wiring_mismatch");
  }
  const environment = buildCandidate({
    template,
    pending,
    sourceCommit: options["source-commit"],
    deploymentBlock: options["deployment-block"],
    id: options.id,
    prefix: options.prefix,
    codeHashes,
  });
  await verifyDeployment(client, environment);
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash)
    throw Error("reference_block_reorg");
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(environment, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "ISOLATED_CANDIDATE_ONLY",
      output,
      environmentSha256: sha(environment),
      referenceBlock: head.number.toString(),
      referenceHash: head.hash,
      newExposure: false,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "orderbook_candidate_verification_failed; output not promoted; RPC details omitted",
    );
    process.exitCode = 1;
  });
