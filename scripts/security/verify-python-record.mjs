import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [recordPath, expectedRecordSha256] = process.argv.slice(2);
if (
  recordPath === undefined ||
  !/^[0-9a-f]{64}$/.test(expectedRecordSha256 ?? "")
) {
  process.stderr.write(
    "usage: verify-python-record.mjs RECORD EXPECTED_RECORD_SHA256\n",
  );
  process.exit(64);
}

try {
  const record = await readFile(recordPath);
  if (sha256Hex(record) !== expectedRecordSha256)
    throw new Error("Python RECORD SHA-256 mismatch");
  let checked = 0;
  const seen = new Set();
  for (const line of record.toString("utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.split(",");
    if (fields.length !== 3 || fields[0].includes('"'))
      throw new Error("unsupported Python RECORD row");
    const [path, encodedHash, sizeText] = fields;
    if (seen.has(path))
      throw new Error(`duplicate Python RECORD path: ${path}`);
    seen.add(path);
    if (encodedHash.length === 0 && sizeText.length === 0) continue;
    if (!encodedHash.startsWith("sha256="))
      throw new Error(`unsupported Python RECORD hash: ${path}`);
    const expectedSize = Number(sizeText);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
      throw new Error(`invalid Python RECORD size: ${path}`);
    const bytes = await readFile(resolve(dirname(dirname(recordPath)), path));
    if (bytes.length !== expectedSize)
      throw new Error(`Python RECORD size mismatch: ${path}`);
    const actual = createHash("sha256").update(bytes).digest("base64url");
    if (actual !== encodedHash.slice("sha256=".length))
      throw new Error(`Python RECORD hash mismatch: ${path}`);
    checked += 1;
  }
  if (checked === 0) throw new Error("Python RECORD verified zero payloads");
  process.stdout.write(
    `verified Python RECORD and ${checked} installed payload hashes\n`,
  );
} catch (error) {
  process.stderr.write(`Python RECORD verification failed: ${error.message}\n`);
  process.exitCode = 1;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
