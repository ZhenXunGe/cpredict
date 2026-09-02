import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = JSON.parse(
  await readFile(new URL("../../compose.yaml", import.meta.url), "utf8"),
);

test("Compose exposes only application services on loopback", () => {
  assert.equal(compose.services.postgres.ports, undefined);
  assert.deepEqual(compose.services.paymaster.profiles, ["sponsorship"]);
  assert.deepEqual(compose.services["permit2-relay"].profiles, ["relay"]);
  for (const name of ["web-demo", "indexer", "metadata", "paymaster", "permit2-relay"])
    for (const port of compose.services[name].ports)
      assert.match(port, /^127\.0\.0\.1:/, `${name} must bind loopback`);
  assert.equal(
    compose.services.indexer.environment.CPREDICT_INDEXER_CONTAINER_MODE,
    "true",
  );
  assert.equal(
    compose.services.paymaster.environment.CPREDICT_PAYMASTER_CONTAINER_MODE,
    "true",
  );
  assert.equal(
    compose.services["permit2-relay"].environment.CPREDICT_RELAY_CONTAINER_MODE,
    "true",
  );
  assert.equal(
    compose.services.metadata.environment.CPREDICT_METADATA_CONTAINER_MODE,
    "true",
  );
  assert.equal(
    compose.services.paymaster.environment.CPREDICT_PAYMASTER_ADAPTER_MODULE,
    "file:///run/cpredict/paymaster-adapter.mjs",
  );
  assert.equal(
    compose.services["permit2-relay"].environment.CPREDICT_RELAY_ADAPTER_MODULE,
    "file:///run/cpredict/permit2-relay-adapter.mjs",
  );
  assert.equal(compose.services.postgres.networks.includes("app"), false);
});

test("runtime services are least privilege, bounded and health ordered", async () => {
  for (const name of [
    "postgres",
    "bootstrap-databases",
    "migrate-indexer",
    "migrate-paymaster",
    "migrate-metadata",
    "indexer",
    "metadata",
    "web-demo",
    "paymaster",
    "permit2-relay",
  ]) {
    const service = compose.services[name];
    assert.equal(
      service.security_opt.includes("no-new-privileges:true"),
      true,
      name,
    );
    assert.equal(service.cap_drop.includes("ALL"), true, name);
    assert.equal(service.read_only, true, name);
    assert.ok(service.deploy.resources.limits.memory, name);
    assert.ok(service.deploy.resources.limits.cpus, name);
  }
  for (const name of ["postgres", "indexer", "metadata", "web-demo", "paymaster", "permit2-relay"])
    assert.match(
      compose.services[name].stop_grace_period,
      /^[1-9][0-9]*s$/,
      name,
    );
  assert.equal(
    compose.services["migrate-indexer"].depends_on["bootstrap-databases"].condition,
    "service_completed_successfully",
  );
  assert.equal(
    compose.services.indexer.depends_on["migrate-indexer"].condition,
    "service_completed_successfully",
  );
  assert.equal(
    compose.services.metadata.depends_on["migrate-metadata"].condition,
    "service_completed_successfully",
  );
  assert.equal(
    compose.services["web-demo"].depends_on.indexer.condition,
    "service_healthy",
  );
  const dockerfiles = await Promise.all([
    readFile(
      new URL("../../deploy/compose/Dockerfile.offchain", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../deploy/compose/Dockerfile.demo", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(dockerfiles[0], /USER node/);
  assert.match(dockerfiles[1], /USER 101/);
  assert.equal(
    compose.services["web-demo"].tmpfs.includes(
      "/etc/nginx/conf.d:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=0755",
    ),
    true,
  );
  const postgresInit = await readFile(
    new URL(
      "../../deploy/compose/postgres/init/00-create-databases.sh",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(postgresInit, /--set=[^\s]*password/i);
  assert.match(
    postgresInit,
    /\\getenv migrator_password CPREDICT_STACK_MIGRATOR_PASSWORD/,
  );
  const nginx = await readFile(
    new URL(
      "../../deploy/compose/nginx/default.conf.template",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    compose.services["web-demo"].healthcheck.test.join(" "),
    /\/readyz/,
  );
  assert.match(
    nginx,
    /location = \/readyz[\s\S]*proxy_pass http:\/\/indexer:8787\/readyz/,
  );
  assert.match(nginx, /location = \/rpc[\s\S]*limit_except POST/);
  assert.match(nginx, /location = \/rpc[\s\S]*rewrite \^ \/ break/);
  assert.match(nginx, /location = \/rpc[\s\S]*proxy_ssl_server_name on/);
  assert.match(nginx, /location = \/rpc[\s\S]*proxy_ssl_name \$proxy_host/);
  assert.match(
    nginx,
    /location = \/rpc[\s\S]*proxy_set_header Authorization ""/,
  );
  assert.match(nginx, /location \/indexer\/[\s\S]*limit_except GET HEAD/);
  assert.match(nginx, /location \/metadata\/[\s\S]*limit_except GET HEAD POST/);
  assert.match(nginx, /location \/relay\/[\s\S]*limit_except POST/);
  assert.match(nginx, /location \/relay\/[\s\S]*rewrite \^\/relay\/\(\.\*\)\$ \/\$1 break/);
});

test("Compose never carries browser-prefixed or embedded secret values", () => {
  const source = JSON.stringify(compose);
  const withoutImageDigests = source.replaceAll(
    /@sha256:[0-9a-f]{64}/g,
    "@sha256:<locked>",
  );
  assert.doesNotMatch(source, /VITE_/);
  assert.doesNotMatch(withoutImageDigests, /(?:0x)?[0-9a-fA-F]{64}/);
  assert.doesNotMatch(source, /postgresql:\/\/[^:$"{]+:[^$"{]+@/);
  assert.match(source, /\$\{ARBITRUM_SEPOLIA_RPC_URL:\?/);
});

test("Compose injects the orchestrator source revision into every application build", () => {
  for (const name of ["indexer", "metadata", "paymaster", "permit2-relay", "web-demo"])
    assert.equal(
      compose.services[name].build.args.CPREDICT_IMAGE_REVISION,
      "${CPREDICT_IMAGE_REVISION:?set by stack orchestrator}",
      name,
    );
});
