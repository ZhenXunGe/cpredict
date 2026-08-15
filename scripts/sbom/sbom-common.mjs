import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const SBOM_PATH = "manifests/sbom.spdx.json";
export const LICENSES_PATH = "manifests/licenses.json";
export const NOTICES_PATH = "manifests/third-party-notices.md";

const LOCK_PATHS = [
  "package.json",
  "package-lock.json",
  "manifests/dependencies.lock",
  "manifests/binary-evidence.lock",
  "manifests/security-tools.lock",
  "manifests/halmos-wheels.lock",
  "manifests/load-tools.lock",
  "manifests/postgresql-tools.lock",
  "manifests/requirements.lock",
  "manifests/solidity-skills.lock",
];

const SOURCE_DEPENDENCIES = {
  "openzeppelin-contracts": {
    license: "MIT",
    kind: "source",
    scope: "lib/openzeppelin-contracts/contracts/**",
  },
  "forge-std": {
    license: "MIT OR Apache-2.0",
    kind: "tool",
    scope: "lib/forge-std/src/** (test and deployment tooling)",
  },
  permit2: {
    license: "MIT",
    kind: "source",
    scope:
      "production: lib/permit2/src/interfaces/ISignatureTransfer.sol and IEIP712.sol; test deployment: lib/permit2/src/**",
  },
  "solmate-permit2-submodule": {
    license: "AGPL-3.0-only",
    kind: "source",
    scope:
      "test Permit2 deployment closure: lib/permit2/lib/solmate/src/tokens/ERC20.sol and utils/SafeTransferLib.sol",
  },
  "account-abstraction": {
    license: "GPL-3.0-only",
    kind: "source",
    scope:
      "compiled imports are SPDX-MIT lib/account-abstraction/contracts/interfaces/{IEntryPoint.sol,IPaymaster.sol,PackedUserOperation.sol,IStakeManager.sol,IAggregator.sol,INonceManager.sol,ISenderCreator.sol}; repository LICENSE is GPL-3.0",
  },
  solidity: {
    license: "GPL-3.0-only",
    kind: "tool",
    scope: "compiler binary only",
  },
  foundry: {
    license: "MIT OR Apache-2.0",
    kind: "tool",
    scope: "build/test toolchain only",
  },
};

const TOOL_LICENSES = {
  "slither-analyzer": "AGPL-3.0-only",
  "crytic-compile": "AGPL-3.0-only",
  "solc-select": "MIT",
  foundry: "MIT OR Apache-2.0",
  aderyn: "GPL-3.0-only",
  echidna: "AGPL-3.0-only",
  medusa: "AGPL-3.0-only",
  "solidity-smtchecker": "GPL-3.0-only",
  halmos: "AGPL-3.0-only",
  k6: "AGPL-3.0-only",
  anvil: "MIT OR Apache-2.0",
  node: "MIT",
  postgresql: "PostgreSQL",
  "trailofbits-solidity-skills": "CC-BY-SA-4.0",
};

const SECURITY_TOOL_NAMES = new Set([
  "slither-analyzer",
  "crytic-compile",
  "solc-select",
  "foundry",
  "aderyn",
  "echidna",
  "medusa",
  "solidity-smtchecker",
  "halmos",
]);
const LOAD_TOOL_NAMES = new Set(["k6", "anvil", "node"]);
const TOOL_HASH_KEYS = {
  "slither-analyzer": "slither-analyzer-record-sha256",
  "crytic-compile": "crytic-compile-record-sha256",
  "solc-select": "solc-select-record-sha256",
  foundry: "forge-sha256",
  aderyn: "aderyn-archive-sha256",
  echidna: "echidna-archive-sha256",
  medusa: "medusa-archive-sha256",
  "solidity-smtchecker": "solidity-smtchecker-binary-sha256",
  halmos: "halmos-pypi-wheel-sha256",
  k6: "k6-archive-sha256",
  anvil: "anvil-binary-sha256",
  postgresql: "postgresql-archive-sha256",
};
const ACCEPTED_LICENSE_EXPRESSIONS = new Set([
  "AGPL-3.0-only",
  "Apache-2.0",
  "BSD-3-Clause",
  "CC-BY-SA-4.0",
  "GPL-3.0-only",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "MPL-2.0",
  "NOASSERTION",
  "PostgreSQL",
  "Unlicense",
]);

