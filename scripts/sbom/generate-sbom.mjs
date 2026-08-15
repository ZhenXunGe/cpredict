import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSbomArtifacts, serializeSbomArtifacts } from "./sbom-common.mjs";

const root = process.cwd();
const serialized = serializeSbomArtifacts(await createSbomArtifacts(root));
for (const [path, value] of Object.entries(serialized)) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value, "utf8");
}
console.log(
  `deterministic SPDX/license artifacts generated: ${Object.keys(serialized).join(", ")}`,
);
