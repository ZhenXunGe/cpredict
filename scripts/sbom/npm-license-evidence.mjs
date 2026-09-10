import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Evidence for exact locked packages, never a default license or distribution approval. */
export async function readNpmLicenseEvidence(root, lock, inputs) {
  const path = "manifests/npm-license-evidence.json";
  const bytes = await readFile(join(root, path));
  inputs.set(path, bytes);
  const inventory = JSON.parse(bytes.toString("utf8"));
  if (
    inventory.schemaVersion !== 1 ||
    inventory.legalConclusion !== false ||
    !Array.isArray(inventory.entries)
  )
    throw new Error("invalid npm license evidence inventory");
  const declarations = new Map(),
    extracted = new Map();
  for (const e of inventory.entries) {
    const p = lock.packages[e.path];
    if (
      !p ||
      p.version !== e.version ||
      p.integrity !== e.integrity ||
      (p.license ?? null) !== e.lockDeclaration ||
      declarations.has(e.path)
    )
      throw new Error(`stale or duplicate npm license evidence: ${e.path}`);
    if (
      !/^manifests\/npm-licenses\/[a-f0-9]{64}\.txt$/.test(e.evidence) ||
      !/^[a-f0-9]{64}$/.test(e.sha256)
    )
      throw new Error(`invalid npm license evidence path: ${e.path}`);
    const source = await readFile(join(root, e.evidence));
    if (createHash("sha256").update(source).digest("hex") !== e.sha256)
      throw new Error(`npm license evidence checksum mismatch: ${e.path}`);
    inputs.set(e.evidence, source);
    if (e.declared.startsWith("LicenseRef-")) {
      if (
        e.declared !== `LicenseRef-Npm-${e.sha256.slice(0, 20)}` ||
        e.status !== "custom-license-review-required"
      )
        throw new Error(`invalid custom npm license identity: ${e.path}`);
      extracted.set(e.declared, {
        licenseId: e.declared,
        extractedText: source.toString("utf8"),
        name: "Locked npm package custom license",
        comment: `${e.evidence}; SHA-256 ${e.sha256}. Distribution terms require separate review.`,
      });
    } else if (!["MIT", "Apache-2.0", "NOASSERTION"].includes(e.declared))
      throw new Error(
        `unsupported supplemental license declaration: ${e.path}`,
      );
    if (e.declared === "NOASSERTION" && e.status !== "missing-license")
      throw new Error(`missing npm license must remain explicit: ${e.path}`);
    declarations.set(e.path, {
      declared: e.declared,
      provenance: `${path}#${e.path}; ${e.evidence}`,
      status: e.status,
    });
  }
  return {
    declarations,
    extracted: [...extracted.values()].sort((a, b) =>
      a.licenseId.localeCompare(b.licenseId),
    ),
  };
}
