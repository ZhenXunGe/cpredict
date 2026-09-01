import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;

export async function writeGateEvidence(options) {
  const root = resolve(options.root ?? process.cwd());
  const output = insideRoot(root, options.output, "output");
  const acceptedToolExitCodes = parseExitCodes(
    options.acceptedToolExitCodes ?? "0",
  );
  const toolExitCode = parseExitCode(options.toolExitCode, "tool exit code");
  const validatorExitCode = parseExitCode(
    options.validatorExitCode,
    "validator exit code",
  );
  requireToken(options.gate, "gate");
  requireToken(options.tool, "tool");
  requireToken(options.version, "version");
  if (!SHA256.test(options.artifactSha256 ?? "")) {
    throw new Error(
      "artifact SHA-256 must contain exactly 64 lowercase hex characters",
    );
  }

  const inputs = await inventory(root, options.inputs ?? [], "input");
  const evidence = await inventory(root, options.evidence ?? [], "evidence");
  if (inputs.length === 0)
    throw new Error("security evidence input inventory is empty");
  if (evidence.length === 0)
    throw new Error("security evidence artifact inventory is empty");
  const sourceSnapshotSha256 = hashInventory(inputs);
  if (options.expectedSourceSnapshotSha256 !== undefined) {
    if (!SHA256.test(options.expectedSourceSnapshotSha256)) {
      throw new Error("expected source snapshot SHA-256 is invalid");
    }
    if (sourceSnapshotSha256 !== options.expectedSourceSnapshotSha256) {
      throw new Error("security evidence inputs drifted during gate execution");
    }
  }

  const result =
    acceptedToolExitCodes.includes(toolExitCode) && validatorExitCode === 0
      ? "PASS"
      : "FAIL";
  const document = {
    schemaVersion: 1,
    gate: options.gate,
    result,
    tool: {
      name: options.tool,
      version: options.version,
      artifactSha256: options.artifactSha256,
      rawExitCode: toolExitCode,
      acceptedExitCodes: acceptedToolExitCodes,
    },
    validatorExitCode,
    platform: `${process.platform}-${process.arch}`,
    sourceSnapshotSha256,
    inputs,
    evidence,
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(output, serialized, "utf8");
  const metadataHash = sha256(Buffer.from(serialized));
  await writeFile(
    `${output}.sha256`,
    `${metadataHash}  ${basename(output)}\n`,
    "utf8",
  );
  return document;
}

export async function hashInputInventory(root, requestedPaths) {
  const resolvedRoot = resolve(root ?? process.cwd());
  const inputs = await inventory(resolvedRoot, requestedPaths, "input");
  if (inputs.length === 0)
    throw new Error("security evidence input inventory is empty");
  return hashInventory(inputs);
}

async function inventory(root, requestedPaths, label) {
  const files = [];
  for (const requestedPath of requestedPaths) {
    const absolute = insideRoot(root, requestedPath, label);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(
        `${label} path cannot be a symbolic link: ${requestedPath}`,
      );
    if (metadata.isDirectory()) {
      await collectDirectory(root, absolute, files, label);
    } else if (metadata.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(
        `${label} path is not a regular file or directory: ${requestedPath}`,
      );
    }
  }
  const unique = [...new Set(files)].sort();
  return Promise.all(
    unique.map(async (absolute) => {
      const bytes = await readFile(absolute);
      return {
        path: relative(root, absolute).split(sep).join("/"),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    }),
  );
}

async function collectDirectory(root, directory, files, label) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    insideRoot(root, absolute, label);
    if (entry.isSymbolicLink())
      throw new Error(
        `${label} directory contains a symbolic link: ${relative(root, absolute)}`,
      );
    if (entry.isDirectory())
      await collectDirectory(root, absolute, files, label);
    else if (entry.isFile()) files.push(absolute);
    else
      throw new Error(
        `${label} directory contains a non-regular entry: ${relative(root, absolute)}`,
      );
  }
}

function hashInventory(entries) {
  const canonical = entries
    .map((entry) => `${entry.path}|${entry.bytes}|${entry.sha256}`)
    .join("\n");
  return sha256(Buffer.from(`${canonical}\n`));
}

function insideRoot(root, path, label) {
  if (typeof path !== "string" || path.length === 0)
    throw new Error(`${label} path is missing`);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} path escapes repository root: ${path}`);
  }
  return absolute;
}

function parseExitCode(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255)
    throw new Error(`${label} is invalid`);
  return parsed;
}

function parseExitCodes(value) {
  const parsed = [
    ...new Set(
      String(value)
        .split(",")
        .map((entry) => parseExitCode(entry, "accepted tool exit code")),
    ),
  ];
  if (parsed.length === 0)
    throw new Error("accepted tool exit-code inventory is empty");
  return parsed.sort((left, right) => left - right);
}

function requireToken(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(arguments_) {
  const single = new Map([
    ["--root", "root"],
    ["--gate", "gate"],
    ["--tool", "tool"],
    ["--version", "version"],
    ["--artifact-sha256", "artifactSha256"],
    ["--tool-exit", "toolExitCode"],
    ["--accepted-tool-exits", "acceptedToolExitCodes"],
    ["--validator-exit", "validatorExitCode"],
    ["--output", "output"],
    ["--expected-source-snapshot-sha256", "expectedSourceSnapshotSha256"],
  ]);
  const options = { inputs: [], evidence: [] };
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--input") options.inputs.push(value);
    else if (flag === "--evidence") options.evidence.push(value);
    else if (single.has(flag)) options[single.get(flag)] = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  writeGateEvidence(parseArguments(process.argv.slice(2)))
    .then((document) => {
      process.stdout.write(
        `security evidence ${document.gate}: ${document.result}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `security evidence write failed: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
