import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  checkReleaseGates,
  REQUIRED_GATE_POLICY,
  RELEASE_GATES_PATH,
} from "./release-gates-common.mjs";

export function parseArguments(args) {
  let evidenceRoot;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--evidence-root")
      throw new Error(`unknown argument ${args[index]}`);
    evidenceRoot = args[index + 1];
    if (evidenceRoot === undefined)
      throw new Error("missing value for --evidence-root");
  }
  if (evidenceRoot === undefined)
    throw new Error("--evidence-root is required");
  return { evidenceRoot };
}

export async function aggregateReleaseGates({
  root = process.cwd(),
  evidenceRoot,
}) {
  const sourceManifestBytes = readFileSync(
    join(root, "manifests/source-manifest.json"),
  );
  const gates = REQUIRED_GATE_POLICY.map((policy) => {
    const bytes = readFileSync(join(evidenceRoot, policy.resultPath));
    return {
      id: policy.id,
      resultPath: policy.resultPath,
      sha256: sha256(bytes),
    };
  }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
  );
  const document = {
    schemaVersion: 2,
    sourceManifestSha256: sha256(sourceManifestBytes),
    gates,
  };
  const output = resolve(evidenceRoot, RELEASE_GATES_PATH);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(output, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  await checkReleaseGates(root, evidenceRoot);
  return document;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const document = await aggregateReleaseGates(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(
      `release gate index ready: ${document.gates.length} fresh PASS records\n`,
    );
  } catch (error) {
    process.stderr.write(
      `release gate aggregation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
