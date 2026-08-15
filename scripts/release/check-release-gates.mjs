import { checkReleaseGates } from "./release-gates-common.mjs";

export function parseArguments(args) {
  let evidenceRoot = process.cwd();
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--evidence-root")
      throw new Error(`unknown argument ${args[index]}`);
    const value = args[index + 1];
    if (value === undefined)
      throw new Error("missing value for --evidence-root");
    evidenceRoot = value;
  }
  return { evidenceRoot };
}

try {
  const { evidenceRoot } = parseArguments(process.argv.slice(2));
  const document = await checkReleaseGates(process.cwd(), evidenceRoot);
  console.log(
    `release gates valid: ${document.gates.length} required gates are PASS and evidence-bound`,
  );
} catch (error) {
  console.error(
    `release gates blocked: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
