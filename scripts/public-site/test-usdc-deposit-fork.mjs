import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { arbitrumSepolia } from "viem/chains";
import {
  createAppKernel,
  ENTRY_POINT,
} from "../../dist/offchain/app-core/src/kernel.js";
import {
  operationEvent,
  assertDepositTransfer,
} from "../../dist/offchain/app-core/src/receipt.js";
import {
  readUsdcDomain,
  receiveCall,
  receiveTypedData,
  USDC_ADDRESS,
  usdcAbi,
} from "../../dist/offchain/app-core/src/usdc.js";
import { env as fixture } from "../../dist/offchain/app-core/test/fixtures.js";

// The only writes go to an owned loopback Anvil. Real Circle bytecode is retained;
// local minter impersonation supplies fixture USDC, and a local relayer prefunds EP.
const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    "rpc-url": { type: "string" },
    block: { type: "string" },
    output: { type: "string" },
  },
});
assert.ok(
  Boolean(values["env-file"]) !== Boolean(values["rpc-url"]),
  "provide exactly one RPC source",
);
const rpc = new URL(
  values["rpc-url"] ??
    parseEnv(await readFile(resolve(values["env-file"]), "utf8"))
      .CPREDICT_APP_RPC_URL,
);
assert.ok(
  rpc.protocol === "https:" && !rpc.username && !rpc.password && !rpc.hash,
  "HTTPS read RPC required",
);
const root = resolve(import.meta.dirname, "../.."),
  binary = resolve(root, ".tools/foundry/bin/anvil");
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
);
const output = resolve(
  values.output ??
    `reports/generated/public-site/usdc-deposit-fork-${Date.now()}.json`,
);
const directory = await mkdtemp(join(tmpdir(), "cpredict-usdc-fork-"));
const report = {
  mode: "real-usdc-local-pinned-fork",
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  anvilSha256: digest,
  startedAt: new Date().toISOString(),
  token: USDC_ADDRESS,
  chainId: 421614,
  hostedSponsorshipVerified: false,
  liveWalletVerified: false,
  testnetTransactionsSent: 0,
  funding:
    "Owned Anvil only: impersonated Circle minter mints test balances; local relayer funds EntryPoint deposits.",
  checks: [],
  operations: [],
};
report.inputHashes = await Promise.all(
  [
    "package-lock.json",
    "scripts/public-site/test-usdc-deposit-fork.mjs",
    "offchain/app-core/src/usdc.ts",
    "offchain/app-core/src/kernel.ts",
    "offchain/app-core/src/receipt.ts",
    "offchain/app-core/src/contracts.ts",
  ].map(async (path) => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex"),
  })),
);
const check = (label, passed) => {
  assert.ok(passed, label);
  report.checks.push(label);
  console.log(`Passed: ${label}`);
};
let node,
  stage = "read-real-usdc";
