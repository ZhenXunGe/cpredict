import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSbomArtifacts, serializeSbomArtifacts } from "./sbom-common.mjs";

const root = process.cwd();
const expected = serializeSbomArtifacts(await createSbomArtifacts(root));
for (const [path, value] of Object.entries(expected)) {
  const actual = await readFile(join(root, path), "utf8");
  if (actual !== value)
    throw new Error(`${path} is stale; run npm run generate:sbom`);
}
console.log(
  `deterministic SPDX/license artifacts valid: ${Object.keys(expected).join(", ")}`,
);
