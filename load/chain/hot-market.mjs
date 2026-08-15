import fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  maxUint256,
  toHex,
} from "viem";
import { foundry } from "viem/chains";

const rpcUrl = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:18545";
let rpcId = 1;
const profile = process.env.LOAD_PROFILE ?? "smoke";
const targetTps = integer("CHAIN_TPS", profile === "full" ? 50 : 5, 1, 100);
const durationSeconds = integer(
  "CHAIN_DURATION",
  profile === "full" ? 600 : 10,
  1,
  600,
);
const expectedRevertPercent = integer("EXPECTED_REVERT_PERCENT", 5, 0, 50);
if (
  (profile === "full" || targetTps > 10 || durationSeconds > 30) &&
  process.env.CPREDICT_LOAD_CONFIRM !== "I_UNDERSTAND_RESOURCE_USAGE"
) {
  throw new Error(
    "large chain run requires CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE",
  );
}
if (
  !rpcUrl.startsWith("http://127.0.0.1:") &&
  !rpcUrl.startsWith("http://localhost:")
) {
  throw new Error("controlled-chain runner only accepts a loopback Anvil RPC");
}

const artifacts = {
  usdc: artifact("MockUSDC.sol", "MockUSDC"),
  config: artifact("ProtocolConfigV1.sol", "ProtocolConfigV1"),
  emergency: artifact("EmergencyControllerV1.sol", "EmergencyControllerV1"),
  guard: artifact("LaunchExposureGuardV1.sol", "LaunchExposureGuardV1"),
  feeVault: artifact("FeeVaultV1.sol", "FeeVaultV1"),
  bondEscrow: artifact("BondEscrowV1.sol", "BondEscrowV1"),
  clone: artifact("CloneMarketVaultV1.sol", "CloneMarketVaultV1"),
  fullDeployer: artifact("FullMarketDeployerV1.sol", "FullMarketDeployerV1"),
  factory: artifact("MarketFactoryV1.sol", "MarketFactoryV1"),
  market: artifact("FullMarketVaultV1.sol", "FullMarketVaultV1"),
};
const publicClient = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
});
const accounts = await publicClient.request({ method: "eth_accounts" });
if (accounts.length < 10)
  throw new Error("Anvil must expose at least 10 deterministic accounts");
const governance = accounts[0];
const wallet = createWalletClient({
  account: governance,
  chain: foundry,
  transport: http(rpcUrl),
});
const setupStarted = performance.now();

const usdc = await deploy(artifacts.usdc, []);
const config = await deploy(artifacts.config, [governance, usdc, governance]);
const emergency = await deploy(artifacts.emergency, [governance, accounts[9]]);
const guard = await deploy(artifacts.guard, [governance, 50_000_000_000n]);
const feeVault = await deploy(artifacts.feeVault, [governance, usdc]);
const bondEscrow = await deploy(artifacts.bondEscrow, [governance, usdc]);
const clone = await deploy(artifacts.clone, []);
const fullDeployer = await deploy(artifacts.fullDeployer, [governance]);
const factory = await deploy(artifacts.factory, [
  governance,
  config,
  emergency,
  guard,
  bondEscrow,
  feeVault,
  fullDeployer,
  clone,
  zeroAddress(),
]);

await write(artifacts.guard.abi, guard, "setFactory", [factory]);
await write(artifacts.feeVault.abi, feeVault, "setFactory", [factory]);
await write(artifacts.bondEscrow.abi, bondEscrow, "setFactory", [factory]);
await write(artifacts.fullDeployer.abi, fullDeployer, "setFactory", [factory]);
await write(artifacts.factory.abi, factory, "setMarketplace", [accounts[9]]);
await write(artifacts.usdc.abi, usdc, "mint", [governance, 200_000_000n]);
await write(artifacts.usdc.abi, usdc, "approve", [factory, maxUint256]);

