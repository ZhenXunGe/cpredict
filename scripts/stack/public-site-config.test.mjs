import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadPublicSiteStack } from "./public-site-config.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
async function fixture(t, both = false) {
  const directory = await mkdtemp(join(tmpdir(), "cpredict-public-config-"));
  t.after(() => rm(directory, { recursive: true }));
  const config = { secret: { CPREDICT_STACK_INDEXER_PASSWORD: "test_" + "x".repeat(24) }, publicEnv: {} };
  const runtimes = [];
  async function persist() {
    for (const [name, runtime] of runtimes) await writeFile(config.secret[`CPREDICT_STACK_${name.toUpperCase()}_CONFIG_FILE`], JSON.stringify(runtime), { mode: 0o600 });
    await writeFile(config.secret.CPREDICT_STACK_SITE_CONFIG_FILE, JSON.stringify({ version: 1, defaultEnvironment: runtimes[0][1].environment.id, environments: runtimes.map(([, r]) => r.environment) }));
  }
  config.secret.CPREDICT_STACK_SITE_CONFIG_FILE = join(directory, "site-config.json");
  for (const [i, name] of (both ? ["ctusd", "usdc"] : ["ctusd"]).entries()) {
    const environment = {
      id: name, label: name, asset: i === 0 ? "ctUSD" : "USDC", decimals: 6,
      deployment: { id: `${name}-deployment`, manifestHash: `0x${"a".repeat(64)}`, sourceCommit: "a".repeat(40), chainId: 421614, deploymentBlock: "1", factory: address(1 + i * 10), marketplace: address(2 + i * 10), bondEscrow: address(3 + i * 10), feeVault: address(4 + i * 10), paymentToken: i === 0 ? address(5) : "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", protocolTreasury: address(6), runtimeCodeHashes: {} },
      account: { kernelVersion: "0.3.1", entryPointVersion: "0.7", index: String(1001 + i), derivationVersion: 1 },
      services: { app: `/${name}/app`, indexer: `/${name}/indexer/public`, metadata: `/${name}/metadata`, rpc: `/${name}/app/v1/rpc` },
      privyAppId: `${name}-privy`, explorerUrl: "https://sepolia.arbiscan.io",
      features: { newExposure: false, sponsorship: false, faucet: false, leaderboard: false },
    };
    const runtime = { environment, sponsor: null, allowedOrigins: ["https://test.example.com"], adminSubjects: [], trustedProxies: ["172.18.0.2"] };
    runtimes.push([name, runtime]);
    const prefix = `CPREDICT_STACK_${name.toUpperCase()}`;
    config.secret[`${prefix}_CONFIG_FILE`] = join(directory, `${name}.json`);
    config.secret[`${prefix}_APP_ENV_FILE`] = join(directory, `${name}.env`);
    await writeFile(config.secret[`${prefix}_APP_ENV_FILE`], `CPREDICT_APP_PRIVY_SECRET=${name}_test_secret\nCPREDICT_APP_RPC_URL=https://rpc.example.com/${name}\n`, { mode: 0o600 });
  }
  const d = runtimes[0][1].environment.deployment;
  config.publicEnv = { CPREDICT_INDEXER_FACTORY_ADDRESS: d.factory, CPREDICT_INDEXER_CORE_ADDRESSES: [d.factory, d.marketplace, d.bondEscrow, d.feeVault].join(","), CPREDICT_INDEXER_DEPLOYMENT_BLOCK: "1" };
  if (both) for (const kind of ["INDEXER", "METADATA"]) config.secret[`CPREDICT_STACK_USDC_${kind}_PASSWORD`] = "test_" + "u".repeat(24);
  await persist();
  return { config, runtimes, persist };
}

test("ctUSD alone reuses the existing deployment and does not require USDC secrets", async (t) => {
  const f = await fixture(t);
  const result = await loadPublicSiteStack(f.config);
  assert.equal(result.environments.length, 1);
  assert.equal(result.environments[0].runtime.environment.account.index, "1001");
  assert.equal(result.environment.CPREDICT_STACK_CTUSD_CONFIG_FILE, await realpath(f.config.secret.CPREDICT_STACK_CTUSD_CONFIG_FILE));
  assert.equal(result.environment.CPREDICT_USDC_INDEXER_FACTORY_ADDRESS, undefined);
  assert.ok(Object.values(result.secretsForRedaction).includes("ctusd_test_secret"));
});

test("existing deployment starts without a Demo bundle and accepts obsolete runtime fields", async (t) => {
  const f = await fixture(t);
  f.runtimes[0][1].environment.deployment.protocolVersion = "legacy-v1";
  f.runtimes[0][1].environment.legacyUrl = "/demo/";
  f.config.secret.CPREDICT_STACK_LEGACY_DEMO_DIR = "/nonexistent/retired-demo";
  await f.persist();
  const result = await loadPublicSiteStack(f.config);
  assert.equal(result.environments[0].runtime.environment.deployment.protocolVersion, "legacy-v1");
  assert.equal(result.environment.CPREDICT_STACK_LEGACY_DEMO_DIR, undefined);
});

test("validate-site CLI generates ctUSD-only browser config and preserves an existing output", async (t) => {
  const f = await fixture(t);
  const output = `${f.config.secret.CPREDICT_STACK_SITE_CONFIG_FILE}.generated`;
  const args = ["dist/offchain/app-service/src/maintenance.js", "validate-site", f.config.secret.CPREDICT_STACK_CTUSD_CONFIG_FILE, "--output", output];
  const previousMask = process.umask(0o077);
  let result;
  try {
    result = spawnSync(process.execPath, args, { encoding: "utf8" });
  } finally {
    process.umask(previousMask);
  }
  assert.equal(result.status, 0, result.stderr);
  const original = await readFile(output, "utf8");
  assert.deepEqual(JSON.parse(original), {
    version: 1, defaultEnvironment: "ctusd", environments: [f.runtimes[0][1].environment],
  });
  assert.equal((await stat(output)).mode & 0o777, 0o644);
  const repeat = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(repeat.status, 0);
  assert.equal(await readFile(output, "utf8"), original);
});

