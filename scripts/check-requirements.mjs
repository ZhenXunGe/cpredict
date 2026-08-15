import { createHash } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = "manifests/requirements-traceability.json";
const MARKDOWN_PATH = "docs/zh/02-requirements-traceability.md";

const TOP_LEVEL_KEYS = [
  "extraction_policy",
  "generated_at",
  "requirements",
  "schema_version",
  "source",
  "status_definitions",
];
const SOURCE_KEYS = [
  "bytes",
  "date",
  "line_count",
  "lock_file",
  "name",
  "path",
  "sha256",
  "version",
];
const EXTRACTION_POLICY_KEYS = ["excluded", "included", "unit"];
const REQUIREMENT_KEYS = [
  "decision",
  "id",
  "implementation",
  "owner",
  "phase",
  "requirement",
  "scope",
  "source_lines",
  "status",
  "tests_evidence",
];
const SOURCE_LINE_KEYS = ["end", "start"];

export const ALLOWED_STATUSES = Object.freeze([
  "decision_required",
  "deferred",
  "external_required",
  "implemented_deviation",
  "implemented_static",
  "not_implemented",
  "partial",
]);
export const ALLOWED_PHASES = Object.freeze([
  "Conditional future",
  "Cross-phase",
  "MVP",
  "Phase 2",
  "Phase 3",
]);
export const ALLOWED_SCOPES = Object.freeze([
  "commercial-operations",
  "deployment-operations",
  "flagship-product",
  "governance-security",
  "offchain-repository",
  "protocol-contracts",
]);

const ID_PATTERN =
  /^PF-(?:ARCH|MECH|TOPIC|SETTLE|CHAIN|UX|RISK|BIZ|P2|P3)-(?!000)\d{3}$/;