const latest = await publicClient.getBlock();
const now = Number(latest.timestamp);
const marketParams = {
  rulesHash: toHex("cpredict-controlled-load", { size: 32 }),
  metadataURI: "ipfs://cpredict-controlled-load",
  resolutionSourceHash: toHex("controlled-load-source", { size: 32 }),
  resolutionSourceURI: "https://invalid.example/load-only",
  outcomeCount: 2,
  closeAt: BigInt(now + Math.max(3_600, durationSeconds + 600)),
  earlyBirdStart: BigInt(now),
  creatorTreasury: governance,
  deploymentMode: 0,
  featureFlags: 0n,
  creatorRakeBps: 0,
  creatorC2CFeeBps: 0,
  perUserPrimaryCap: 100_000_000n,
  marketPrimaryCap: 5_000_000_000n,
  minimumPrimaryUnits: 10_000n,
  minimumC2CUnits: 10_000n,
  creatorBond: 100_000_000n,
};
const createReceipt = await write(
  artifacts.factory.abi,
  factory,
  "createMarket",
  [marketParams, toHex(1, { size: 32 })],
  true,
);
let market;
for (const log of createReceipt.logs) {
  try {
    const decoded = decodeEventLog({
      abi: artifacts.factory.abi,
      data: log.data,
      topics: log.topics,
    });
    if (decoded.eventName === "MarketCreated") market = decoded.args.market;
  } catch {
    // Logs emitted by child contracts are intentionally ignored.
  }
}
if (market === undefined) throw new Error("MarketCreated event not found");

const buyers = accounts.slice(1, 9);
for (const buyer of buyers) {
  await write(artifacts.usdc.abi, usdc, "mint", [buyer, 100_000_000n]);
  const buyerWallet = createWalletClient({
    account: buyer,
    chain: foundry,
    transport: http(rpcUrl),
  });
  const approvalHash = await buyerWallet.writeContract({
    address: usdc,
    abi: artifacts.usdc.abi,
    functionName: "approve",
    args: [market, maxUint256],
  });
  await publicClient.waitForTransactionReceipt({ hash: approvalHash });
}

const setupSeconds = (performance.now() - setupStarted) / 1_000;
const nonceByAccount = new Map();
for (const buyer of buyers) {
  nonceByAccount.set(
    buyer,
    await publicClient.getTransactionCount({
      address: buyer,
      blockTag: "pending",
    }),
  );
}
await rpc("evm_setAutomine", [false]);

const totalPlanned = targetTps * durationSeconds;
const successData = encodeFunctionData({
  abi: artifacts.market.abi,
  functionName: "buy",
  args: [0n, 10_000n, 10_000n, 10_000n, marketParams.closeAt],
});
const revertData = encodeFunctionData({
  abi: artifacts.market.abi,
  functionName: "buy",
  args: [99n, 10_000n, 10_000n, 10_000n, marketParams.closeAt],
});
const submissions = [];
const submissionLatencies = [];
const inclusionLatencies = [];
const classifications = {
  planned: totalPlanned,
  submitted: 0,
  included: 0,
  success: 0,
  expectedRevert: 0,
  rejectedSubmission: 0,
  unexpectedRevert: 0,
  unexpectedSuccess: 0,
  missingReceipt: 0,
};
const loadStarted = performance.now();

