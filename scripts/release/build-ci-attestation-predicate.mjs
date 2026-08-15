import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPredicateFromCheckout } from "./ci-attestation-common.mjs";

export function parseArguments(args) {
  let output;
  let evidenceRoot;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--output", "--evidence-root"].includes(flag))
      throw new Error(`unknown argument ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value for ${flag}`);
    if (flag === "--output") output = value;
    if (flag === "--evidence-root") evidenceRoot = value;
    index += 1;
  }
  if (output === undefined) throw new Error("--output is required");
  if (evidenceRoot === undefined)
    throw new Error("--evidence-root is required");
  return { output, evidenceRoot };
}

export async function writePredicate({
  root = process.cwd(),
  output,
  evidenceRoot,
  environment = process.env,
}) {
  const predicate = await buildPredicateFromCheckout(
    root,
    evidenceRoot,
    environment,
  );
  const handle = await open(resolve(output), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(predicate, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return predicate;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const predicate = await writePredicate({
      ...parseArguments(process.argv.slice(2)),
    });
    console.log(
      `release CI attestation predicate ready: ${predicate.gates.length} gates; run ${predicate.workflow.runId}/${predicate.workflow.runAttempt}`,
    );
  } catch (error) {
    console.error(
      `release CI attestation predicate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