try {
  const upstream = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpc.href, { retryCount: 0, timeout: 15000 }),
  });
  const block = await upstream.getBlock(
    values.block
      ? { blockNumber: BigInt(values.block) }
      : { blockTag: "latest" },
  );
  const domain = await readUsdcDomain(upstream, block.number);
  report.blockNumber = block.number.toString();
  report.blockHash = block.hash;
  report.domain = domain;
  report.tokenCodeHash = keccak256(
    await upstream.getCode({
      address: USDC_ADDRESS,
      blockNumber: block.number,
    }),
  );
  check(
    "canonical USDC domain, typehash and decimals verified at fixed block",
    true,
  );
  const port = await new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
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
    { cwd: root, stdio: ["ignore", "ignore", "ignore"] },
  );
  let spawnError = false;
  node.on("error", () => {
    spawnError = true;
  });
  const transport = () =>
    http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 15000 });
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: transport(),
    pollingInterval: 100,
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assert.ok(!spawnError && node.exitCode === null, "Anvil started");
    try {
      ready = String(await client.request({ method: "web3_clientVersion" }))
        .toLowerCase()
        .includes("anvil");
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, "owned Anvil required before creating signers");
  assert.equal(
    (await client.getBlock({ blockNumber: block.number })).hash,
    block.hash,
  );
  const test = createTestClient({
    chain: arbitrumSepolia,
    mode: "anvil",
    transport: transport(),
  });
  const relayer = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    chain: arbitrumSepolia,
    account: relayer,
    transport: transport(),
  });
  await test.setBalance({ address: relayer.address, value: parseEther("10") });
  const receipt = async (hash) => {
    const r = await client.waitForTransactionReceipt({ hash, timeout: 30000 });
    assert.equal(r.status, "success");
    return r;
  };
  stage = "local-usdc-fixture-funding";
  const mintAbi = parseAbi([
    "function masterMinter() view returns(address)",
    "function configureMinter(address minter,uint256 allowance) returns(bool)",
    "function mint(address to,uint256 amount) returns(bool)",
  ]);
  const masterMinter = await client.readContract({
    address: USDC_ADDRESS,
    abi: mintAbi,
    functionName: "masterMinter",
  });
  await test.setBalance({ address: masterMinter, value: parseEther("1") });
  await test.impersonateAccount({ address: masterMinter });
  await receipt(
    await wallet.writeContract({
      account: masterMinter,
      address: USDC_ADDRESS,
      abi: mintAbi,
      functionName: "configureMinter",
      args: [relayer.address, 100_000_000n],
      gas: 500000n,
    }),
  );
  await test.stopImpersonatingAccount({ address: masterMinter });
  const read = (functionName, args) =>
    client.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName,
      args,
    });
  const environment = structuredClone(fixture);
  environment.asset = "USDC";
  environment.account.index = "1002";
  environment.deployment.paymentToken = USDC_ADDRESS;
  for (const mode of ["same-controller", "independent-funder"]) {
    const controller = privateKeyToAccount(generatePrivateKey());
    const source =
      mode === "same-controller"
        ? controller
        : privateKeyToAccount(generatePrivateKey());
    stage = `${mode}-create-kernel`;
    const kernel = await createAppKernel(client, controller, environment);
    check(
      `${mode}: account initially undeployed`,
      !(await client.getCode({ address: kernel.address })),
    );
    await receipt(
      await wallet.writeContract({
        address: USDC_ADDRESS,
        abi: mintAbi,
        functionName: "mint",
        args: [source.address, 20_000_000n],
        gas: 500000n,
      }),
    );
    await receipt(
      await wallet.writeContract({
        address: ENTRY_POINT.address,
        abi: entryPoint07Abi,
        functionName: "depositTo",
        args: [kernel.address],
        value: parseEther("1"),
      }),
    );
    const execute = async (auth, sig, label, expected = true) => {
      stage = label;
      const call = receiveCall(auth, sig);
      const op = {
        sender: kernel.address,
        nonce: await kernel.getNonce(),
        callData: await kernel.encodeCalls([{ ...call, value: 0n }]),
        ...(!(await client.getCode({ address: kernel.address }))
          ? await kernel.getFactoryArgs()
          : {}),
        callGasLimit: 2000000n,
        verificationGasLimit: 2000000n,
        preVerificationGas: 100000n,
        maxFeePerGas: 10000000000n,
        maxPriorityFeePerGas: 1000000000n,
        signature: "0x",
      };
      op.signature = await kernel.signUserOperation(op);
      const userOpHash = getUserOperationHash({
        userOperation: op,
        entryPointAddress: ENTRY_POINT.address,
        entryPointVersion: "0.7",
        chainId: 421614,
      });
      const r = await receipt(
        await wallet.writeContract({
          address: ENTRY_POINT.address,
          abi: entryPoint07Abi,
          functionName: "handleOps",
          args: [[toPackedUserOperation(op)], relayer.address],
          gas: 9000000n,
        }),
      );
      const event = operationEvent(r, {
        hash: userOpHash,
        sender: kernel.address,
        nonce: op.nonce,
      });
      check(`${label}: UserOperation result`, event.success === expected);
      const events = r.logs
        .filter((l) => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase())
        .flatMap((l) => {
          try {
            return [
              decodeEventLog({ abi: usdcAbi, topics: l.topics, data: l.data }),
            ];
          } catch {
            return [];
          }
        });
      if (expected) {
        assertDepositTransfer(r, {
          hash: userOpHash,
          sender: kernel.address,
          nonce: op.nonce,
          authorization: auth,
        });
        check(`${label}: application receipt attribution`, true);
        check(
          `${label}: exact authorization event`,
          events.some(
            (e) =>
              e.eventName === "AuthorizationUsed" &&
              e.args.authorizer.toLowerCase() ===
                source.address.toLowerCase() &&
              e.args.nonce === auth.nonce,
          ),
        );
        check(
          `${label}: exact payment event`,
          events.some(
            (e) =>
              e.eventName === "Transfer" &&
              e.args.from.toLowerCase() === source.address.toLowerCase() &&
              e.args.to.toLowerCase() === kernel.address.toLowerCase() &&
              e.args.value === BigInt(auth.value),
          ),
        );
      } else
        check(
          `${label}: no payment event`,
          !events.some((e) => e.eventName === "Transfer"),
        );
      report.operations.push({
        label,
        expectedSuccess: expected,
        source: source.address,
        controller: controller.address,
        account: kernel.address,
        nonce: auth.nonce,
        userOpHash,
        transactionHash: r.transactionHash,
        actualGasCost: event.actualGasCost.toString(),
      });
    };
    for (const deployment of ["first-deployment", "already-deployed"]) {
      const now = (await client.getBlock()).timestamp;
      const auth = {
        from: source.address,
        to: kernel.address,
        value: "1000000",
        validAfter: "0",
        validBefore: (now + 600n).toString(),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      };
      const sig = await source.signTypedData(receiveTypedData(domain, auth));
      const before = await read("balanceOf", [source.address]);
      const targetBefore = await read("balanceOf", [kernel.address]);
      check(
        `${mode}/${deployment}: all user native balances zero`,
        (
          await Promise.all(
            [source.address, controller.address, kernel.address].map(
              (address) => client.getBalance({ address }),
            ),
          )
        ).every((n) => n === 0n),
      );
      check(
        `${mode}/${deployment}: no prior allowance`,
        (await read("allowance", [source.address, kernel.address])) === 0n,
      );
      await execute(auth, sig, `${mode}/${deployment}`);
      check(
        `${mode}/${deployment}: conserved USDC amount`,
        before - (await read("balanceOf", [source.address])) === 1000000n &&
          (await read("balanceOf", [kernel.address])) - targetBefore ===
            1000000n,
      );
      check(
        `${mode}/${deployment}: nonce consumed`,
        await read("authorizationState", [source.address, auth.nonce]),
      );
      await execute(auth, sig, `${mode}/${deployment}/replay`, false);
      const fresh = { ...auth, nonce: `0x${randomBytes(32).toString("hex")}` };
      const wrong = await source.signTypedData(
        receiveTypedData({ ...domain, chainId: 1 }, fresh),
      );
      await execute(fresh, wrong, `${mode}/${deployment}/wrong-chain`, false);
      check(
        `${mode}/${deployment}: failed authorization remains unused`,
        !(await read("authorizationState", [source.address, fresh.nonce])),
      );
    }
  }
  check(
    "Circle proxy code unchanged",
    keccak256(await client.getCode({ address: USDC_ADDRESS })) ===
      report.tokenCodeHash,
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failedStage = stage;
  report.error = {
    name: error.name,
    cause: error.cause?.name,
    message: String(error.shortMessage ?? error.message)
      .split("\n")[0]
      .replace(/https?:\/\/\S+/g, "[rpc-url]")
      .slice(0, 300),
  };
  console.error(`USDC fork failed at ${stage}: ${error.name}`);
  process.exitCode = 1;
} finally {
  node?.kill("SIGTERM");
  if (node && node.exitCode === null)
    await Promise.race([
      new Promise((r) => node.once("exit", r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  if (node?.exitCode === null) node.kill("SIGKILL");
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await rm(directory, { recursive: true, force: true });
  console.log(`Evidence: ${output}`);
}
