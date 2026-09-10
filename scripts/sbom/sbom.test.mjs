import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readNpmLicenseEvidence } from "./npm-license-evidence.mjs";
import {
  createSbomArtifacts,
  serializeSbomArtifacts,
  validateSbomArtifacts,
} from "./sbom-common.mjs";

test("SBOM covers every package-lock package and is byte deterministic", async () => {
  const first = await createSbomArtifacts(process.cwd());
  const second = await createSbomArtifacts(process.cwd());
  assert.deepEqual(
    serializeSbomArtifacts(first),
    serializeSbomArtifacts(second),
  );
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.doesNotThrow(() => validateSbomArtifacts(first, lock));
  assert.equal(
    first.licenses.packages.filter((item) =>
      ["runtime", "development"].includes(item.kind),
    ).length,
    Object.keys(lock.packages).filter(Boolean).length,
  );
});

test("SBOM preserves Permit2, Solmate and account-abstraction source-license boundaries", async () => {
  const { licenses } = await createSbomArtifacts(process.cwd());
  const permit2 = licenses.packages.find((item) =>
    item.identity.startsWith("solidity:permit2@"),
  );
  const solmate = licenses.packages.find((item) =>
    item.identity.startsWith("solidity:solmate-permit2-submodule@"),
  );
  const aa = licenses.packages.find((item) =>
    item.identity.startsWith("solidity:account-abstraction@"),
  );
  assert.match(
    permit2.sourceScope,
    /production: lib\/permit2\/src\/interfaces/,
  );
  assert.equal(solmate.declared, "AGPL-3.0-only");
  assert.match(aa.sourceScope, /SPDX-MIT lib\/account-abstraction/);
  assert.equal(aa.concluded, "NOASSERTION");
});

test("validator rejects missing license and checksum drift", async () => {
  const artifacts = await createSbomArtifacts(process.cwd());
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const copy = structuredClone(artifacts);
  copy.sbom.packages[1].licenseDeclared = "";
  assert.throws(
    () => validateSbomArtifacts(copy, lock),
    /missing licenseDeclared/,
  );
  const checksum = structuredClone(artifacts);
  checksum.sbom.packages.find(
    (item) => item.checksums.length > 0,
  ).checksums[0].checksumValue = "not-a-hash";
  assert.throws(
    () => validateSbomArtifacts(checksum, lock),
    /invalid checksum value/,
  );
});

test("custom licenses retain exact text and missing declarations remain unknown", async () => {
  const artifacts = await createSbomArtifacts(process.cwd());
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const missing = artifacts.sbom.packages.find(
    (p) => p.name === "@metamask/eth-json-rpc-provider",
  );
  assert.equal(missing.licenseDeclared, "NOASSERTION");
  assert.match(missing.comment, /missing-license/);
  const custom = structuredClone(artifacts);
  assert.ok(custom.sbom.hasExtractedLicensingInfos.length > 0);
  custom.sbom.hasExtractedLicensingInfos[0].extractedText += "changed";
  assert.throws(
    () => validateSbomArtifacts(custom, lock),
    /extracted license checksum drift/,
  );
});

test("supplemental license evidence rejects changed package versions and integrity", async () => {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  for (const field of ["version", "integrity"]) {
    const changed = structuredClone(lock);
    changed.packages["node_modules/@privy-io/api-base"][field] = "changed";
    await assert.rejects(
      () => readNpmLicenseEvidence(process.cwd(), changed, new Map()),
      /stale or duplicate npm license evidence/,
    );
  }
});

test("official source license copies reject mutable branches and a different npm release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-license-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "manifests"));
  await cp("manifests/npm-licenses", join(root, "manifests/npm-licenses"), {
    recursive: true,
  });
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const original = JSON.parse(
    await readFile("manifests/npm-license-evidence.json", "utf8"),
  );
  for (const field of ["sourceFile", "registrySource"]) {
    const inventory = structuredClone(original);
    const entry = inventory.entries.find(
      (entry) => entry.name === "@safe-global/safe-apps-sdk",
    );
    entry[field] =
      field === "sourceFile"
        ? entry.sourceFile.replace(entry.gitHead, "main")
        : `${entry.registrySource}-other`;
    await writeFile(
      join(root, "manifests/npm-license-evidence.json"),
      JSON.stringify(inventory),
    );
    await assert.rejects(
      () => readNpmLicenseEvidence(root, lock, new Map()),
      /unpinned official source license/,
    );
  }
});
