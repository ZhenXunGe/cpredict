import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  encodeFunctionData,
  decodeEventLog,
  erc20Abi,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import {
  createAppKernel,
  deriveAssetAddress,
  assertCurrentController,
  ENTRY_POINT,
  ACCOUNT_ADDRESSES,
} from "../../dist/offchain/app-core/src/kernel.js";
import { operationEvent } from "../../dist/offchain/app-core/src/receipt.js";
import { env as fixtureEnvironment } from "../../dist/offchain/app-core/test/fixtures.js";
import { createMetadataServer } from "../../dist/offchain/metadata-service/src/server.js";
import { MemoryMetadataStore } from "../../dist/offchain/metadata-service/src/memory-store.js";
import {
  buildMetadataTypedData,
  encodeMarketRules,
} from "../../dist/offchain/sdk/src/index.js";

// This runner owns a disposable loopback Anvil. Only upstream reads reach the
// testnet. All keys, signatures, native funding, fixtures and UserOperations are
// local to that process. It does not call a hosted bundler or request sponsorship.
const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    "rpc-url": { type: "string" },
    block: { type: "string" },
    output: { type: "string" },
  },
});
if (Boolean(values["env-file"]) === Boolean(values["rpc-url"]))
  throw new Error("provide exactly one of --env-file or --rpc-url");
if (values.block && !/^[1-9]\d{0,15}$/.test(values.block))
  throw new Error("invalid fork block");
const root = resolve(import.meta.dirname, "../..");
const rpc = new URL(
  values["rpc-url"] ??
    parseEnv(await readFile(resolve(values["env-file"]), "utf8"))
      .CPREDICT_APP_RPC_URL,
);
if (
  rpc.protocol !== "https:" ||
  rpc.username ||
  rpc.password ||
  rpc.hash ||
  rpc.port ||
  rpc.search ||
  !(
    (rpc.hostname === "rpc.zerodev.app" &&
      /^\/api\/v3\/[a-f\d-]{36}\/chain\/421614$/.test(rpc.pathname)) ||
    rpc.href === arbitrumSepolia.rpcUrls.default.http[0]
  )
)
  throw new Error(
    "an explicit supported Arbitrum Sepolia read RPC is required",
  );
const binary = resolve(root, ".tools/foundry/bin/anvil");
const digest = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const lock = await readFile(
  resolve(root, "manifests/security-tools.lock"),
  "utf8",
);
assert.equal(
  digest,
  lock
    .split("\n")
    .find((l) => l.startsWith("anvil-sha256 | "))
    ?.split(" | ")[1],
  "locked Anvil binary required",
);
const artifact = async (name) =>
  JSON.parse(
    await readFile(resolve(root, `out/${name}.sol/${name}.json`), "utf8"),
  );
const nft = await artifact("KernelERC1155Fixture"),
  token = await artifact("MockUSDC");
