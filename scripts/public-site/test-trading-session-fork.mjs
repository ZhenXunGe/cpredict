import { randomUUID } from "node:crypto";
import { keccak256, hashTypedData, parseAbi, stringToHex } from "viem";
import {
  createSessionKernel,
  policyId,
} from "../../dist/offchain/app-core/src/trading-session-kernel.js";
import { tradingSessionSchema } from "../../dist/offchain/app-core/src/trading-session-contracts.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs, parseEnv, promisify } from "node:util";
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
const dockerImage =
  "ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd";
const native = await readFile(binary).catch(() => null);
const containerName = `cpredict-session-fork-${randomUUID()}`;
let digest;
if (native) {
  digest = createHash("sha256").update(native).digest("hex");
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
  );
} else {
  const result = await promisify(execFile)("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sha256sum",
    dockerImage,
    "/usr/local/bin/anvil",
  ]);
  digest = result.stdout.split(" ")[0];
  assert.equal(
    digest,
    "aca9be8086015d983605b1454ba76436e6c426419e4f6dc720b2cf48542617bb",
  );
}
const artifact = async (name) =>
  JSON.parse(
    await readFile(resolve(root, `out/${name}.sol/${name}.json`), "utf8"),
  );
const nft = await artifact("KernelERC1155Fixture"),
  token = await artifact("MockUSDC");
