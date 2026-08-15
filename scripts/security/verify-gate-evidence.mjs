import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const [metadataPath, requirePassFlag] = process.argv.slice(2);
if (
  metadataPath === undefined ||
  (requirePassFlag !== undefined && requirePassFlag !== "--require-pass")
) {
  process.stderr.write(
    "usage: verify-gate-evidence.mjs METADATA.json [--require-pass]\n",
  );
  process.exit(64);
}

try {
  const root = process.cwd();
  const absoluteMetadata = insideRoot(root, metadataPath);
  const bytes = await readFile(absoluteMetadata);
  const sidecar = await readFile(`${absoluteMetadata}.sha256`, "utf8");
  const expectedSidecar = `${sha256(bytes)}  ${basename(absoluteMetadata)}\n`;
  if (sidecar !== expectedSidecar)
    throw new Error("security evidence metadata sidecar mismatch");
  const document = JSON.parse(bytes.toString("utf8"));
  assertExactKeys(
    document,
    [
      "schemaVersion",
      "gate",
      "result",
      "tool",
      "validatorExitCode",
      "platform",
      "sourceSnapshotSha256",
      "inputs",
      "evidence",
    ],
    "security evidence metadata",
  );
  assertExactKeys(
    document.tool,
    ["name", "version", "artifactSha256", "rawExitCode", "acceptedExitCodes"],
    "security evidence tool",
  );
  if (document.schemaVersion !== 1)
    throw new Error("unsupported security evidence schema");
  if (!/^[0-9a-f]{64}$/.test(document.tool.artifactSha256))
    throw new Error("invalid tool artifact SHA-256");
  if (
    !Array.isArray(document.tool.acceptedExitCodes) ||
    document.tool.acceptedExitCodes.length === 0
  ) {
    throw new Error("accepted tool exit-code inventory is empty");
  }
  const expectedResult =
    document.tool.acceptedExitCodes.includes(document.tool.rawExitCode) &&
    document.validatorExitCode === 0
      ? "PASS"
      : "FAIL";
  if (document.result !== expectedResult)
    throw new Error("security evidence result does not match exit codes");
  await verifyInventory(root, document.inputs, "input");
  await verifyInventory(root, document.evidence, "evidence");
  if (hashInventory(document.inputs) !== document.sourceSnapshotSha256) {
    throw new Error("security evidence source snapshot SHA-256 mismatch");
  }
  if (requirePassFlag === "--require-pass" && document.result !== "PASS") {
    throw new Error(`security gate is not PASS: ${document.gate}`);
  }
  process.stdout.write(
    `verified security evidence ${document.gate}: ${document.result}\n`,
  );
} catch (error) {
  process.stderr.write(
    `security evidence verification failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}

async function verifyInventory(root, inventory, label) {
  if (!Array.isArray(inventory) || inventory.length === 0)
    throw new Error(`${label} inventory is empty`);
  const paths = [];
  for (const entry of inventory) {
    assertExactKeys(
      entry,
      ["path", "bytes", "sha256"],
      `${label} inventory entry`,
    );
    const absolute = insideRoot(root, entry.path);
    const bytes = await readFile(absolute);
    if (bytes.length !== entry.bytes)
      throw new Error(`${label} size drift: ${entry.path}`);
    if (sha256(bytes) !== entry.sha256)
      throw new Error(`${label} SHA-256 drift: ${entry.path}`);
    paths.push(entry.path);
  }
  if (new Set(paths).size !== paths.length)
    throw new Error(`${label} inventory contains duplicate paths`);
  const sorted = [...paths].sort();
  if (JSON.stringify(paths) !== JSON.stringify(sorted))
    throw new Error(`${label} inventory is not sorted`);
}

function hashInventory(entries) {
  const canonical = entries
    .map((entry) => `${entry.path}|${entry.bytes}|${entry.sha256}`)
    .join("\n");
  return sha256(Buffer.from(`${canonical}\n`));
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw new Error(`${label} key inventory changed`);
}

function insideRoot(root, path) {
  if (typeof path !== "string" || path.length === 0)
    throw new Error("security evidence path is missing");
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
    throw new Error(`security evidence path escapes root: ${path}`);
  return absolute;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
