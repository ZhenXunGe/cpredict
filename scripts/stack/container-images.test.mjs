import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const lock = JSON.parse(
  await readFile(new URL("manifests/container-images.lock.json", root), "utf8"),
);
const compose = JSON.parse(
  await readFile(new URL("compose.yaml", root), "utf8"),
);
const demo = await readFile(
  new URL("deploy/compose/Dockerfile.demo", root),
  "utf8",
);
const offchain = await readFile(
  new URL("deploy/compose/Dockerfile.offchain", root),
  "utf8",
);
const restore = await readFile(
  new URL("scripts/stack/restore-drill.mjs", root),
  "utf8",
);

const locked = (name) => {
  const image = lock.images[name];
  assert.match(image.reference, /^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+$/);
  assert.match(image.digest, /^sha256:[0-9a-f]{64}$/);
  return `${image.reference}@${image.digest}`;
};

test("Compose and restore drill pin the reviewed PostgreSQL image digest", () => {
  const postgres = locked("postgres");
  for (const name of ["postgres", "bootstrap-databases", "migrate-indexer", "migrate-paymaster", "migrate-metadata"])
    assert.equal(compose.services[name].image, postgres, name);
  assert.match(
    restore,
    new RegExp(postgres.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("Dockerfiles pin reviewed Node and Nginx image digests", () => {
  const node = locked("node");
  const nginx = locked("nginx");
  assert.equal(offchain.match(new RegExp(`FROM ${node}`, "g"))?.length, 5);
  assert.equal(
    offchain.match(
      /rm -rf \/opt\/yarn-v1\.22\.22 \/usr\/local\/lib\/node_modules\/npm/g,
    )?.length,
    3,
  );
  assert.match(demo, new RegExp(`FROM ${node} AS build`));
  assert.match(demo, new RegExp(`FROM ${nginx}\\n`));
  assert.match(demo, /USER root\nRUN apk upgrade --no-cache[\s\S]*USER 101/);
});

test("offchain runtime images include their compiled SDK dependency", () => {
  assert.equal(
    offchain.match(
      /COPY --from=build --chown=node:node \/app\/dist\/offchain\/sdk \.\/dist\/offchain\/sdk/g,
    )?.length,
    3,
  );
});

test("application images validate and publish the exact source revision", () => {
  assert.equal(
    offchain.match(/ARG CPREDICT_IMAGE_REVISION/g)?.length,
    3,
  );
  assert.equal(
    offchain.match(/LABEL org\.opencontainers\.image\.revision=/g)?.length,
    3,
  );
  assert.match(demo, /ARG CPREDICT_IMAGE_REVISION/);
  assert.match(demo, /LABEL org\.opencontainers\.image\.revision=/);
  for (const dockerfile of [offchain, demo])
    assert.match(
      dockerfile,
      /grep -Eq '\^\[0-9a-f\]\{40\}\$'/,
    );
});

test("Docker context excludes secrets, local tools and generated runtime state", async () => {
  const ignore = await readFile(new URL(".dockerignore", root), "utf8");
  for (const entry of [
    ".git",
    ".env.*",
    ".tools",
    "node_modules",
    "runtime",
    "broadcast",
  ])
    assert.match(
      ignore,
      new RegExp(
        `^${entry.replaceAll(".", "\\.").replaceAll("*", ".*")}$`,
        "m",
      ),
      entry,
    );
});

test("runtime sync docs rely on the orchestrator state instead of the obsolete root broadcast path", async () => {
  const documents = await Promise.all([
    readFile(new URL("docs/zh/13-compose-runtime-operations.md", root), "utf8"),
    readFile(new URL("deployments/arbitrum-sepolia/README.md", root), "utf8"),
  ]);
  for (const document of documents) {
    assert.doesNotMatch(
      document,
      /--broadcast broadcast\/DeployArbitrumSepolia/,
    );
    assert.match(document, /deploy:sync -- candidate/);
  }
});

test("CI builds and scans every application image with the pinned scanner", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/ci.yml", root),
    "utf8",
  );
  const dependabot = await readFile(
    new URL(".github/dependabot.yml", root),
    "utf8",
  );
  const bootstrap = await readFile(
    new URL("scripts/security/bootstrap-trivy.sh", root),
    "utf8",
  );
  const scanner = await readFile(
    new URL("scripts/security/scan-container-images.sh", root),
    "utf8",
  );
  assert.match(workflow, /bootstrap-trivy\.sh/);
  assert.match(workflow, /npm run scan:container-images/);
  assert.match(workflow, /npm run scan:container-config/);
  assert.equal(
    workflow.match(/--build-arg "CPREDICT_IMAGE_REVISION=\$GITHUB_SHA"/g)?.length,
    4,
  );
  assert.match(
    workflow,
    /docker image inspect --format[^\n]*org\.opencontainers\.image\.revision/,
  );
  assert.match(bootstrap, /expected_version="0\.73\.0"/);
  assert.match(scanner, /--severity HIGH,CRITICAL/);
  assert.match(scanner, /--ignore-unfixed/);
  assert.match(scanner, /--disable-telemetry/);
  for (const image of [
    "cpredict-indexer:ci",
    "cpredict-paymaster:ci",
    "cpredict-metadata:ci",
    "cpredict-web-demo:ci",
  ])
    assert.match(
      scanner,
      new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  assert.match(
    scanner,
    new RegExp(locked("postgres").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(scanner, /--skip-files usr\/local\/bin\/gosu/);
  assert.equal(
    lock.scannerExceptions[0].source,
    "https://github.com/tianon/gosu/blob/master/SECURITY.md",
  );
  assert.match(
    dependabot,
    /package-ecosystem: docker[\s\S]*directories:[\s\S]*\/deploy\/compose/,
  );
});