const output = resolve(
  values.output ??
    `reports/generated/public-site/trading-session-fork-${Date.now()}.json`,
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
  ...(native ? {} : { containerImage: dockerImage }),
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
    "scripts/public-site/test-trading-session-fork.mjs",
    "src/core/TradingSessionPolicyV1.sol",
    "dist/offchain/app-core/src/trading-session-kernel.js",
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
      ...(Array.isArray(current.data?.args)
        ? {
            reason:
              typeof current.data.args[1] === "string" &&
              !current.data.args[1].startsWith("0x")
                ? current.data.args[1].slice(0, 100)
                : null,
            revertSelector:
              typeof current.data.args[2] === "string"
                ? current.data.args[2].slice(0, 10)
                : null,
          }
        : {}),
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
    native ? binary : "docker",
    [
      ...(!native
        ? [
            "run",
            "--rm",
            "--name",
            containerName,
            "--publish",
            `127.0.0.1:${port}:${port}`,
            "--entrypoint",
            "anvil",
            dockerImage,
          ]
        : []),
      "--quiet",
      "--host",
      native ? "127.0.0.1" : "0.0.0.0",
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

  stage = "session-fixtures";
  const deploy = async (name, source = name, args = []) => {
    const a = JSON.parse(
      await readFile(resolve(root, `out/${source}.sol/${name}.json`), "utf8"),
    );
    const r = await receipt(
      await wallet.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
        gas: 12000000n,
      }),
      `deploy ${name}`,
    );
    return { address: r.contractAddress, abi: a.abi };
  };
  const t = await deploy("MockUSDC"),
    registry = await deploy("SessionRegistryFixture", "TradingSessionPolicy.t"),
    market = await deploy(
      "TradingSessionMarketFixture",
      "TradingSessionFixtures",
      [t.address],
    ),
    pm = await deploy(
      "TradingSessionPaymasterFixture",
      "TradingSessionFixtures",
    ),
    policy = await deploy("TradingSessionPolicyV1", "TradingSessionPolicyV1", [
      registry.address,
      recipient.address,
      t.address,
      recipient.address,
      recipient.address,
      pm.address,
    ]);
  await receipt(
    await wallet.writeContract({
      ...registry,
      functionName: "register",
      args: [market.address],
    }),
    "register market",
  );
  await receipt(
    await wallet.writeContract({
      ...t,
      functionName: "mint",
      args: [kernel.address, 1000000000n],
    }),
    "fund asset account with local ctUSD fixture",
  );
  await receipt(
    await wallet.writeContract({
      address: ENTRY_POINT.address,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [pm.address],
      value: parseEther("2"),
    }),
    "local paymaster deposit",
  );
  const sessionKey = privateKeyToAccount(generatePrivateKey());
  const session = tradingSessionSchema.parse({
    id: randomUUID(),
    accountId: randomUUID(),
    account: kernel.address,
    controller: owner.address,
    environment: environment.id,
    deploymentId: environment.deployment.id,
    publicKey: sessionKey.address,
    permissionId: "0x01020304",
    state: "active",
    createdAt: new Date().toISOString(),
    authorizationHash: toHex(0, { size: 32 }),
    perOperation: "10000000",
    total: "20000000",
    validAfter: block.timestamp.toString(),
    validUntil: (block.timestamp + 86400n).toString(),
    config: {
      enabled: true,
      version: 1,
      policy: policy.address,
      policyCodeHash: keccak256(
        await client.getCode({ address: policy.address }),
      ),
      signer: "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF",
      signerCodeHash: keccak256(
        await client.getCode({
          address: "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF",
        }),
      ),
      paymaster: pm.address,
    },
  });
  const authorized = await createSessionKernel(client, environment, session, {
    controller: owner,
    signer: sessionKey,
  });
  check(
    "regular permission preserves undeployed asset address",
    authorized.address === kernel.address,
  );
  const enableSignature =
    await authorized.kernelPluginManager.getPluginEnableSignature(
      kernel.address,
    );
  session.authorizationHash = hashTypedData(
    await authorized.kernelPluginManager.getPluginsEnableTypedData(
      kernel.address,
    ),
  );
  // Rehydrate with no controller signer: any accidental controller request throws.
  const rehydrate = () =>
    createSessionKernel(client, environment, session, {
      signer: sessionKey,
      enableSignature,
    });
  const buy = (amount) =>
    [0n, amount, null, 0n].map((v) =>
      v === null
        ? {
            to: market.address,
            value: 0n,
            data: encodeFunctionData({
              abi: market.abi,
              functionName: "buy",
              args: [0n, 1n, 1n, amount, block.timestamp + 86000n],
            }),
          }
        : {
            to: t.address,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [market.address, v],
            }),
          },
    );
  const make = async (account, calls, sponsored = true) => {
    const deployed = !!(await client.getCode({ address: account.address }));
    const op = {
      sender: account.address,
      nonce: await account.getNonce(),
      callData: await account.encodeCalls(calls),
      ...(deployed ? {} : await account.getFactoryArgs()),
      callGasLimit: 2500000n,
      verificationGasLimit: 2500000n,
      preVerificationGas: 100000n,
      maxFeePerGas: 10000000000n,
      maxPriorityFeePerGas: 1000000000n,
      signature: "0x",
      ...(sponsored
        ? {
            paymaster: pm.address,
            paymasterData: "0x",
            paymasterVerificationGasLimit: 200000n,
            paymasterPostOpGasLimit: 200000n,
          }
        : {}),
    };
    op.signature = await account.signUserOperation(op);
    return op;
  };
  const send = async (account, calls, label, sponsored = true) => {
    stage = label;
    const op = await make(account, calls, sponsored);
    try {
      await client.simulateContract({
        account: relayer,
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[toPackedUserOperation(op)], relayer.address],
        gas: 10000000n,
      });
    } catch (error) {
      const trace = await client
        .request({
          method: "debug_traceCall",
          params: [
            {
              from: relayer.address,
              to: ENTRY_POINT.address,
              data: encodeFunctionData({
                abi: entryPoint07Abi,
                functionName: "handleOps",
                args: [[toPackedUserOperation(op)], relayer.address],
              }),
              gas: toHex(10000000n),
            },
            "latest",
            { tracer: "callTracer" },
          ],
        })
        .catch(() => null);
      const failures = [];
      const walk = (t) => {
        if (!t) return;
        if (t.error)
          failures.push({
            to: t.to,
            selector: t.input?.slice(0, 10),
            error: t.error,
            revertSelector: t.output?.slice(0, 10),
            gasUsed: t.gasUsed,
          });
        for (const c of t.calls ?? []) walk(c);
      };
      walk(trace);
      report.executionFailures = failures;
      console.log(JSON.stringify(failures));
      throw error;
    }
    const r = await receipt(
      await wallet.writeContract({
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[toPackedUserOperation(op)], relayer.address],
        gas: 10000000n,
      }),
      label,
    );
    const hash = getUserOperationHash({
      userOperation: op,
      entryPointAddress: ENTRY_POINT.address,
      entryPointVersion: "0.7",
      chainId: 421614,
    });
    const event = operationEvent(r, {
      hash,
      sender: account.address,
      nonce: op.nonce,
    });
    check(label, event.success);
    report.localUserOperations.push({
      label,
      nonce: op.nonce.toString(),
      hash,
    });
    return op;
  };
  const reject = async (account, calls, label, sponsored = true) => {
    stage = label;
    const op = await make(account, calls, sponsored);
    await assert.rejects(() =>
      client.simulateContract({
        account: relayer,
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[toPackedUserOperation(op)], relayer.address],
        gas: 10000000n,
      }),
    );
    check(label, true);
  };
  const before = await kernel.getNonce();
  const first = await send(
    await rehydrate(),
    buy(10000000n),
    "first session operation enables permission and deploys Kernel",
  );
  check(
    "permission nonce differs from controller nonce",
    first.nonce !== before,
  );
  await assertCurrentController(client, kernel.address, owner.address);
  const restoredAccount = await rehydrate();
  const second = await send(
    restoredAccount,
    buy(10000000n),
    "second session operation uses only browser key after rehydration",
  );
  check(
    "enabled permission nonce changes from enable mode",
    second.nonce !== first.nonce + 1n,
  );
  check(
    "chain budget uses maxPayment",
    (
      await client.readContract({
        ...policy,
        functionName: "sessionState",
        args: [policyId(session), kernel.address],
      })
    )[2] === 20000000n,
  );
  check(
    "temporary ERC20 allowance cleared",
    (await client.readContract({
      ...t,
      functionName: "allowance",
      args: [kernel.address, market.address],
    })) === 0n,
  );
  const third = await send(
    restoredAccount,
    [
      {
        to: market.address,
        value: 0n,
        data: encodeFunctionData({
          abi: market.abi,
          functionName: "refundFor",
          args: [kernel.address],
        }),
      },
    ],
    "cached browser signer submits a claim without controller access",
  );
  check(
    "cached signer still fetches the next permission nonce",
    third.nonce === second.nonce + 1n,
  );
  await reject(await rehydrate(), buy(1n), "cumulative budget rejects excess");
  const sessionAccount = await rehydrate();
  const genericSignature = await sessionAccount.signMessage({
    message: "permission must not authorize generic messages",
  });
  let genericResult = "0xffffffff";
  try {
    genericResult = await client.readContract({
      address: kernel.address,
      abi: parseAbi([
        "function isValidSignature(bytes32,bytes) view returns(bytes4)",
      ]),
      functionName: "isValidSignature",
      args: [
        keccak256(
          stringToHex("permission must not authorize generic messages"),
        ),
        genericSignature,
      ],
    });
  } catch {
    /* Policy explicitly rejects generic signature validation. */
  }
  check(
    "generic message authorization is unavailable",
    genericResult !== "0x1626ba7e",
  );
  // Paired read-only microbenchmark. No controller UI delay, hosted HTTP service,
  // operation registration or chain confirmation is included in these samples.
  const metadataReads = async () => {
    await client.getBlock();
    await client.readContract({
      ...t,
      functionName: "balanceOf",
      args: [kernel.address],
    });
  };
  const serverReads = async (account) => {
    await assertCurrentController(client, kernel.address, owner.address);
    await metadataReads();
    await Promise.all([
      account.getNonce(),
      account.getFactoryArgs(),
      account.encodeCalls(buy(1n)),
    ]);
  };
  const baseline = async () => {
    const account = await createAppKernel(client, owner, environment);
    await assertCurrentController(client, kernel.address, owner.address);
    await metadataReads();
    await serverReads(await createAppKernel(client, owner, environment));
  };
  const improved = async () => {
    await client.readContract({
      ...policy,
      functionName: "sessionState",
      args: [policyId(session), kernel.address],
    });
    await Promise.all([
      (async () => {
        await restoredAccount.getNonce();
        await assertCurrentController(client, kernel.address, owner.address);
      })(),
      metadataReads(),
      (async () => serverReads(await rehydrate()))(),
    ]);
  };
  await baseline();
  await improved();
  const pairs = [];
  for (let i = 0; i < 20; i++) {
    let before, after;
    for (const name of i % 2 ? ["after", "before"] : ["before", "after"]) {
      const start = performance.now();
      await (name === "before" ? baseline : improved)();
      const duration = performance.now() - start;
      if (name === "before") before = duration;
      else after = duration;
    }
    pairs.push({ before, after });
  }
  const percentile = (name, p) =>
    pairs.map((v) => v[name]).sort((a, b) => a - b)[Math.ceil(20 * p) - 1];
  report.preparationMicrobenchmark = {
    scope:
      "owned local fork, read-only client/server preparation scaffolding; excludes live provider, HTTP admission, wallet UI and confirmation; not release performance acceptance",
    pairs,
    before: { p50: percentile("before", 0.5), p95: percentile("before", 0.95) },
    after: { p50: percentile("after", 0.5), p95: percentile("after", 0.95) },
  };
  report.preparationMicrobenchmark.p50Reduction =
    1 - percentile("after", 0.5) / percentile("before", 0.5);

  await reject(
    await rehydrate(),
    [
      {
        to: market.address,
        value: 0n,
        data: encodeFunctionData({
          abi: market.abi,
          functionName: "refundFor",
          args: [kernel.address],
        }),
      },
    ],
    "session without specified paymaster rejected",
    false,
  );
  // Owner nonce and root permissions remain usable.
  await receipt(
    await wallet.writeContract({
      address: ENTRY_POINT.address,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [kernel.address],
      value: parseEther("1"),
    }),
    "owner gas deposit",
  );
  await send(
    kernel,
    [
      {
        to: policy.address,
        value: 0n,
        data: encodeFunctionData({
          abi: policy.abi,
          functionName: "revoke",
          args: [policyId(session)],
        }),
      },
    ],
    "controller revokes permission on chain",
    false,
  );
  await reject(
    await rehydrate(),
    [
      {
        to: market.address,
        value: 0n,
        data: encodeFunctionData({
          abi: market.abi,
          functionName: "refundFor",
          args: [kernel.address],
        }),
      },
    ],
    "revoked permission cannot claim",
  );
  stage = "authorize another permission on deployed Kernel";
  const currentBlock = await client.getBlock();
  const shortSession = {
    ...session,
    id: randomUUID(),
    permissionId: "0x01020305",
    validAfter: currentBlock.timestamp.toString(),
    validUntil: (currentBlock.timestamp + 120n).toString(),
  };
  const secondAuthorization = await createSessionKernel(
    client,
    environment,
    shortSession,
    { controller: owner, signer: sessionKey },
  );
  const secondEnable =
    await secondAuthorization.kernelPluginManager.getPluginEnableSignature(
      kernel.address,
    );
  const shortAccount = await createSessionKernel(
    client,
    environment,
    shortSession,
    { signer: sessionKey, enableSignature: secondEnable },
  );
  await send(
    shortAccount,
    buy(1000000n),
    "new permission on deployed account owns an independent budget",
  );
  check(
    "renewal does not reset revoked permission budget",
    (
      await client.readContract({
        ...policy,
        functionName: "sessionState",
        args: [policyId(session), kernel.address],
      })
    )[2] === 20000000n,
  );
  await test.increaseTime({ seconds: 121 });
  await test.mine({ blocks: 1 });
  const expired = await createSessionKernel(client, environment, shortSession, {
    signer: sessionKey,
    enableSignature: secondEnable,
  });
  await reject(
    expired,
    [
      {
        to: market.address,
        value: 0n,
        data: encodeFunctionData({
          abi: market.abi,
          functionName: "refundFor",
          args: [kernel.address],
        }),
      },
    ],
    "EntryPoint rejects expired permission",
  );
  stage="real market version compatibility";
  const dependencies=await deploy("TradingSessionMarketDependenciesFixture","TradingSessionFixtures");
  const legacyPath=".tools/trading-session-legacy-a196e778/out/FullMarketVaultV1.sol/FullMarketVaultV1.json";
  const legacyArtifact=JSON.parse(await readFile(resolve(root,legacyPath),"utf8"));
  report.legacyMarketSource="a196e7784f26675c552997ed5199b96e0a1797b2";
  report.inputs.push({path:legacyPath,sha256:createHash("sha256").update(await readFile(resolve(root,legacyPath))).digest("hex")});
  const legacyReceipt=await receipt(await wallet.deployContract({abi:legacyArtifact.abi,bytecode:legacyArtifact.bytecode.object,gas:12000000n}),"deploy pinned legacy-v1 market locally");
  const actualMarkets=[{version:"legacy-v1",address:legacyReceipt.contractAddress,abi:legacyArtifact.abi},{version:"time-v2",...await deploy("FullMarketVaultV1")}];
  const now=(await client.getBlock()).timestamp;
  const marketSession={...session,id:randomUUID(),permissionId:"0x01020306",perOperation:"1000000",total:"2000000",validAfter:now.toString(),validUntil:(now+3600n).toString()};
  const marketAuthorization=await createSessionKernel(client,environment,marketSession,{controller:owner,signer:sessionKey});
  const marketEnable=await marketAuthorization.kernelPluginManager.getPluginEnableSignature(kernel.address);
  const marketAccount=await createSessionKernel(client,environment,marketSession,{signer:sessionKey,enableSignature:marketEnable});
  for(const actual of actualMarkets) {
    const init={factory:registry.address,paymentToken:t.address,config:dependencies.address,emergencyController:dependencies.address,exposureGuard:dependencies.address,bondEscrow:recipient.address,feeVault:recipient.address,permit2:"0x0000000000000000000000000000000000000000",creator:relayer.address,rulesHash:keccak256(stringToHex("fork rules")),metadataURI:"ipfs://fork",resolutionSourceHash:keccak256(stringToHex("fork source")),resolutionSourceURI:"https://example.com/fork",outcomeCount:2,createdAt:now,closeAt:now+600n,earlyBirdStart:now,eventStartsAt:0n,outcomeDeadlineAt:now+600n,resolutionWindow:3600n,creatorTreasury:relayer.address,deploymentMode:0,featureFlags:0n,perUserPrimaryCap:100000000n,marketPrimaryCap:1000000000n,minimumPrimaryUnits:10000n,minimumC2CUnits:10000n,creatorBond:10000000n,economics:{creatorRakeBps:0,protocolShareBps:0,earlyBirdShareBps:0,platformC2CFeeBps:0,creatorC2CFeeBps:0,protocolTreasury:relayer.address}};
    await receipt(await wallet.writeContract({...registry,functionName:"initializeMarket",args:[actual.address,encodeFunctionData({abi:actual.abi,functionName:"initialize",args:[init]})]}),`initialize ${actual.version} market`);
    const calls=[0n,1000000n,null,0n].map(amount=>amount===null?{to:actual.address,value:0n,data:encodeFunctionData({abi:actual.abi,functionName:"buy",args:[0n,1000000n,1000000n,1000000n,now+600n]})}:{to:t.address,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[actual.address,amount]})});
    await send(marketAccount,calls,`${actual.version} actual vault buys through real Kernel`);
    check(`${actual.version} shares belong to the original asset account`,await client.readContract({address:actual.address,abi:actual.abi,functionName:"balanceOf",args:[kernel.address,0n]})===1000000n);
    await receipt(await wallet.writeContract({address:actual.address,abi:actual.abi,functionName:"creatorVoid",args:[toHex(0,{size:32})]}),`${actual.version} creator void fixture`);
    await send(marketAccount,[{to:actual.address,value:0n,data:encodeFunctionData({abi:actual.abi,functionName:"refundFor",args:[kernel.address]})}],`${actual.version} actual vault refunds through real Kernel`);
    check(`${actual.version} refunded shares are burned`,await client.readContract({address:actual.address,abi:actual.abi,functionName:"balanceOf",args:[kernel.address,0n]})===0n);
  }
  check("actual market refunds do not restore session budget",(await client.readContract({...policy,functionName:"sessionState",args:[policyId(marketSession),kernel.address]}))[2]===2000000n);
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
  if (!native)
    await promisify(execFile)("docker", ["rm", "--force", containerName]).catch(
      () => undefined,
    );
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
