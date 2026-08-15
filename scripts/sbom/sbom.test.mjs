import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