export async function createSbomArtifacts(root) {
  const lockBytes = new Map();
  for (const path of LOCK_PATHS)
    lockBytes.set(path, await readFile(join(root, path)));
  const packageLock = parseJson(
    lockBytes.get("package-lock.json"),
    "package-lock.json",
  );
  const packageJson = parseJson(lockBytes.get("package.json"), "package.json");
  assert(
    packageJson.name === "cpredict-protocol" &&
      typeof packageJson.version === "string",
    "package.json project identity drift",
  );
  assert(packageJson.license === "MIT", "package.json project license drift");
  assert(
    packageLock.lockfileVersion === 3,
    "package-lock.json must use lockfileVersion 3",
  );
  assertPlainObject(packageLock.packages, "package-lock packages");

  const npmPackages = npmPackageRecords(packageLock);
  const sourcePackages = pipeLockRecords(
    lockBytes.get("manifests/dependencies.lock").toString("utf8"),
    "manifests/dependencies.lock",
  ).map((record) => {
    const policy = SOURCE_DEPENDENCIES[record.name];
    assert(
      policy !== undefined,
      `unclassified Solidity dependency ${record.name}`,
    );
    return externalPackage(
      record.name,
      record.version,
      policy.license,
      record.lockPath,
      policy.scope,
      undefined,
      policy.kind,
    );
  });
  const tools = [
    ...selectedPipeRecords(
      lockBytes.get("manifests/security-tools.lock"),
      "manifests/security-tools.lock",
      SECURITY_TOOL_NAMES,
    ),
    ...selectedPipeRecords(
      lockBytes.get("manifests/load-tools.lock"),
      "manifests/load-tools.lock",
      LOAD_TOOL_NAMES,
    ),
    ...selectedPipeRecords(
      lockBytes.get("manifests/postgresql-tools.lock"),
      "manifests/postgresql-tools.lock",
      new Set(["postgresql"]),
    ),
    ...halmosWheelRecords(lockBytes.get("manifests/halmos-wheels.lock")),
    soliditySkillsRecord(lockBytes.get("manifests/solidity-skills.lock")),
  ].map((record) =>
    externalPackage(
      record.name,
      record.version,
      TOOL_LICENSES[record.name] ?? record.license ?? "NOASSERTION",
      record.lockPath,
      record.scope ??
        "build, test, analysis, or operational tooling; not linked into deployed contract runtime",
      record.sha256,
    ),
  );
  for (const item of tools) {
    const name = item.spdx.name;
    if (TOOL_HASH_KEYS[name] !== undefined)
      assert(
        item.spdx.checksums.length === 1,
        `tool artifact hash missing for ${name}`,
      );
  }

  const allPackages = [...npmPackages, ...sourcePackages, ...tools];
  assertUnique(
    allPackages.map((item) => item.identity),
    "SBOM package identity",
  );
  allPackages.sort((a, b) => compare(a.identity, b.identity));
  const rootId = "SPDXRef-Package-cpredict-protocol";
  const inputDigest = sha256(
    Buffer.concat(
      [...lockBytes]
        .sort(([a], [b]) => compare(a, b))
        .flatMap(([path, bytes]) => [Buffer.from(`${path}\0`), bytes]),
    ),
  );
  const packages = [
    projectPackage(rootId, packageJson),
    ...allPackages.map((item) => item.spdx),
  ];
  const relationships = [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootId,
    },
    ...allPackages.map((item) => ({
      spdxElementId:
        item.kind === "runtime" || item.kind === "source"
          ? rootId
          : item.spdx.SPDXID,
      relationshipType:
        item.kind === "runtime" || item.kind === "source"
          ? "DEPENDS_ON"
          : "BUILD_DEPENDENCY_OF",
      relatedSpdxElement:
        item.kind === "runtime" || item.kind === "source"
          ? item.spdx.SPDXID
          : rootId,
    })),
  ].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "cpredict-protocol-sbom",
    documentNamespace: `https://cpredict.example.invalid/spdx/${inputDigest}`,
    creationInfo: {
      created: "1970-01-01T00:00:00Z",
      creators: ["Tool: cpredict-sbom-generator-1"],
      comment:
        "Deterministic timestamp. Package licenses are declarations from lock metadata or the explicit inventory; no legal conclusion is expressed.",
    },
    documentDescribes: [rootId],
    packages,
    relationships,
    annotations: [
      {
        annotationDate: "1970-01-01T00:00:00Z",
        annotationType: "OTHER",
        annotator: "Tool: cpredict-sbom-generator-1",
        comment: `Input locks SHA-256: ${[...lockBytes]
          .sort(([a], [b]) => compare(a, b))
          .map(([path, bytes]) => `${path}=${sha256(bytes)}`)
          .join(", ")}`,
      },
    ],
  };
  const licenses = {
    schemaVersion: 1,
    legalConclusion: false,
    disclaimer:
      "Inventory of declared SPDX expressions and lock metadata only; obtain legal advice for distribution decisions.",
    packages: allPackages.map((item) => ({
      identity: item.identity,
      kind: item.kind,
      declared: item.spdx.licenseDeclared,
      concluded: "NOASSERTION",
      provenance: item.provenance,
      sourceScope: item.scope,
    })),
  };
  const notices = createNotices(licenses);
  validateSbomArtifacts({ sbom, licenses, notices }, packageLock);
  return { sbom, licenses, notices };
}