try {
  for (let index = 0; index < totalPlanned; index += 1) {
    const targetAt = loadStarted + (index * 1_000) / targetTps;
    await sleepUntil(targetAt);
    const buyer = buyers[index % buyers.length];
    const nonce = nonceByAccount.get(buyer);
    nonceByAccount.set(buyer, nonce + 1);
    const expectedRevert =
      expectedRevertPercent !== 0 &&
      index % Math.round(100 / expectedRevertPercent) === 0;
    const submittedAt = performance.now();
    try {
      const hash = await rpc("eth_sendTransaction", [
        {
          from: buyer,
          to: market,
          data: expectedRevert ? revertData : successData,
          gas: toHex(500_000),
          nonce: toHex(nonce),
          value: "0x0",
        },
      ]);
      submissionLatencies.push(performance.now() - submittedAt);
      submissions.push({ hash, expectedRevert, submittedAt });
      classifications.submitted += 1;
    } catch {
      classifications.rejectedSubmission += 1;
    }

    const closesCurrentSecond =
      (index + 1) % targetTps === 0 || index + 1 === totalPlanned;
    if (closesCurrentSecond) {
      await rpc("evm_mine", []);
      const pending = submissions.splice(0, submissions.length);
      const receipts = await Promise.all(
        pending.map(async (submission) => ({
          submission,
          receipt: await rpc("eth_getTransactionReceipt", [submission.hash]),
          observedAt: performance.now(),
        })),
      );
      for (const { submission, receipt, observedAt } of receipts) {
        if (receipt === null) {
          classifications.missingReceipt += 1;
          continue;
        }
        classifications.included += 1;
        inclusionLatencies.push(observedAt - submission.submittedAt);
        const succeeded = receipt.status === "0x1";
        if (succeeded && submission.expectedRevert)
          classifications.unexpectedSuccess += 1;
        else if (succeeded) classifications.success += 1;
        else if (submission.expectedRevert) classifications.expectedRevert += 1;
        else classifications.unexpectedRevert += 1;
      }
    }
  }
} finally {
  await rpc("evm_setAutomine", [true]);
}

await sleepUntil(loadStarted + durationSeconds * 1_000);
const elapsedSeconds = (performance.now() - loadStarted) / 1_000;
submissionLatencies.sort((a, b) => a - b);
inclusionLatencies.sort((a, b) => a - b);
const result = {
  lane: "real-current-protocol-artifacts-on-fresh-local-anvil",
  profile,
  rpcUrl,
  market,
  deploymentMode: "FULL",
  targetTps,
  durationSeconds,
  expectedRevertPercent,
  setupSeconds: round(setupSeconds),
  elapsedSeconds: round(elapsedSeconds),
  achievedSubmittedTps: round(classifications.submitted / elapsedSeconds),
  achievedIncludedTps: round(classifications.included / elapsedSeconds),
  classifications,
  submissionRpcLatencyMs: summary(submissionLatencies),
  inclusionLatencyMs: summary(inclusionLatencies),
  thresholds: {
    allSubmissionsIncluded:
      classifications.included === classifications.submitted,
    noUnexpectedOutcome:
      classifications.unexpectedRevert === 0 &&
      classifications.unexpectedSuccess === 0,
    achievedAtLeast95PercentOfTarget:
      classifications.submitted / elapsedSeconds >= targetTps * 0.95,
  },
  proofBoundary:
    "Fresh local Anvil with real compiled protocol artifacts; submission throughput is not Base inclusion throughput, sequencer capacity, RPC capacity, or production finality.",
};
const encoded = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(encoded);
if (process.env.REPORT_PATH !== undefined)
  fs.writeFileSync(process.env.REPORT_PATH, encoded);
if (Object.values(result.thresholds).some((passed) => !passed))
  process.exitCode = 2;

async function deploy(contractArtifact, args) {
  const hash = await wallet.deployContract({
    abi: contractArtifact.abi,
    bytecode: contractArtifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress === null) {
    throw new Error("contract deployment failed");
  }
  return receipt.contractAddress;
}

async function write(abi, address, functionName, args, returnReceipt = false) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} failed`);
  return returnReceipt ? receipt : undefined;
}

function artifact(sourceDirectory, contractName) {
  const parsed = JSON.parse(
    fs.readFileSync(
      new URL(
        `../../out/${sourceDirectory}/${contractName}.json`,
        import.meta.url,
      ),
    ),
  );
  if (
    !Array.isArray(parsed.abi) ||
    typeof parsed.bytecode?.object !== "string"
  ) {
    throw new Error(`invalid Foundry artifact for ${contractName}`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const body = await response.json();
  if (body.error !== undefined)
    throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function zeroAddress() {
  return "0x0000000000000000000000000000000000000000";
}

function summary(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: round(values.at(-1) ?? 0),
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return round(
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ],
  );
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

async function sleepUntil(target) {
  const remaining = target - performance.now();
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
}
