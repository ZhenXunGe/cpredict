import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_PATTERNS = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  ],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["stripe-live-secret", /\bsk_live_[0-9A-Za-z]{16,}\b/g],
  ["jwt", /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g],
];

const CONTEXT_PATTERNS = [
  [
    "hex-private-key",
    /\b(?:PRIVATE_KEY|DEPLOYER_KEY|SIGNER_KEY|SPONSOR_SIGNING_KEY)\b\s*[:=]\s*["']?(?:0x)?[0-9a-f]{64}\b/gi,
  ],
  [
    "mnemonic",
    /\b(?:MNEMONIC|SEED_PHRASE)\b\s*[:=]\s*["']?[a-z]+(?:\s+[a-z]+){11,23}["']?/gi,
  ],
  ["embedded-url-credential", /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{8,}@[^\s/]+/gi],
  [
    "bearer-token",
    /\b(?:AUTHORIZATION|AUTH_HEADER)\b\s*[:=]\s*["']?Bearer\s+[0-9A-Za-z._~-]{16,}/gi,
  ],
];

const GENERIC_ASSIGNMENT =
  /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|KMS_SECRET|RPC_TOKEN)\b\s*[:=]\s*["']?([^\s"'`#,;]{16,})/gi;
const PEM_PATTERN = new RegExp(
  "-----BEGIN " + "(?:RSA |EC |OPENSSH )?" + "PRIVATE KEY-----",
  "g",
);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function scanText(text) {
  const findings = new Set();
  if (PEM_PATTERN.test(text)) findings.add("private-key-pem");
  PEM_PATTERN.lastIndex = 0;
  for (const [name, pattern] of [...TOKEN_PATTERNS, ...CONTEXT_PATTERNS]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.add(name);
    pattern.lastIndex = 0;
  }
  GENERIC_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(GENERIC_ASSIGNMENT)) {
    if (!isPlaceholder(match[1])) findings.add("assigned-secret");
  }
  GENERIC_ASSIGNMENT.lastIndex = 0;
  return [...findings].sort();
}

async function main() {
  const binaryAllowlist = await readBinaryAllowlist();
  const seenAllowlistEntries = new Set();
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: null, maxBuffer: 32 * 1024 * 1024 },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error("git delivery-file inventory could not be enumerated");
  }
  const paths = listed.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  if (paths.length === 0)
    throw new Error("git delivery-file inventory is empty");

  const findings = [];
  let scannedPayloads = 0;
  let normalizedBinary = 0;
  for (const path of paths) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      findings.push({ path, pattern: "symbolic-link-not-scanned" });
      continue;
    }
    if (!metadata.isFile()) continue;
    const bytes = await readFile(path);
    let candidate = bytes;
    if (bytes.includes(0)) {
      const locked = binaryAllowlist.get(path);
      if (locked === undefined) {
        findings.push({ path, pattern: "binary-not-scanned" });
        continue;
      }
      seenAllowlistEntries.add(path);
      if (locked.bytes !== bytes.length || locked.sha256 !== sha256(bytes)) {
        findings.push({ path, pattern: "binary-allowlist-drift" });
        continue;
      }
      if (locked.normalization !== "remove-nul-padding") {
        findings.push({ path, pattern: "binary-normalization-unsupported" });
        continue;
      }
      candidate = Buffer.from(bytes.filter((byte) => byte !== 0));
      normalizedBinary += 1;
    }
    let text;
    try {
      text = UTF8_DECODER.decode(candidate);
    } catch {
      findings.push({ path, pattern: "binary-not-scanned" });
      continue;
    }
    scannedPayloads += 1;
    for (const pattern of scanText(text)) findings.push({ path, pattern });
  }

  for (const path of binaryAllowlist.keys()) {
    if (!seenAllowlistEntries.has(path))
      findings.push({ path, pattern: "binary-allowlist-entry-not-used" });
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `secret scan finding: ${finding.path} [${finding.pattern}]\n`,
      );
    }
    throw new Error(
      `${findings.length} possible delivery secret(s) found; values intentionally omitted`,
    );
  }
  process.stdout.write(
    `delivery secret scan passed: ${scannedPayloads} delivery payloads scanned total, including ${normalizedBinary} path/size/SHA-pinned binary ${normalizedBinary === 1 ? "payload" : "payloads"} normalized, 0 files skipped\n`,
  );
}

async function readBinaryAllowlist() {
  let contents;
  try {
    contents = await readFile("manifests/binary-evidence.lock", "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const entries = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split("|").map((field) => field.trim());
    if (fields.length !== 4)
      throw new Error("invalid binary evidence lock row");
    const [path, bytesText, hash, normalization] = fields;
    const bytes = Number(bytesText);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error(`invalid binary evidence length: ${path}`);
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`invalid binary evidence SHA-256: ${path}`);
    if (entries.has(path))
      throw new Error(`duplicate binary evidence lock path: ${path}`);
    entries.set(path, { bytes, sha256: hash, normalization });
  }
  return entries;
}

function isPlaceholder(value) {
  return (
    /^(?:<[^>]+>|\$\{[A-Z0-9_]+\}|\$[A-Z0-9_]+)$/i.test(value) ||
    /^(?:change-me|changeme|replace-me|replace_me|insert-here|your-key-here|example|placeholder|test|dummy|redacted|not-set|not_set)$/i.test(
      value,
    )
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`secret scan failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