export function validateSbomArtifacts(artifacts, packageLock) {
  const { sbom, licenses, notices } = artifacts;
  assert(sbom.spdxVersion === "SPDX-2.3", "SBOM must be SPDX 2.3");
  assert(sbom.dataLicense === "CC0-1.0", "SBOM dataLicense drift");
  assert(
    /^https:\/\/cpredict\.example\.invalid\/spdx\/[0-9a-f]{64}$/.test(
      sbom.documentNamespace,
    ),
    "invalid deterministic SBOM namespace",
  );
  assert(
    Array.isArray(sbom.packages) && sbom.packages.length > 1,
    "SBOM package inventory is empty",
  );
  assertUnique(
    sbom.packages.map((item) => item.SPDXID),
    "SPDXID",
  );
  for (const item of sbom.packages) {
    assertExactKeys(
      item,
      [
        "SPDXID",
        "checksums",
        "comment",
        "copyrightText",
        "downloadLocation",
        "filesAnalyzed",
        "licenseConcluded",
        "licenseDeclared",
        "name",
        "versionInfo",
      ],
      `SPDX package ${item.name}`,
    );
    assert(
      /^SPDXRef-Package-[A-Za-z0-9.-]+$/.test(item.SPDXID),
      `invalid SPDXID ${item.SPDXID}`,
    );
    assert(
      typeof item.licenseDeclared === "string" &&
        item.licenseDeclared.length > 0,
      `missing licenseDeclared for ${item.name}`,
    );
    assert(
      ACCEPTED_LICENSE_EXPRESSIONS.has(item.licenseDeclared),
      `unreviewed SPDX license expression for ${item.name}: ${item.licenseDeclared}`,
    );
    assert(
      item.licenseConcluded === "NOASSERTION",
      `licenseConcluded must remain NOASSERTION for ${item.name}`,
    );
    assert(Array.isArray(item.checksums), `checksums missing for ${item.name}`);
    for (const checksum of item.checksums) {
      assert(
        ["SHA256", "SHA512"].includes(checksum.algorithm),
        `unsupported checksum for ${item.name}`,
      );
      assert(
        /^[0-9a-f]+$/.test(checksum.checksumValue),
        `invalid checksum value for ${item.name}`,
      );
    }
  }
  const expectedNpm = Object.keys(packageLock.packages).filter(Boolean).length;
  const actualNpm = licenses.packages.filter(
    (item) => item.kind === "runtime" || item.kind === "development",
  ).length;
  assert(
    actualNpm === expectedNpm,
    `npm package inventory mismatch: expected ${expectedNpm}, got ${actualNpm}`,
  );
  assert(
    licenses.schemaVersion === 1 && licenses.legalConclusion === false,
    "license inventory schema drift",
  );
  assertUnique(
    licenses.packages.map((item) => item.identity),
    "license identity",
  );
  assert(notices.endsWith("\n"), "third-party notices must end in newline");
  for (const name of [
    "permit2",
    "solmate-permit2-submodule",
    "account-abstraction",
  ]) {
    const item = licenses.packages.find((entry) =>
      entry.identity.startsWith(`solidity:${name}@`),
    );
    assert(
      item !== undefined && item.sourceScope.includes("lib/"),
      `missing actual source SPDX scope for ${name}`,
    );
  }
}