const REPOSITORY_PATH_PATTERN =
  /(?:^|[\s("'`])((?:src|test|offchain|examples|docs|reports|script|scripts|manifests|generated|config|deployments)(?:\/[A-Za-z0-9_@.+-]+)+)/g;

export class RequirementCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequirementCheckError";
  }
}

export async function checkRequirements(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const manifestFile = resolveInside(
    root,
    options.manifestPath ?? MANIFEST_PATH,
    "manifest path",
  );
  const markdownFile = resolveInside(
    root,
    options.markdownPath ?? MARKDOWN_PATH,
    "Markdown path",
  );
  const manifest = await readJson(manifestFile, "requirements manifest");

  assertExactKeys(manifest, TOP_LEVEL_KEYS, "requirements manifest");
  assert(
    manifest.schema_version === "1.0.0",
    "unsupported requirements schema_version",
  );
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(manifest.generated_at),
    "invalid generated_at date",
  );
  assertPlainObject(manifest.source, "source");
  assertExactKeys(manifest.source, SOURCE_KEYS, "source");
  assertPlainObject(manifest.extraction_policy, "extraction_policy");
  assertExactKeys(
    manifest.extraction_policy,
    EXTRACTION_POLICY_KEYS,
    "extraction_policy",
  );
  for (const key of EXTRACTION_POLICY_KEYS) {
    assertNonEmptyString(
      manifest.extraction_policy[key],
      `extraction_policy.${key}`,
    );
  }

  const sourcePath = resolve(options.sourcePath ?? manifest.source.path);
  const sourceName = manifest.source.name;
  assertNonEmptyString(sourceName, "source.name");
  assertNonEmptyString(manifest.source.version, "source.version");
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(manifest.source.date),
    "invalid source.date",
  );
  assert(
    Number.isSafeInteger(manifest.source.bytes) && manifest.source.bytes > 0,
    "invalid source.bytes",
  );
  assert(
    Number.isSafeInteger(manifest.source.line_count) &&
      manifest.source.line_count > 0,
    "invalid source.line_count",
  );
  assert(
    /^[0-9a-f]{64}$/.test(manifest.source.sha256),
    "invalid source.sha256",
  );
  assertNonEmptyString(manifest.source.lock_file, "source.lock_file");

  const lockFile = resolveInside(
    root,
    manifest.source.lock_file,
    "source.lock_file",
  );
  const [sourceBytes, lockText, markdown] = await Promise.all([
    readFileRequired(sourcePath, "authoritative source"),
    readFileRequired(lockFile, "requirements lock", "utf8"),
    readFileRequired(markdownFile, "requirements Markdown", "utf8"),
  ]);
  const lock = parseLock(lockText);
  const actualSha = sha256(sourceBytes);
  const sourceText = sourceBytes.toString("utf8");
  assert(
    !sourceText.includes("\uFFFD"),
    "authoritative source is not valid UTF-8",
  );
  const actualLineCount = countLines(sourceText);

  assert(
    lock.name === sourceName,
    "requirements.lock source name does not match JSON",
  );
  assert(
    lock.version === manifest.source.version,
    "requirements.lock source version does not match JSON",
  );
  assert(
    lock.date === manifest.source.date,
    "requirements.lock source date does not match JSON",
  );
  assert(
    lock.bytes === manifest.source.bytes,
    "requirements.lock byte size does not match JSON",
  );
  assert(
    lock.sha256 === manifest.source.sha256,
    "requirements.lock SHA-256 does not match JSON",
  );
  assert(
    sourceBytes.length === manifest.source.bytes,
    "authoritative source byte size mismatch",
  );
  assert(
    actualSha === manifest.source.sha256,
    "authoritative source SHA-256 mismatch",
  );
  assert(
    actualLineCount === manifest.source.line_count,
    "authoritative source line count mismatch",
  );

  validateStatusDefinitions(manifest.status_definitions);
  assert(Array.isArray(manifest.requirements), "requirements must be an array");
  assert(manifest.requirements.length > 0, "requirements must not be empty");

  const ids = new Set();
  const repositoryPaths = new Set();
  for (const [index, requirement] of manifest.requirements.entries()) {
    const label = `requirements[${index}]`;
    assertPlainObject(requirement, label);
    assertExactKeys(requirement, REQUIREMENT_KEYS, label);
    assertNonEmptyString(requirement.id, `${label}.id`);
    assert(
      ID_PATTERN.test(requirement.id),
      `invalid stable requirement ID ${requirement.id}`,
    );
    assert(
      !ids.has(requirement.id),
      `duplicate requirement ID ${requirement.id}`,
    );
    ids.add(requirement.id);

    assert(
      ALLOWED_PHASES.includes(requirement.phase),
      `unknown phase for ${requirement.id}: ${requirement.phase}`,
    );
    assert(
      ALLOWED_SCOPES.includes(requirement.scope),
      `unknown scope for ${requirement.id}: ${requirement.scope}`,
    );
    assert(
      ALLOWED_STATUSES.includes(requirement.status),
      `unknown status for ${requirement.id}: ${requirement.status}`,
    );
    for (const field of [
      "requirement",
      "implementation",
      "tests_evidence",
      "owner",
      "decision",
    ]) {
      assertNonEmptyString(requirement[field], `${requirement.id}.${field}`);
    }

    assertPlainObject(
      requirement.source_lines,
      `${requirement.id}.source_lines`,
    );
    assertExactKeys(
      requirement.source_lines,
      SOURCE_LINE_KEYS,
      `${requirement.id}.source_lines`,
    );
    const { start, end } = requirement.source_lines;
    assert(
      Number.isSafeInteger(start),
      `${requirement.id} source start must be an integer`,
    );
    assert(
      Number.isSafeInteger(end),
      `${requirement.id} source end must be an integer`,
    );
    assert(
      start >= 1 && end <= actualLineCount && start <= end,
      `${requirement.id} source line range is invalid`,
    );
    const citedText = sourceText
      .split(/\r?\n/)
      .slice(start - 1, end)
      .join("\n");
    assert(
      citedText.trim().length > 0,
      `${requirement.id} cites only blank source lines`,
    );

    for (const field of ["implementation", "tests_evidence"]) {
      for (const path of extractRepositoryPaths(requirement[field]))
        repositoryPaths.add(path);
    }
  }

  await validateRepositoryPaths(root, repositoryPaths);
  const markdownResult = await validateMarkdown(
    markdown,
    manifest.requirements,
    markdownFile,
    root,
  );

  return {
    total: manifest.requirements.length,
    sourceBytes: sourceBytes.length,
    sourceLines: actualLineCount,
    sourceSha256: actualSha,
    repositoryPaths: repositoryPaths.size,
    markdownIds: markdownResult.ids,
    markdownLinks: markdownResult.links,
    phaseCounts: countBy(manifest.requirements, "phase"),
    statusCounts: countBy(manifest.requirements, "status"),
    scopeCounts: countBy(manifest.requirements, "scope"),
  };
}

