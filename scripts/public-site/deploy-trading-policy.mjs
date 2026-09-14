import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  encodeDeployData,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { appRuntimeSchema } from "../../dist/offchain/app-service/src/config.js";
import { quickTradingConfigSchema } from "../../dist/offchain/app-core/src/contracts.js";
import {
  verifyDeployment,
  verifyQuickTrading,
} from "../../dist/offchain/app-service/src/chain.js";

// Never prints environment values, key material, signed transactions or provider URLs.
// Default mode writes an unsigned, reviewable deployment request. Broadcast is explicit.
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    "env-file": { type: "string" },
    paymaster: { type: "string" },
    output: { type: "string" },
    broadcast: { type: "boolean", default: false },
  },
});
if (
  !values.runtime ||
  !values["env-file"] ||
  !values.paymaster ||
  !values.output
)
  throw new Error(
    "--runtime, --env-file, --paymaster and --output are required",
  );
let stage = "configuration",
  written = false;
try {
  if (
    await access(resolve(values.output)).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      "output exists; recover the original deployment before creating another",
    );
  const runtime = appRuntimeSchema.parse(
    JSON.parse(await readFile(resolve(values.runtime), "utf8")),
  );
  const environment = { ...runtime.environment, quickTrading: undefined };
  if (
    environment.asset !== "ctUSD" ||
    environment.deployment.chainId !== 421614
  )
    throw new Error("ctUSD Arbitrum Sepolia only");
  const secrets = parseEnv(await readFile(resolve(values["env-file"]), "utf8"));
  const rpc = secrets.CPREDICT_APP_RPC_URL;
  if (!rpc || new URL(rpc).protocol !== "https:")
    throw new Error("HTTPS deployment RPC required");
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpc, { retryCount: 0, timeout: 15000 }),
  });
  stage = "verify-deployment";
  await verifyDeployment(client, environment);
  const d = environment.deployment,
    paymaster = getAddress(values.paymaster),
    signer = getAddress("0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF");
  const [signerCode, paymasterCode] = await Promise.all([
    client.getCode({ address: signer }),
    client.getCode({ address: paymaster }),
  ]);
  if (
    !signerCode ||
    signerCode === "0x" ||
    !paymasterCode ||
    paymasterCode === "0x"
  )
    throw new Error("required signer or Paymaster module is missing");
  const artifact = JSON.parse(
    await readFile(
      "out/TradingSessionPolicyV1.sol/TradingSessionPolicyV1.json",
      "utf8",
    ),
  );
  const args = [
    d.factory,
    d.marketplace,
    d.paymentToken,
    d.bondEscrow,
    d.feeVault,
    paymaster,
  ];
  const unsigned = {
    chainId: 421614,
    data: encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
    }),
    value: "0",
  };
  const report = {
    schemaVersion: 1,
    environment: environment.id,
    deploymentId: d.id,
    policyVersion: 1,
    signer,
    signerCodeHash: keccak256(signerCode),
    paymaster,
    unsigned,
    enabled: false,
    broadcast: false,
  };
  if (values.broadcast) {
    stage = "deploy-policy";
    if (!/^0x[\da-f]{64}$/i.test(secrets.DEPLOYER_PRIVATE_KEY ?? ""))
      throw new Error("deployment credential unavailable");
    const wallet = createWalletClient({
      account: privateKeyToAccount(secrets.DEPLOYER_PRIVATE_KEY),
      chain: arbitrumSepolia,
      transport: http(rpc, { retryCount: 0, timeout: 15000 }),
    });
    // No retries on broadcast: an unknown result must be reconciled, never blindly resent.
    const nonce = await client.getTransactionCount({
      address: wallet.account.address,
      blockTag: "pending",
    });
    report.sender = wallet.account.address;
    report.nonce = nonce;
    report.broadcastPending = true;
    await save(report);
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
      nonce,
    });
    report.broadcastPending = false;
    report.transactionHash = hash;
    report.broadcast = true;
    await save(report); // Retain the public hash even if receipt recovery fails.
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 120000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error("deployment was not confirmed");
    stage = "verify-policy";
    const policy = receipt.contractAddress,
      code = await client.getCode({ address: policy });
    if (!code || code === "0x") throw new Error("deployed policy missing");
    const config = quickTradingConfigSchema.parse({
      enabled: false,
      version: 1,
      policy,
      policyCodeHash: keccak256(code),
      signer,
      signerCodeHash: keccak256(signerCode),
      paymaster,
    });
    await verifyQuickTrading(client, {
      ...environment,
      quickTrading: { ...config, enabled: true },
    });
    report.quickTrading = config;
    report.blockNumber = receipt.blockNumber.toString();
    report.verified = true;
  }
  await save(report);
  console.log(
    JSON.stringify({
      prepared: true,
      broadcast: report.broadcast,
      verified: report.verified ?? false,
      enabled: false,
      output: resolve(values.output),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      errorType: error?.name ?? "Error",
      code: /^[a-z_]{1,80}$/.test(error?.code ?? "") ? error.code : undefined,
      enabled: false,
    }),
  );
  process.exitCode = 1;
}
async function save(report) {
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: written ? "w" : "wx",
  });
  written = true;
}
