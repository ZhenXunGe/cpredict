#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256Json } from "./evidence-lib.mjs";
import { buildVerificationPlan, verificationInputSha } from "./verify-source.mjs";

export async function validateSourceVerificationEvidence(evidence, manifest, evidencePath) {
  const plan = buildVerificationPlan(manifest);
  if (
    evidence?.schemaVersion !== "cpredict.arbitrum-sepolia.source-verification.v1" ||
    evidence.evidenceClass !== "ARBITRUM_SEPOLIA_RUNTIME" ||
    evidence.chainId !== 421614 || evidence.status !== "COMPLETE"
  ) throw new Error("source verification evidence is not COMPLETE Arbitrum Sepolia runtime evidence");
  if (evidence.sourceCommit !== manifest.source.commit || evidence.sourceManifestSha256 !== manifest.source.sourceManifestSha256)
    throw new Error("source verification source identity mismatch");
  if (evidence.inputSha256 !== verificationInputSha(manifest, plan))
    throw new Error("source verification input SHA-256 mismatch");
  if (!Array.isArray(evidence.contracts) || evidence.contracts.length !== 11)
    throw new Error("source verification evidence must contain exactly 11 contracts");
  const records = new Map(evidence.contracts.map((item) => [item.contract, item]));
  if (records.size !== 11) throw new Error("source verification contract inventory contains duplicates");
  const manifestRecords = [];
  for (const expected of plan) {
    const item = records.get(expected.contract);
    if (
      item?.status !== "VERIFIED" || item.constructorArgsVerified !== true ||
      item.runtimeBytecodeVerified !== true || item.address !== expected.address ||
      item.source !== expected.source || item.runtimeCodehash !== expected.runtimeCodehash ||
      item.sourceCommit !== manifest.source.commit || item.exitCode !== 0
    ) throw new Error(`${expected.contract}: source verification record mismatch`);
    if (basename(item.logFile ?? "") !== item.logFile)
      throw new Error(`${expected.contract}: logFile must be a basename`);
    const logPath = resolve(dirname(evidencePath), item.logFile);
    const metadata = await stat(logPath);
    if (metadata.size === 0 || await sha256File(logPath) !== item.logSha256)
      throw new Error(`${expected.contract}: verification log hash mismatch`);
    const expectedUrl = `https://sepolia.arbiscan.io/address/${expected.address}`;
    if (item.explorerUrl.toLowerCase() !== expectedUrl.toLowerCase())
      throw new Error(`${expected.contract}: explorer URL mismatch`);
    manifestRecords.push({
      contract: expected.contract,
      address: expected.address,
      status: "VERIFIED",
      explorerUrl: expectedUrl,
      constructorArgsVerified: true,
      runtimeBytecodeVerified: true,
    });
  }
  return { sha256: sha256Json(evidence), manifestRecords };
}

async function sha256File(path) { return sha256Text(await readFile(path)); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }

async function main() {
  const [evidencePath, manifestPath] = process.argv.slice(2);
  if (!evidencePath || !manifestPath)
    throw new Error("usage: validate-source-verification <evidence.json> <candidate-or-final-manifest.json>");
  const result = await validateSourceVerificationEvidence(
    await readJson(evidencePath), await readJson(manifestPath), evidencePath,
  );
  process.stdout.write(`PASS source verification evidence ${result.sha256}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