export function serializeSbomArtifacts(artifacts) {
  return {
    [SBOM_PATH]: `${JSON.stringify(artifacts.sbom, null, 2)}\n`,
    [LICENSES_PATH]: `${JSON.stringify(artifacts.licenses, null, 2)}\n`,
    [NOTICES_PATH]: artifacts.notices,
  };
}

function npmPackageRecords(lock) {
  const records = [];
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (path === "") continue;
    assertPlainObject(metadata, `package-lock entry ${path}`);
    for (const key of ["version", "license", "integrity"]) {
      assert(
        typeof metadata[key] === "string" && metadata[key].length > 0,
        `package-lock ${path} missing ${key}`,
      );
    }
    const name = npmNameFromPath(path);
    const integrity = parseIntegrity(metadata.integrity, path);
    const identity = `npm:${name}@${metadata.version}:${path}`;
    records.push({
      identity,
      kind: metadata.dev ? "development" : "runtime",
      provenance: `package-lock.json#packages[${JSON.stringify(path)}]`,
      scope: metadata.dev
        ? "Node development dependency"
        : "Node runtime dependency",
      spdx: {
        SPDXID: spdxId(identity),
        name,
        versionInfo: metadata.version,
        downloadLocation: metadata.resolved ?? "NOASSERTION",
        filesAnalyzed: false,
        checksums: [
          { algorithm: integrity.algorithm, checksumValue: integrity.hex },
        ],
        licenseConcluded: "NOASSERTION",
        licenseDeclared: metadata.license,
        copyrightText: "NOASSERTION",
        comment: `Locked npm path ${path}; integrity verified against package-lock.json.`,
      },
    });
  }
  return records;
}

function externalPackage(
  name,
  version,
  license,
  lockPath,
  scope,
  checksum,
  kindOverride,
) {
  const ecosystem =
    lockPath === "manifests/dependencies.lock"
      ? "solidity"
      : lockPath === "manifests/halmos-wheels.lock"
        ? "python-wheel"
        : "tool";
  const identity = `${ecosystem}:${name}@${version}${ecosystem === "python-wheel" ? `:${checksum}` : ""}`;
  assert(
    checksum === undefined || /^[0-9a-f]{64}$/.test(checksum),
    `invalid locked SHA-256 for ${identity}`,
  );
  return {
    identity,
    kind: kindOverride ?? (ecosystem === "solidity" ? "source" : "tool"),
    provenance: lockPath,
    scope,
    spdx: {
      SPDXID: spdxId(identity),
      name,
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: checksum
        ? [{ algorithm: "SHA256", checksumValue: checksum }]
        : [],
      licenseConcluded: "NOASSERTION",
      licenseDeclared: license,
      copyrightText: "NOASSERTION",
      comment: `${scope}. Declared license inventory only; no legal conclusion. Provenance: ${lockPath}.`,
    },
  };
}