test("validate-site CLI still validates optional dual environments and rejects missing or duplicate inputs", async (t) => {
  const f = await fixture(t, true);
  const base = ["dist/offchain/app-service/src/maintenance.js", "validate-site"];
  const ctusd = f.config.secret.CPREDICT_STACK_CTUSD_CONFIG_FILE;
  const usdc = f.config.secret.CPREDICT_STACK_USDC_CONFIG_FILE;
  const valid = spawnSync(process.execPath, [...base, ctusd, usdc], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  for (const inputs of [[], [ctusd, ctusd]]) {
    const output = `${f.config.secret.CPREDICT_STACK_SITE_CONFIG_FILE}.invalid-${inputs.length}`;
    const invalid = spawnSync(process.execPath, [...base, ...inputs, "--output", output], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});

test("both environments use independent deployments, account indexes and supplier inputs", async (t) => {
  const f = await fixture(t, true);
  const result = await loadPublicSiteStack(f.config, { usdc: true });
  assert.equal(result.environments[1].runtime.environment.account.index, "1002");
  assert.equal(result.environment.CPREDICT_USDC_INDEXER_FACTORY_ADDRESS, address(11));
  assert.equal(result.environment.CPREDICT_USDC_METADATA_PUBLIC_BASE_URL, "https://test.example.com/usdc/metadata");
  await assert.rejects(loadPublicSiteStack(f.config), /absent from this stack/);
  f.runtimes[1][1].environment.deployment.factory = address(1);
  await f.persist();
  await assert.rejects(loadPublicSiteStack(f.config, { usdc: true }), /independent deployment/);
});

test("misrouted browser config and changes to the original ctUSD deployment are rejected", async (t) => {
  const f = await fixture(t);
  f.runtimes[0][1].environment.services.indexer = "/indexer";
  await f.persist();
  await assert.rejects(loadPublicSiteStack(f.config), /route namespace/);
  f.runtimes[0][1].environment.services.indexer = "/ctusd/indexer/public";
  await f.persist();
  const site = JSON.parse(await readFile(f.config.secret.CPREDICT_STACK_SITE_CONFIG_FILE, "utf8"));
  site.environments[0].features.newExposure = true;
  await writeFile(f.config.secret.CPREDICT_STACK_SITE_CONFIG_FILE, JSON.stringify(site));
  await assert.rejects(loadPublicSiteStack(f.config), /browser and server/);
  await f.persist();
  f.config.publicEnv.CPREDICT_INDEXER_DEPLOYMENT_BLOCK = "2";
  await assert.rejects(loadPublicSiteStack(f.config), /existing deployment/);
});

test("provider env files must remain private and an exposed USDC database password is invalid", async (t) => {
  const f = await fixture(t, true);
  await chmod(f.config.secret.CPREDICT_STACK_CTUSD_APP_ENV_FILE, 0o644);
  await assert.rejects(loadPublicSiteStack(f.config, { usdc: true }), /0600/);
  await chmod(f.config.secret.CPREDICT_STACK_CTUSD_APP_ENV_FILE, 0o600);
  f.config.secret.CPREDICT_STACK_USDC_INDEXER_PASSWORD = "short";
  await assert.rejects(loadPublicSiteStack(f.config, { usdc: true }), /24-128/);
});

test("public Compose overlays keep services and data separate without a second ctUSD indexer", async () => {
  const publicSite = JSON.parse(await readFile(new URL("../../compose.public-site.yaml", import.meta.url), "utf8"));
  const usdc = JSON.parse(await readFile(new URL("../../compose.usdc.yaml", import.meta.url), "utf8"));
  assert.equal(publicSite.services["app-service"].build.target, "app-service");
  assert.match(publicSite.services["app-service"].environment.CPREDICT_APP_DATABASE_URL, /\/cpredict_indexer\?/);
  assert.match(usdc.services["app-usdc"].environment.CPREDICT_APP_DATABASE_URL, /\/cpredict_usdc_indexer\?/);
  assert.equal(publicSite.services.indexer.depends_on["migrate-app"].condition, "service_completed_successfully");
  assert.equal(usdc.services["bootstrap-usdc"].depends_on["bootstrap-databases"].condition, "service_completed_successfully");
  for (const service of [publicSite.services["app-service"], usdc.services["indexer-usdc"], usdc.services["app-usdc"], usdc.services["metadata-usdc"]]) {
    assert.ok(service.ports.every((p) => p.startsWith("127.0.0.1:")));
    assert.equal(service.read_only, true);
  }
});

test("all public Nginx templates retire Demo pages and block stale edge assets", async () => {
  for (const path of ["deploy/compose/nginx/public-site.conf.template", "deploy/host/nginx/public-site.conf.template", "deploy/public-site/nginx.conf.template"]) {
    const template = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.match(template, /location = \/demo \{ return 308 \/; \}/);
    assert.match(template, /location \^~ \/demo\/ \{ return 308 \/; \}/);
    assert.match(template, /location \^~ \/demo\/assets\/ \{ return 404; \}/);
    assert.doesNotMatch(template, /\/demo\/index\.html/);
  }
});
