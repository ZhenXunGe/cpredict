#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import {
  rollbackCompose,
  escapeCompose,
} from "../stack/public-update-core.mjs";
import { pinMountInputs } from "../stack/public-update-runtime.mjs";

export function historicalRuntime(runtime) {
  const old = structuredClone(runtime);
  old.environment.historical = true;
  old.environment.label = "历史市场";
  old.environment.services = {
    app: "/ctusd-history/app",
    indexer: "/ctusd-history/indexer/public",
    metadata: "/ctusd-history/metadata",
    rpc: "/ctusd-history/app/v1/rpc",
  };
  old.environment.features = {
    ...old.environment.features,
    newExposure: false,
    faucet: false,
    leaderboard: false,
  };
  delete old.environment.quickTrading;
  return old;
}
export async function prepareHistoryServices({ containers, runtime, output }) {
  const { appRuntimeSchema } = await import(
    "../../dist/offchain/app-service/src/config.js"
  );
  const previous = appRuntimeSchema.parse(runtime),
    history = appRuntimeSchema.parse(historicalRuntime(previous));
  const model = rollbackCompose(containers);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const runtimePath = resolve(output, "history.runtime.json");
  await writeFile(runtimePath, JSON.stringify(history, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const result = {
    name: "cpredict-history",
    services: {},
    networks: model.networks,
    volumes: model.volumes,
  };
  for (const name of ["indexer", "app-service", "metadata"]) {
    const source = model.services[name];
    const env = Object.fromEntries(
      source.environment.map((entry) => {
        const p = entry.indexOf("=");
        return [entry.slice(0, p), entry.slice(p + 1)];
      }),
    );
    if (name === "app-service")
      env.CPREDICT_APP_METADATA_URL = "http://metadata-history:8793";
    if (name === "indexer")
      env.CPREDICT_INDEXER_METADATA_URL = "http://metadata-history:8793";
    if (name === "metadata")
      env.CPREDICT_METADATA_PUBLIC_BASE_URL = new URL(
        "/ctusd-history/metadata",
        previous.allowedOrigins[0],
      ).href;
    source.environment = env;
    source.ports = [];
    source.networks = Object.fromEntries(
      Object.keys(source.networks).map((key) => [
        key,
        { aliases: [`${name}-history`] },
      ]),
    );
    const pinned = await pinMountInputs(source, resolve(output, name));
    for (const mount of pinned.volumes)
      if (mount.target === "/run/cpredict/application.json")
        mount.source = runtimePath;
    result.services[`${name}-history`] = pinned;
  }
  const compose = resolve(output, "compose.json");
  await writeFile(
    compose,
    JSON.stringify(escapeCompose(result), null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await chmod(compose, 0o600);
  return {
    compose,
    runtimePath,
    deploymentId: history.environment.deployment.id,
  };
}
async function main() {
  const { values } = parseArgs({
    options: { runtime: { type: "string" }, output: { type: "string" } },
  });
  if (!values.runtime || !values.output)
    throw new Error("--runtime and --output required");
  const ids = execFileSync(
    "docker",
    [
      "ps",
      "--filter",
      "label=com.docker.compose.project=cpredict",
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/);
  const containers = JSON.parse(
    execFileSync("docker", ["inspect", ...ids], { encoding: "utf8" }),
  );
  const result = await prepareHistoryServices({
    containers,
    runtime: JSON.parse(await readFile(values.runtime, "utf8")),
    output: resolve(values.output),
  });
  console.log(
    JSON.stringify({
      status: "prepared-not-started",
      deploymentId: result.deploymentId,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      "History service preparation failed; inspect private inputs locally.",
    );
    process.exitCode = 1;
  });