function pipeLockRecords(text, lockPath) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const fields = line.split("|").map((field) => field.trim());
      assert(fields.length >= 2, `malformed lock row in ${lockPath}: ${line}`);
      return {
        name: fields[0],
        version: fields[2] ?? fields[1],
        fields,
        lockPath,
      };
    });
}

function selectedPipeRecords(bytes, lockPath, selected) {
  const text = bytes.toString("utf8");
  return pipeLockRecords(text, lockPath)
    .filter((record) => selected.has(record.name))
    .map((record) => {
      const key = TOOL_HASH_KEYS[record.name];
      return {
        ...record,
        version: record.fields[1],
        sha256: key === undefined ? undefined : lockHash(text, key, lockPath),
      };
    });
}

function lockHash(text, key, lockPath) {
  const row = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${key} |`));
  assert(row !== undefined, `${lockPath} missing ${key}`);
  const hash = row
    .split("|")
    .map((field) => field.trim())
    .find((field) => /^[0-9a-f]{64}$/.test(field));
  assert(hash !== undefined, `${lockPath} has invalid ${key}`);
  return hash;
}

function halmosWheelRecords(bytes) {
  return bytes
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(
        /^([^= ]+)==([^ |]+)\s+\|.*\|\s+sha256:([0-9a-f]{64})$/,
      );
      assert(match, `malformed halmos wheel lock row: ${line}`);
      return {
        name: match[1],
        version: match[2],
        sha256: match[3],
        lockPath: "manifests/halmos-wheels.lock",
      };
    });
}

function soliditySkillsRecord(bytes) {
  const values = Object.fromEntries(
    bytes
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        assert(index > 0, `malformed solidity skills lock row: ${line}`);
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert(
    /^[0-9a-f]{40}$/.test(values.commit),
    "invalid solidity skills commit",
  );
  assert(values.license === "CC-BY-SA-4.0", "solidity skills license drift");
  return {
    name: "trailofbits-solidity-skills",
    version: values.commit,
    license: values.license,
    lockPath: "manifests/solidity-skills.lock",
  };
}

function projectPackage(id, packageJson) {
  return {
    SPDXID: id,
    name: packageJson.name,
    versionInfo: packageJson.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    checksums: [],
    licenseConcluded: "NOASSERTION",
    licenseDeclared: packageJson.license,
    copyrightText: "NOASSERTION",
    comment:
      "Project package; source-file hashes are bound separately by manifests/source-manifest.json.",
  };
}

function createNotices(licenses) {
  const groups = new Map();
  for (const item of licenses.packages) {
    const values = groups.get(item.declared) ?? [];
    values.push(item.identity);
    groups.set(item.declared, values);
  }
  const lines = [
    "# Third-party notices",
    "",
    "Generated deterministically from locked dependency metadata. This is an inventory of declared licenses, not legal advice or a license conclusion.",
    "",
  ];
  for (const license of [...groups.keys()].sort(compare)) {
    lines.push(`## ${license}`, "");
    for (const identity of groups.get(license).sort(compare))
      lines.push(`- ${identity}`);
    lines.push("");
  }
  lines.push(
    "See `manifests/licenses.json` for provenance and actual Solidity source scope details.",
    "",
  );
  return lines.join("\n");
}

function npmNameFromPath(path) {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  assert(index >= 0, `invalid package-lock package path ${path}`);
  return path.slice(index + marker.length);
}

function parseIntegrity(value, path) {
  const match = value.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  assert(match, `package-lock ${path} integrity must be sha512`);
  const decoded = Buffer.from(match[1], "base64");
  assert(
    decoded.length === 64,
    `package-lock ${path} sha512 integrity length mismatch`,
  );
  return { algorithm: "SHA512", hex: decoded.toString("hex") };
}

function spdxId(identity) {
  return `SPDXRef-Package-${sha256(identity).slice(0, 24)}`;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function compare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `duplicate ${label}`);
}
function assertPlainObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}
function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unknown or missing keys`,
  );
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
