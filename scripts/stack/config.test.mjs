import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadStackConfiguration } from "./config.mjs";

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cpredict-stack-config-"));
  const runtime = join(root, "runtime/arbitrum-sepolia/current");
  await mkdir(join(runtime, "web-demo/deployment"), { recursive: true });
  await writeFile(join(runtime, "web-demo/runtime-config.json"), "{}\n");
  const secretPath = join(root, ".env.compose.local");
  await writeFile(
    secretPath,
    [
      "ARBITRUM_SEPOLIA_RPC_URL=https://rpc.example.invalid",
      ...["POSTGRES_ADMIN", "MIGRATOR", "INDEXER", "PAYMASTER", "METADATA", "BACKUP"].map(
        (name) => `CPREDICT_STACK_${name}_PASSWORD=${name.toLowerCase()}_${"x".repeat(32)}`,
      ),
      "CPREDICT_METADATA_PUBLIC_BASE_URL=https://101.32.241.211/metadata",
      `CPREDICT_STACK_RELAY_ADAPTER_HOST_PATH=${join(root, "relay-adapter.mjs")}`,
      `CPREDICT_RELAY_EXPECTED_SENDER=${address("e4")}`,
    ].join("\n") + "\n",
  );
  await chmod(secretPath, 0o600);
  const publicPath = join(root, "runtime/arbitrum-sepolia/current.env");
  await writeFile(
    publicPath,
    [
      `CPREDICT_STACK_RUNTIME_ROOT=${runtime}`,
      `CPREDICT_INDEXER_FACTORY_ADDRESS=${address("f1")}`,
      `CPREDICT_INDEXER_CORE_ADDRESSES=${address("f1")},${address("f2")}`,
      "CPREDICT_INDEXER_DEPLOYMENT_BLOCK=1",
      `CPREDICT_PAYMASTER_ENTRY_POINT=${address("e1")}`,
      `CPREDICT_PAYMASTER_ADDRESS=${address("e2")}`,
      `CPREDICT_PAYMASTER_EXPECTED_SIGNER=${address("e3")}`,
      "CPREDICT_PAYMASTER_POLICY_VERSION=1",
      "CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST=1",
      "CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY=2",
      "CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY=3",
      `CPREDICT_RELAY_FACTORY_ADDRESS=${address("f1")}`,
      `CPREDICT_RELAY_PAYMENT_ASSET_ADDRESS=${address("e5")}`,
      `CPREDICT_RELAY_PERMIT2_ADDRESS=${address("e6")}`,
    ].join("\n") + "\n",
  );
  return { root, runtime, secretPath, publicPath };
}

async function withoutRelayPublicKeys(path) {
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    text
      .split("\n")
      .filter((line) => !line.startsWith("CPREDICT_RELAY_"))
      .join("\n"),
  );
}

test("stack config keeps secret and public deployment inputs separate", async () => {
  const value = await fixture();
  const parsed = await loadStackConfiguration({
    secretPath: value.secretPath,
    publicPath: value.publicPath,
    runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
  });
  assert.equal(parsed.runtimeRoot, await realpath(value.runtime));
});

test("default stack accepts a legacy runtime without relay public keys", async () => {
  const value = await fixture();
  await withoutRelayPublicKeys(value.publicPath);
  await expectNoRejection(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
    }),
  );
  await assert.rejects(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
      relay: true,
    }),
    /CPREDICT_RELAY_FACTORY_ADDRESS is required/,
  );
});

test("relay profile requires an accessible adapter and an explicitly enabled runtime", async () => {
  const value = await fixture();
  await assert.rejects(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
      relay: true,
    }),
    /adapter|permit2Relay/,
  );
  await writeFile(join(value.root, "relay-adapter.mjs"), "export {};\n");
  await writeFile(
    join(value.runtime, "web-demo/runtime-config.json"),
    '{"permit2Relay":{"enabled":true,"basePath":"/relay"}}\n',
  );
  await expectNoRejection(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
      relay: true,
    }),
  );
});

test("stack config rejects public secret keys and permissive secret files", async () => {
  const value = await fixture();
  await writeFile(value.publicPath, "ARBITRUM_SEPOLIA_RPC_URL=https://leak.invalid\n");
  await assert.rejects(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
    }),
    /public runtime env contains secret key/,
  );
  const second = await fixture();
  await chmod(second.secretPath, 0o644);
  await assert.rejects(
    loadStackConfiguration({
      secretPath: second.secretPath,
      publicPath: second.publicPath,
      runtimeBoundary: join(second.root, "runtime/arbitrum-sepolia"),
    }),
    /permissions must be 0600/,
  );
});

async function expectNoRejection(promise) {
  await promise;
}

test("stack config rejects runtime paths outside the repository runtime boundary", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  await mkdir(join(outside, "web-demo/deployment"), { recursive: true });
  await writeFile(join(outside, "web-demo/runtime-config.json"), "{}\n");
  const text = await import("node:fs/promises").then(({ readFile }) =>
    readFile(value.publicPath, "utf8"),
  );
  await writeFile(
    value.publicPath,
    text.replace(`CPREDICT_STACK_RUNTIME_ROOT=${value.runtime}`, `CPREDICT_STACK_RUNTIME_ROOT=${outside}`),
  );
  await assert.rejects(
    loadStackConfiguration({
      secretPath: value.secretPath,
      publicPath: value.publicPath,
      runtimeBoundary: join(value.root, "runtime/arbitrum-sepolia"),
    }),
    /runtime root must stay under/,
  );
});

test("committed Compose example declares every server secret without a value", async () => {
  const text = await readFile(new URL("../../.env.compose.example", import.meta.url), "utf8");
  assert.doesNotMatch(text, /^VITE_/m);
  for (const key of [
    "ARBITRUM_SEPOLIA_RPC_URL",
    "CPREDICT_STACK_POSTGRES_ADMIN_PASSWORD",
    "CPREDICT_STACK_MIGRATOR_PASSWORD",
    "CPREDICT_STACK_INDEXER_PASSWORD",
    "CPREDICT_STACK_PAYMASTER_PASSWORD",
    "CPREDICT_STACK_METADATA_PASSWORD",
    "CPREDICT_STACK_BACKUP_PASSWORD",
    "CPREDICT_STACK_PAYMASTER_ADAPTER_HOST_PATH",
    "CPREDICT_STACK_RELAY_ADAPTER_HOST_PATH",
    "CPREDICT_RELAY_EXPECTED_SENDER",
  ]) assert.match(text, new RegExp(`^${key}=$`, "m"), key);
  assert.match(
    text,
    /^CPREDICT_METADATA_PUBLIC_BASE_URL=https:\/\/101\.32\.241\.211\/metadata$/m,
  );
});
