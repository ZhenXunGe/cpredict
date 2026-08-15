import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkReleaseBundle } from "./release-bundle-common.mjs";

export function parseCheckArguments(args) {
  const options = { root: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (
      ![
        "--root",
        "--tag",
        "--bundle",
        "--requirements-source",
        "--attested-gates-root",
      ].includes(flag)
    ) {
      throw new Error(`unknown argument ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value for ${flag}`);
    if (flag === "--root") options.root = value;
    if (flag === "--tag") options.tag = value;
    if (flag === "--bundle") options.bundle = value;
    if (flag === "--requirements-source") options.requirementsSource = value;
    if (flag === "--attested-gates-root") options.attestedGatesRoot = value;
    index += 1;
  }
  if (options.tag === undefined) throw new Error("--tag is required");
  if (options.bundle === undefined) throw new Error("--bundle is required");
  if (options.requirementsSource === undefined)
    throw new Error("--requirements-source is required");
  if (options.attestedGatesRoot === undefined)
    throw new Error("--attested-gates-root is required");
  return options;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await checkReleaseBundle(
      parseCheckArguments(process.argv.slice(2)),
    );
    console.log(
      `release bundle valid: ${result.payloadFiles} payload files; ${result.bytes} bytes; ` +
        `sha256 ${result.sha256}; tag ${result.tag}; commit ${result.head}`,
    );
  } catch (error) {
    console.error(
      `release bundle check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