async function validateMarkdown(markdown, requirements, markdownFile, root) {
  const expectedIds = requirements.map((item) => item.id);
  const tableRows = [...markdown.matchAll(/^\| (PF-[A-Z0-9]+-\d{3}) \|.*$/gm)];
  const tableIds = tableRows.map((match) => match[1]);
  assert(
    tableIds.length === expectedIds.length,
    "Markdown requirement table count does not match JSON",
  );
  assert(
    new Set(tableIds).size === tableIds.length,
    "Markdown requirement table contains duplicate IDs",
  );
  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(tableIds);
  const missing = expectedIds.filter((id) => !actualSet.has(id));
  const extra = tableIds.filter((id) => !expectedSet.has(id));
  assert(
    missing.length === 0,
    `Markdown requirement table is missing IDs: ${missing.join(", ")}`,
  );
  assert(
    extra.length === 0,
    `Markdown requirement table has unknown IDs: ${extra.join(", ")}`,
  );
  const expectedRows = requirements.map(renderRequirementMarkdownRow);
  for (let index = 0; index < expectedRows.length; index += 1) {
    assert(
      tableRows[index][0] === expectedRows[index],
      `Markdown requirement row drift for ${requirements[index].id}`,
    );
  }

  const declaredCounts = [...markdown.matchAll(/\*\*(\d+) 项稳定 ID\*\*/g)].map(
    (match) => Number(match[1]),
  );
  assert(
    declaredCounts.length === 1,
    "Markdown must declare exactly one stable-ID total",
  );
  assert(
    declaredCounts[0] === expectedIds.length,
    "Markdown declared stable-ID total does not match JSON",
  );

  const summaryRows = [
    ...markdown.matchAll(/^\| (phase|scope|status) \| ([^|]+?) \| (\d+) \|$/gm),
  ];
  const summaries = { phase: new Map(), scope: new Map(), status: new Map() };
  for (const [, dimension, rawKey, rawCount] of summaryRows) {
    const key = rawKey.trim();
    assert(
      !summaries[dimension].has(key),
      `Markdown contains duplicate ${dimension} count for ${key}`,
    );
    summaries[dimension].set(key, Number(rawCount));
  }
  for (const dimension of ["phase", "scope", "status"]) {
    const expected = countBy(requirements, dimension);
    assertMapsEqual(
      summaries[dimension],
      expected,
      `Markdown ${dimension} counts`,
    );
  }

  let links = 0;
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    assert(
      !target.includes("#"),
      `unsupported local Markdown link anchor: ${target}`,
    );
    const resolved = resolve(dirname(markdownFile), target);
    assertWithinRoot(
      root,
      resolved,
      `Markdown link escapes repository: ${target}`,
    );
    await accessRequired(resolved, `missing Markdown link target ${target}`);
    links += 1;
  }
  return { ids: tableIds.length, links };
}

export function renderRequirementMarkdownRow(requirement) {
  const lines =
    requirement.source_lines.start === requirement.source_lines.end
      ? `L${requirement.source_lines.start}`
      : `L${requirement.source_lines.start}-L${requirement.source_lines.end}`;
  return (
    `| ${escapeMarkdownCell(requirement.id)} | ${lines} | ` +
    `${escapeMarkdownCell(requirement.phase)} / ${escapeMarkdownCell(requirement.scope)} | ` +
    `${escapeMarkdownCell(requirement.status)} | ${escapeMarkdownCell(requirement.requirement)} | ` +
    `${escapeMarkdownCell(requirement.implementation)} Evidence: ${escapeMarkdownCell(requirement.tests_evidence)} | ` +
    `${escapeMarkdownCell(requirement.owner)} Decision: ${escapeMarkdownCell(requirement.decision)} |`
  );
}