const output = resolve(
  values.output ??
    `reports/generated/public-site/kernel-fork-${Date.now()}.json`,
);
const directory = await mkdtemp(join(tmpdir(), "cpredict-kernel-fork-"));
const report = {
  schemaVersion: 1,
  mode: "local-pinned-fork",
  startedAt: new Date().toISOString(),
  sourceChainId: 421614,
  readRpcHost: rpc.hostname,
  kernelVersion: "0.3.1",
  entryPointVersion: "0.7",
  anvilSha256: digest,
  checks: [],
  localTransactions: [],
  localUserOperations: [],
  nativeFunding:
    "local Anvil relayer funds an EntryPoint deposit; not hosted Paymaster sponsorship",
  liveWalletVerified: false,
  hostedSponsorshipVerified: false,
  testnetTransactionsSent: 0,
};
report.inputs = await Promise.all(
  [
    "package-lock.json",
    "scripts/public-site/test-kernel-fork.mjs",
    "dist/offchain/app-core/src/kernel.js",
    "dist/offchain/app-core/src/receipt.js",
    "dist/offchain/metadata-service/src/server.js",
    "dist/offchain/metadata-service/src/memory-store.js",
    "out/KernelERC1155Fixture.sol/KernelERC1155Fixture.json",
    "out/MockUSDC.sol/MockUSDC.json",
  ].map(async (path) => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex"),
  })),
);
let node,
  metadata,
  startupDiagnostic = "",
  stage = "read-fork-head";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok) => {
  assert.ok(ok, name);
  report.checks.push({ name, passed: true });
  console.log(`Passed: ${name}`);
};
const failureSummary = (error) => {
  const causes = [];
  for (
    let current = error;
    current && causes.length < 8;
    current = current.cause
  ) {
    causes.push({
      type: current.name ?? "Error",
      code: typeof current.code === "number" ? current.code : null,
      status: typeof current.status === "number" ? current.status : null,
      errorName: /^[a-zA-Z_][a-zA-Z_0-9]{0,80}$/.test(
        current.data?.errorName ?? "",
      )
        ? current.data.errorName
        : null,
      ...([
        "construct-kernel",
        "read-fork-head",
        "pinned-storage-read",
        "start-owned-anvil",
        "verify-owned-fork-block",
      ].includes(stage)
        ? {
            readFailure: String(current.shortMessage ?? current.details ?? "")
              .replace(/https?:\/\/\S+/g, "[rpc-url]")
              .replace(/0x[a-f\d]{42,}/gi, "[hex]")
              .slice(0, 600),
          }
        : {}),
    });
  }
  return causes;
};
try {
  const upstream = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpc.href, { retryCount: 0, timeout: 15_000 }),
  });
  assert.equal(await upstream.getChainId(), 421614);
  const block = await upstream.getBlock(
    values.block
      ? { blockNumber: BigInt(values.block) }
      : { blockTag: "latest" },
  );
  report.forkBlock = block.number.toString();
  report.forkBlockHash = block.hash;
  stage = "pinned-storage-read";
  check(
    "read RPC supports storage at the pinned block",
    /^0x[\da-f]{64}$/i.test(
      await upstream.getStorageAt({
        address: ENTRY_POINT.address,
        slot: toHex(0),
        blockNumber: block.number,
      }),
    ),
  );
  const port = await new Promise((ok, fail) => {
    const socket = createServer();
    socket.once("error", fail);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => ok(address.port));
    });
  });
  stage = "start-owned-anvil";
  node = spawn(
    binary,
    [
      "--quiet",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "421614",
      "--accounts",
      "0",
      "--fork-url",
      rpc.href,
      "--fork-block-number",
      block.number.toString(),
      "--cache-path",
      join(directory, "cache"),
      "--compute-units-per-second",
      "50",
      "--fork-retry-backoff",
      "1000",
      "--retries",
      "1",
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  node.stderr.on("data", (chunk) => {
    if (stage !== "start-owned-anvil") return;
    startupDiagnostic = (startupDiagnostic + chunk.toString())
      .replace(/https?:\/\/\S+/g, "[rpc-url]")
      .replace(/\b(?:0x)?[a-f\d]{64,}\b/gi, "[hex]")
      .slice(-1500);
  });
  let spawnFailed = false;
  node.on("error", () => {
    spawnFailed = true;
  });
  const local = `http://127.0.0.1:${port}`;
  const transport = () => http(local, { retryCount: 0, timeout: 15_000 });
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: transport(),
    pollingInterval: 100,
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnFailed || node.exitCode !== null)
      throw new Error("local Anvil could not start");
    try {
      ready = String(await client.request({ method: "web3_clientVersion" }))
        .toLowerCase()
        .includes("anvil");
    } catch {
      /* startup only */
    }
    if (ready) break;
    await pause(250);
  }
  assert.ok(ready, "owned Anvil must be ready before creating a signer");
  stage = "verify-owned-fork-block";
  assert.equal(
    (await client.getBlock({ blockNumber: block.number })).hash,
    block.hash,
  );
  const test = createTestClient({
    chain: arbitrumSepolia,
    mode: "anvil",
    transport: transport(),
  });
  const owner = privateKeyToAccount(generatePrivateKey()),
    relayer = privateKeyToAccount(generatePrivateKey()),
    recipient = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    chain: arbitrumSepolia,
    account: relayer,
    transport: transport(),
  });
  await test.setBalance({ address: relayer.address, value: parseEther("10") });
  const receipt = async (hash, label) => {
    const r = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    assert.equal(r.status, "success", label);
    report.localTransactions.push({
      label,
      transactionHash: hash,
      blockNumber: r.blockNumber.toString(),
    });
    return r;
  };
  stage = "construct-kernel";
  const environment = structuredClone(fixtureEnvironment);
  delete environment.walletConnectProjectId;
  environment.account.index = "1001";
  const kernel = await createAppKernel(client, owner, environment);
  const same = await createAppKernel(client, owner, environment);
  const otherEnvironment = structuredClone(environment);
  otherEnvironment.account.index = "1002";
  const other = await createAppKernel(client, owner, otherEnvironment);
  check(
    "fixed SDK derivation is stable and distinct across environment indexes",
    kernel.address === same.address &&
      kernel.address ===
        (await deriveAssetAddress(client, owner.address, environment)) &&
      other.address !== kernel.address,
  );
  report.account = kernel.address;
  report.controller = owner.address;
  check(
    "account starts undeployed",
    !(await client.getCode({ address: kernel.address })),
  );
  await assertCurrentController(client, kernel.address, owner.address);

  const metadataStore = new MemoryMetadataStore();
  metadata = await createMetadataServer({
    config: {
      host: "127.0.0.1",
      port: 8790,
      containerMode: false,
      logLevel: "silent",
      chainId: 421614,
      factory: environment.deployment.factory,
      publicBaseUrl: "http://127.0.0.1/metadata",
      databaseUrl: "postgresql://localhost/local_fixture_only",
      challengeTtlSeconds: 300,
      databasePoolSize: 1,
    },
    store: metadataStore,
    signatureClient: client,
    now: () => Number(block.timestamp),
  });
  const publishRules = async (label) => {
    const close = Number(block.timestamp) + 3600;
    const rules = {
      version: "cpredict-rules-v2",
      question: `Local fork ${label} signature test?`,
      outcomes: ["Yes", "No"],
      closeAt: close,
      eventStartsAt: null,
      outcomeDeadlineAt: close,
      resolutionDeadlineAt: close + 900,
      resolutionSource: "https://example.invalid/local-fork-only",
      resolutionCriteria: "Resolve only after the local test assertions pass.",
      cancellationPolicy: "Void the local fixture if its test assertions fail.",
    };
    const encoded = encodeMarketRules(rules);
    const response = await metadata.inject({
      method: "POST",
      url: "/v1/challenges",
      payload: {
        chainId: 421614,
        factory: environment.deployment.factory,
        creator: kernel.address,
        rulesHash: encoded.rulesHash,
      },
    });
    assert.equal(response.statusCode, 200);
    const challengeId = response.json().challengeId;
    const challenge = await metadataStore.challenge(challengeId);
    const typed = buildMetadataTypedData(challenge);
    const signature = await kernel.signTypedData(typed);
    const wrong = await client.verifyTypedData({
      ...typed,
      message: { ...typed.message, rulesHash: `0x${"ff".repeat(32)}` },
      address: kernel.address,
      signature,
    });
    check(`${label} signature rejects a different rules hash`, !wrong);
    const publication = await metadata.inject({
      method: "POST",
      url: "/v1/markets",
      payload: { challengeId, signature, rules },
    });
    check(
      `${label} signature publishes through the real metadata verification route`,
      publication.statusCode === 201,
    );
    const replay = await metadata.inject({
      method: "POST",
      url: "/v1/markets",
      payload: { challengeId, signature, rules },
    });
    check(`${label} challenge cannot be replayed`, replay.statusCode === 409);
  };
  stage = "counterfactual-metadata-signature";
  await publishRules("ERC-6492");
  check(
    "counterfactual verification does not deploy the account",
    !(await client.getCode({ address: kernel.address })),
  );

  stage = "fund-local-entrypoint-deposit";
  await receipt(
    await wallet.writeContract({
      address: ENTRY_POINT.address,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [kernel.address],
      value: parseEther("1"),
    }),
    "local EntryPoint prefund",
  );
  const send = async (calls, label, expectedSuccess = true) => {
    stage = label;
    const deployed = Boolean(await client.getCode({ address: kernel.address }));
    const factory = deployed ? {} : await kernel.getFactoryArgs();
    const op = {
      sender: kernel.address,
      nonce: await kernel.getNonce(),
      callData: await kernel.encodeCalls(calls),
      ...factory,
      callGasLimit: 2_000_000n,
      verificationGasLimit: 2_000_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      signature: "0x",
    };
    op.signature = await kernel.signUserOperation(op);
    const hash = getUserOperationHash({
      userOperation: op,
      entryPointAddress: ENTRY_POINT.address,
      entryPointVersion: "0.7",
      chainId: 421614,
    });
    const packed = toPackedUserOperation(op);
    const r = await receipt(
      await wallet.writeContract({
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[packed], relayer.address],
        gas: 9_000_000n,
      }),
      label,
    );
    report.localUserOperations.push({
      label,
      expectedHash: hash,
      sender: kernel.address,
      nonce: op.nonce.toString(),
      transactionHash: r.transactionHash,
      observedLogs: r.logs.map((log) => {
        let result;
        try {
          const event = decodeEventLog({
            abi: entryPoint07Abi,
            topics: log.topics,
            data: log.data,
          });
          if (event.eventName === "UserOperationEvent")
            result = {
              userOperationHash: event.args.userOpHash,
              sender: event.args.sender,
              nonce: event.args.nonce.toString(),
              success: event.args.success,
              actualGasCost: event.args.actualGasCost.toString(),
            };
        } catch {
          /* retain only the public log identity */
        }
        return { address: log.address, topic: log.topics[0], ...result };
      }),
    });
    const event = operationEvent(r, {
      hash,
      sender: kernel.address,
      nonce: op.nonce,
    });
    check(
      `${label}: canonical UserOperation event matches execution result`,
      event.success === expectedSuccess,
    );
    return { packed, actualGasCost: event.actualGasCost.toString() };
  };
  await send(
    [{ to: recipient.address, data: "0x", value: 0n }],
    "first UserOperation deploys Kernel",
  );
  stage = "deployed-controller-check";
  await assertCurrentController(client, kernel.address, owner.address);
  check(
    "deployed implementation, root validator, hook and controller match",
    true,
  );
  await assert.rejects(
    () => assertCurrentController(client, kernel.address, recipient.address),
    (error) => error.code === "controller_changed",
  );
  check("another controller is rejected", true);
  stage = "deployed-metadata-signature";
  await publishRules("ERC-1271");

  stage = "deploy-local-token-fixtures";
  const nftReceipt = await receipt(
    await wallet.deployContract({
      abi: nft.abi,
      bytecode: nft.bytecode.object,
      gas: 5_000_000n,
    }),
    "local ERC-1155 fixture",
  );
  const tokenReceipt = await receipt(
    await wallet.deployContract({
      abi: token.abi,
      bytecode: token.bytecode.object,
      gas: 5_000_000n,
    }),
    "local ERC-20 fixture",
  );
  const nftAddress = nftReceipt.contractAddress,
    tokenAddress = tokenReceipt.contractAddress;
  stage = "receive-ERC1155-single-and-batch";
  await receipt(
    await wallet.writeContract({
      address: nftAddress,
      abi: nft.abi,
      functionName: "mint",
      args: [kernel.address, 1n, 10n],
    }),
    "single receive",
  );
  await receipt(
    await wallet.writeContract({
      address: nftAddress,
      abi: nft.abi,
      functionName: "mintBatch",
      args: [kernel.address, [2n, 3n], [20n, 30n]],
    }),
    "batch receive",
  );
  const balance = (owner, id) =>
    client.readContract({
      address: nftAddress,
      abi: nft.abi,
      functionName: "balanceOf",
      args: [owner, id],
    });
  check(
    "Kernel accepts ERC-1155 single and batch receipts",
    (await balance(kernel.address, 1n)) === 10n &&
      (await balance(kernel.address, 2n)) === 20n &&
      (await balance(kernel.address, 3n)) === 30n,
  );
  await receipt(
    await wallet.writeContract({
      address: tokenAddress,
      abi: token.abi,
      functionName: "mint",
      args: [kernel.address, 1_000_000_000n],
    }),
    "local payment mint",
  );
  const sent = await send(
    [
      {
        to: nftAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: nft.abi,
          functionName: "safeTransferFrom",
          args: [kernel.address, recipient.address, 1n, 4n, "0x"],
        }),
      },
      {
        to: nftAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: nft.abi,
          functionName: "safeBatchTransferFrom",
          args: [kernel.address, recipient.address, [2n, 3n], [7n, 9n], "0x"],
        }),
      },
      {
        to: tokenAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient.address, 12_000_000n],
        }),
      },
    ],
    "signed batch transfers shares and payment asset",
  );
  check(
    "outgoing shares retain exact single and batch balances",
    (await balance(kernel.address, 1n)) === 6n &&
      (await balance(recipient.address, 1n)) === 4n &&
      (await balance(kernel.address, 2n)) === 13n &&
      (await balance(kernel.address, 3n)) === 21n &&
      (await balance(recipient.address, 2n)) === 7n &&
      (await balance(recipient.address, 3n)) === 9n,
  );
  check(
    "payment transfer retains six-decimal integer amounts",
    (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [recipient.address],
    })) === 12_000_000n,
  );
  stage = "reject-replayed-user-operation";
  await assert.rejects(
    () =>
      client.simulateContract({
        account: relayer,
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[sent.packed], relayer.address],
      }),
    (error) => {
      const reverted = error.walk?.(
        (cause) => cause.name === "ContractFunctionRevertedError",
      );
      return (
        reverted?.data?.errorName === "FailedOp" &&
        reverted.data.args?.[1] === "AA25 invalid account nonce"
      );
    },
  );
  check("submitted UserOperation cannot execute again", true);
  await send(
    [
      {
        to: tokenAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient.address, 1_000_000_000_000n],
        }),
      },
    ],
    "reverted transfer is reported as failed inside a successful bundle",
    false,
  );
  check(
    "failed transfer leaves the asset balance unchanged",
    (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [kernel.address],
    })) === 988_000_000n,
  );
  check(
    "controller and asset address hold zero native ETH; local deposit pays gas",
    (await client.getBalance({ address: owner.address })) === 0n &&
      (await client.getBalance({ address: kernel.address })) === 0n,
  );
  report.observedKernelImplementation =
    ACCOUNT_ADDRESSES.accountImplementationAddress;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = {
    stage,
    type: error?.name ?? "Error",
    appCode: /^[a-z_]{1,80}$/.test(error?.code ?? "") ? error.code : null,
    causes: failureSummary(error),
    ...(stage === "start-owned-anvil"
      ? { anvilExitCode: node?.exitCode ?? null, startupDiagnostic }
      : {}),
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  await metadata?.close();
  if (node && node.exitCode === null) {
    node.kill("SIGTERM");
    await Promise.race([new Promise((r) => node.once("exit", r)), pause(4000)]);
    if (node.exitCode === null && node.signalCode === null)
      node.kill("SIGKILL");
  }
  await rm(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      report: output,
    }),
  );
}
