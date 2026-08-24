import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = JSON.parse(await readFile(new URL("../../compose.yaml", import.meta.url), "utf8"));

test("Compose exposes only Demo, Indexer and optional Paymaster on loopback", () => {
  assert.equal(compose.services.postgres.ports, undefined);
  assert.deepEqual(compose.services.paymaster.profiles, ["sponsorship"]);
  for (const name of ["web-demo", "indexer", "paymaster"])
    for (const port of compose.services[name].ports)
      assert.match(port, /^127\.0\.0\.1:/, `${name} must bind loopback`);
  assert.equal(compose.services.indexer.environment.CPREDICT_INDEXER_CONTAINER_MODE, "true");
  assert.equal(compose.services.paymaster.environment.CPREDICT_PAYMASTER_CONTAINER_MODE, "true");
  assert.equal(compose.services.paymaster.environment.CPREDICT_PAYMASTER_ADAPTER_MODULE, "file:///run/cpredict/paymaster-adapter.mjs");
  assert.equal(compose.services.postgres.networks.includes("app"), false);
});

test("runtime services are least privilege, bounded and health ordered", async () => {
  for (const name of ["postgres", "migrate-indexer", "migrate-paymaster", "indexer", "web-demo", "paymaster"]) {
    const service = compose.services[name];
    assert.equal(service.security_opt.includes("no-new-privileges:true"), true, name);
    assert.equal(service.cap_drop.includes("ALL"), true, name);
    assert.equal(service.read_only, true, name);
    assert.ok(service.deploy.resources.limits.memory, name);
    assert.ok(service.deploy.resources.limits.cpus, name);
  }
  for (const name of ["postgres", "indexer", "web-demo", "paymaster"])
    assert.match(compose.services[name].stop_grace_period, /^[1-9][0-9]*s$/, name);
  assert.equal(compose.services.indexer.depends_on["migrate-indexer"].condition, "service_completed_successfully");
  assert.equal(compose.services["web-demo"].depends_on.indexer.condition, "service_healthy");
  const dockerfiles = await Promise.all([
    readFile(new URL("../../deploy/compose/Dockerfile.offchain", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/compose/Dockerfile.demo", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfiles[0], /USER node/);
  assert.match(dockerfiles[1], /USER 101/);
  const postgresInit = await readFile(
    new URL("../../deploy/compose/postgres/init/00-create-databases.sh", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(postgresInit, /--set=[^\s]*password/i);
  assert.match(postgresInit, /\\getenv migrator_password CPREDICT_STACK_MIGRATOR_PASSWORD/);
});

test("Compose never carries browser-prefixed or embedded secret values", () => {
  const source = JSON.stringify(compose);
  assert.doesNotMatch(source, /VITE_/);
  assert.doesNotMatch(source, /(?:0x)?[0-9a-fA-F]{64}/);
  assert.doesNotMatch(source, /postgresql:\/\/[^:$"{]+:[^$"{]+@/);
  assert.match(source, /\$\{ARBITRUM_SEPOLIA_RPC_URL:\?/);
});