function escapeMarkdownCell(value) {
  return String(value)
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

function validateStatusDefinitions(value) {
  assertPlainObject(value, "status_definitions");
  assertExactKeys(value, ALLOWED_STATUSES, "status_definitions");
  for (const status of ALLOWED_STATUSES) {
    assertNonEmptyString(value[status], `status_definitions.${status}`);
  }
}

function parseLock(text) {
  const records = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert(
    records.length === 1,
    "requirements.lock must contain exactly one non-comment record",
  );
  const match = records[0].match(
    /^product-source \| ([^|]+?) \| (v[^|()]+?) \((\d{4}-\d{2}-\d{2})\) \| bytes:(\d+) \| sha256:([0-9a-f]{64})$/,
  );
  assert(match, "requirements.lock record has invalid format");
  return {
    name: match[1].trim(),
    version: match[2].trim(),
    date: match[3],
    bytes: Number(match[4]),
    sha256: match[5],
  };
}

function extractRepositoryPaths(text) {
  const found = new Set();
  for (const match of text.matchAll(REPOSITORY_PATH_PATTERN)) {
    const path = match[1].replace(/[.,;:]+$/g, "");
    if (path.length > 0) found.add(path);
  }
  return found;
}

async function validateRepositoryPaths(root, paths) {
  const actualRoot = await realpath(root);
  for (const path of paths) {
    assert(
      !isAbsolute(path),
      `artifact/evidence path must be repository-relative: ${path}`,
    );
    const resolved = resolve(root, path);
    assertWithinRoot(
      root,
      resolved,
      `artifact/evidence path escapes repository: ${path}`,
    );
    await accessRequired(resolved, `missing artifact/evidence path ${path}`);
    const actual = await realpath(resolved);
    assertWithinRoot(
      actualRoot,
      actual,
      `artifact/evidence symlink escapes repository: ${path}`,
    );
    const info = await stat(actual);
    assert(
      info.isFile() || info.isDirectory(),
      `unsupported artifact/evidence path type: ${path}`,
    );
  }
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items)
    counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return counts;
}

function assertMapsEqual(actual, expected, label) {
  assert(actual.size === expected.size, `${label} keys do not match JSON`);
  for (const [key, count] of expected) {
    assert(actual.get(key) === count, `${label} mismatch for ${key}`);
  }
}

function resolveInside(root, path, label) {
  assertNonEmptyString(path, label);
  const resolved = resolve(root, path);
  assertWithinRoot(root, resolved, `${label} escapes repository`);
  return resolved;
}

function assertWithinRoot(root, path, message) {
  const child = relative(root, path);
  assert(
    child === "" || (!child.startsWith("..") && !isAbsolute(child)),
    message,
  );
}

async function readJson(path, label) {
  const text = await readFileRequired(path, label, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RequirementCheckError(
      `${label} is invalid JSON: ${error.message}`,
    );
  }
}

async function readFileRequired(path, label, encoding) {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    throw new RequirementCheckError(`cannot read ${label}: ${error.message}`);
  }
}

async function accessRequired(path, message) {
  try {
    await access(path);
  } catch {
    throw new RequirementCheckError(message);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unknown or missing keys`,
  );
}

function assertPlainObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertNonEmptyString(value, label) {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string`,
  );
}

function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new RequirementCheckError(message);
}

function parseCli(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    assert(
      flag === "--root" || flag === "--source",
      `unknown argument ${flag}`,
    );
    const value = args[index + 1];
    assert(
      value !== undefined && !value.startsWith("--"),
      `missing value for ${flag}`,
    );
    if (flag === "--root") options.root = value;
    if (flag === "--source") options.sourcePath = value;
    index += 1;
  }
  return options;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await checkRequirements(parseCli(process.argv.slice(2)));
    console.log(
      `requirements valid: ${result.total} atomic IDs, ${result.repositoryPaths} artifact/evidence paths, ` +
        `${result.sourceLines} source lines, sha256 ${result.sourceSha256}`,
    );
  } catch (error) {
    console.error(
      `requirements check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
