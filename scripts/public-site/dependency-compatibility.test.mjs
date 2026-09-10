import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "package.json"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json")));
const uuidConsumers = Object.entries(lock.packages).filter(
  ([, pkg]) => pkg.dependencies?.uuid,
);

// Exercise the actual dependency resolution used by the legacy CommonJS SDKs.
// A successful top-level import alone would miss a stale nested UUID copy.
test("each UUID consumer keeps CommonJS v4, validation and byte round trips", () => {
  assert.ok(uuidConsumers.length > 0);
  for (const [path] of uuidConsumers) {
    const consumerRequire = createRequire(resolve(root, path, "package.json"));
    const uuid = consumerRequire("uuid");
    const id = uuid.v4();
    assert.equal(uuid.validate(id), true, path);
    assert.equal(uuid.version(id), 4, path);
    assert.equal(uuid.stringify(uuid.parse(id)), id, path);
    assert.equal(uuid.validate("not-a-uuid"), false, path);
  }
});

test("every consumer's UUID and ESM export reject out-of-bounds writes without touching the buffer", async () => {
  const variants = [
    ...uuidConsumers.map(([path]) =>
      createRequire(resolve(root, path, "package.json"))("uuid"),
    ),
    await import("uuid"),
  ];
  for (const uuid of variants) {
    const generators = [
      (buffer, offset) => uuid.v3("cpredict", uuid.v3.DNS, buffer, offset),
      (buffer, offset) => uuid.v5("cpredict", uuid.v5.DNS, buffer, offset),
      (buffer, offset) =>
        uuid.v6(
          {
            msecs: 1_700_000_000_000,
            nsecs: 0,
            clockseq: 1,
            node: [1, 2, 3, 4, 5, 6],
          },
          buffer,
          offset,
        ),
    ];
    for (const generate of generators) {
      for (const [size, offset] of [
        [15, 0],
        [16, -1],
        [16, 1],
      ]) {
        const buffer = new Uint8Array(size).fill(0x7f);
        assert.throws(() => generate(buffer, offset), RangeError);
        assert.deepEqual(buffer, new Uint8Array(size).fill(0x7f));
      }
      const buffer = new Uint8Array(18).fill(0x7f);
      assert.equal(generate(buffer, 1), buffer);
      assert.equal(buffer[0], 0x7f);
      assert.equal(buffer[17], 0x7f);
      assert.equal(uuid.validate(uuid.stringify(buffer, 1)), true);
    }
  }
});

async function walletConnectUtils() {
  const path = resolve(root, "node_modules/@walletconnect/utils");
  const pkg = JSON.parse(readFileSync(resolve(path, "package.json")));
  // WalletConnect exposes its browser module with the bundler `module`
  // condition, so plain Node import() would otherwise test CommonJS twice.
  return [
    require("@walletconnect/utils"),
    await import(pathToFileURL(resolve(path, pkg.module)).href),
  ];
}

test("WalletConnect CJS and browser ESM preserve pairing fields and encoded relay data", async () => {
  const params = {
    protocol: "wc",
    version: 2,
    topic: "a".repeat(64),
    symKey: "b".repeat(64),
    relay: { protocol: "irn", data: "测试 + / % & =" },
    expiryTimestamp: 1_800_000_000,
  };
  for (const utils of await walletConnectUtils()) {
    const uri = utils.formatUri(params);
    assert.ok(uri.startsWith(`wc:${params.topic}@2?`));
    const parsed = utils.parseUri(uri);
    for (const key of [
      "version",
      "topic",
      "symKey",
      "relay",
      "expiryTimestamp",
    ])
      assert.deepEqual(parsed[key], params[key], key);
  }
});

test("WalletConnect tolerates malformed percent encoding without changing pairing identity", async () => {
  const malformed = "%ZZ%E0%A4%A".repeat(1024);
  for (const utils of await walletConnectUtils()) {
    const uri = `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}&relay-data=${malformed}`;
    const parsed = utils.parseUri(uri);
    assert.equal(parsed.topic, "a".repeat(64));
    assert.equal(parsed.symKey, "b".repeat(64));
    assert.equal(
      parsed.relay.data,
      new URLSearchParams(uri.split("?")[1]).get("relay-data"),
    );
  }
});

test("Privy and wagmi resolve the same loadable WalletConnect provider", async () => {
  const resolveProvider = (consumer) =>
    createRequire(require.resolve(`${consumer}/package.json`)).resolve(
      "@walletconnect/ethereum-provider",
    );
  // Privy does not export package.json; use its resolved entry as the anchor.
  const privyRequire = createRequire(require.resolve("@privy-io/react-auth"));
  const providerPath = privyRequire.resolve("@walletconnect/ethereum-provider");
  assert.equal(resolveProvider("@wagmi/connectors"), providerPath);
  assert.equal(typeof require(providerPath).EthereumProvider.init, "function");
  const { walletConnect } = await import("@wagmi/connectors");
  assert.equal(
    typeof walletConnect({ projectId: "0".repeat(32), showQrModal: false }),
    "function",
  );
});
