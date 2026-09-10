import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseEnvText } from "../deployment/deploy-arbitrum-sepolia.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
export const PUBLIC_SITE_SECRET_KEYS = [
  "CPREDICT_STACK_CTUSD_APP_ENV_FILE",
  "CPREDICT_STACK_CTUSD_CONFIG_FILE",
  "CPREDICT_STACK_SITE_CONFIG_FILE",
  "CPREDICT_STACK_USDC_APP_ENV_FILE",
  "CPREDICT_STACK_USDC_CONFIG_FILE",
  "CPREDICT_STACK_USDC_INDEXER_PASSWORD",
  "CPREDICT_STACK_USDC_METADATA_PASSWORD",
  "CPREDICT_STACK_LEGACY_DEMO_DIR",
];
const password = /^[A-Za-z0-9_-]{24,128}$/;
async function inputPath(secret, key, restricted = false) {
  if (!secret[key]) throw new Error(`${key} is required`);
  const path = await realpath(resolve(ROOT, secret[key]));
  const info = await stat(path);
  if (!info.isFile() || (restricted && (info.mode & 0o077) !== 0))
    throw new Error(
      `${key} must name a regular${restricted ? " 0600" : ""} file`,
    );
  return path;
}

/** Supplements the existing stack configuration; no credentials enter public env files. */
export async function loadPublicSiteStack(
  configuration,
  { usdc = false } = {},
) {
  let schemas;
  try {
    schemas = await import("../../dist/offchain/app-service/src/config.js");
  } catch {
    throw new Error(
      "Public-site stack validation requires npm run build:offchain first",
    );
  }
  const { siteConfigSchema } = await import(
    "../../dist/offchain/app-core/src/contracts.js"
  );
  const secret = configuration.secret;
  const sitePath = await inputPath(secret, "CPREDICT_STACK_SITE_CONFIG_FILE");
  const site = siteConfigSchema.parse(
    JSON.parse(await readFile(sitePath, "utf8")),
  );
  const environments = [];
  const environment = { CPREDICT_STACK_SITE_CONFIG_FILE: sitePath };
  const secretsForRedaction = {};
  for (const name of usdc ? ["ctusd", "usdc"] : ["ctusd"]) {
    const prefix = `CPREDICT_STACK_${name.toUpperCase()}`;
    const configPath = await inputPath(secret, `${prefix}_CONFIG_FILE`, true);
    const providerPath = await inputPath(
      secret,
      `${prefix}_APP_ENV_FILE`,
      true,
    );
    const runtime = schemas.appRuntimeSchema.parse(
      JSON.parse(await readFile(configPath, "utf8")),
    );
    const provider = parseEnvText(await readFile(providerPath, "utf8"));
    await schemas.loadServiceConfig({
      ...provider,
      CPREDICT_APP_CONFIG_FILE: configPath,
      CPREDICT_APP_CONTAINER_MODE: "true",
      CPREDICT_APP_METADATA_URL:
        name === "ctusd" ? "http://metadata:8793" : "http://metadata-usdc:8793",
      CPREDICT_APP_DATABASE_URL:
        name === "ctusd"
          ? `postgresql://cpredict_indexer:${secret.CPREDICT_STACK_INDEXER_PASSWORD}@postgres/cpredict_indexer?sslmode=disable`
          : `postgresql://cpredict_usdc_indexer:${secret.CPREDICT_STACK_USDC_INDEXER_PASSWORD}@postgres/cpredict_usdc_indexer?sslmode=disable`,
    });
    const e = runtime.environment;
    if (
      e.asset !== (name === "ctusd" ? "ctUSD" : "USDC") ||
      e.account.index !== (name === "ctusd" ? "1001" : "1002")
    )
      throw new Error(`${name}: frozen asset/account configuration mismatch`);
    if (
      e.services.indexer !== `/${name}/indexer/public` ||
      e.services.app !== `/${name}/app` ||
      e.services.metadata !== `/${name}/metadata`
    )
      throw new Error(`${name}: public route namespace mismatch`);
    const published = site.environments.find((item) => item.id === e.id);
    if (!published || JSON.stringify(published) !== JSON.stringify(e))
      throw new Error(
        `${name}: browser and server environment configuration differ`,
      );
    for (const key of ["CPREDICT_APP_PRIVY_SECRET", "CPREDICT_APP_RPC_URL"])
      if (!provider[key])
        throw new Error(`${name}: ${key} is required in its provider env file`);
    if (
      runtime.sponsor &&
      (runtime.sponsor.weekly.projectWei !== "100000000000000000" ||
        runtime.sponsor.weekly.exitReserveWei !== "20000000000000000")
    )
      throw new Error(`${name}: confirmed Shanghai weekly budget changed`);
    environment[`${prefix}_CONFIG_FILE`] = configPath;
    environment[`${prefix}_APP_ENV_FILE`] = providerPath;
    for (const [key, value] of Object.entries(provider))
      if (
        /(SECRET|TOKEN|PASSWORD|API_KEY|RPC_URL|BUNDLER_URL|PAYMASTER_URL)$/.test(
          key,
        )
      )
        secretsForRedaction[`${name}_${key}`] = value;
    environments.push({ name, runtime, configPath, providerPath });
    if (name === "ctusd") {
      if (e.deployment.protocolVersion === "legacy-v1") {
        if (!secret.CPREDICT_STACK_LEGACY_DEMO_DIR)
          throw new Error(
            "legacy deployment requires its reviewed /demo build",
          );
        const demo = await realpath(
          resolve(ROOT, secret.CPREDICT_STACK_LEGACY_DEMO_DIR),
        );
        const build = JSON.parse(
          await readFile(resolve(demo, "legacy-build.json"), "utf8"),
        );
        if (
          build.protocolVersion !== "legacy-v1" ||
          build.base !== "/demo/" ||
          !/^[a-f0-9]{40}$/.test(build.sourceCommit)
        )
          throw new Error("legacy demo provenance is invalid");
        if (
          createHash("sha256")
            .update(await readFile(resolve(demo, "index.html")))
            .digest("hex") !== build.indexSha256
        )
          throw new Error("legacy demo index differs from its build record");
        environment.CPREDICT_STACK_LEGACY_DEMO_DIR = demo;
      }
      const d = e.deployment,
        legacy = configuration.publicEnv;
      const expected = [d.factory, d.marketplace, d.bondEscrow, d.feeVault]
        .map((a) => a.toLowerCase())
        .sort();
      const existing = legacy.CPREDICT_INDEXER_CORE_ADDRESSES.split(",")
        .map((a) => a.trim().toLowerCase())
        .sort();
      if (
        d.factory.toLowerCase() !==
          legacy.CPREDICT_INDEXER_FACTORY_ADDRESS.toLowerCase() ||
        d.deploymentBlock !== legacy.CPREDICT_INDEXER_DEPLOYMENT_BLOCK ||
        JSON.stringify(expected) !== JSON.stringify(existing)
      )
        throw new Error(
          "ctUSD configuration must match the existing deployment; no implicit redeployment",
        );
    } else {
      const ctusd = environments[0].runtime;
      if (
        ctusd.environment.id === e.id ||
        ctusd.environment.deployment.id === e.deployment.id ||
        ctusd.environment.deployment.factory.toLowerCase() ===
          e.deployment.factory.toLowerCase() ||
        ctusd.environment.privyAppId === e.privyAppId ||
        (ctusd.sponsor &&
          runtime.sponsor &&
          ctusd.sponsor.projectId === runtime.sponsor.projectId)
      )
        throw new Error(
          "USDC requires independent deployment and supplier projects",
        );
      for (const key of [
        "CPREDICT_STACK_USDC_INDEXER_PASSWORD",
        "CPREDICT_STACK_USDC_METADATA_PASSWORD",
      ])
        if (!password.test(secret[key] ?? ""))
          throw new Error(`${key} must be 24-128 URL-safe characters`);
      const d = e.deployment;
      environment.CPREDICT_USDC_INDEXER_FACTORY_ADDRESS = d.factory;
      environment.CPREDICT_USDC_INDEXER_CORE_ADDRESSES = [
        d.factory,
        d.marketplace,
        d.bondEscrow,
        d.feeVault,
      ].join(",");
      environment.CPREDICT_USDC_INDEXER_DEPLOYMENT_BLOCK = d.deploymentBlock;
      environment.CPREDICT_USDC_METADATA_PUBLIC_BASE_URL = new URL(
        e.services.metadata,
        runtime.allowedOrigins[0],
      ).toString();
    }
  }
  if (site.environments.length !== environments.length)
    throw new Error(
      "Browser configuration exposes an environment absent from this stack",
    );
  return {
    environment,
    secretsForRedaction,
    publicSite: true,
    usdc,
    environments,
  };
}
