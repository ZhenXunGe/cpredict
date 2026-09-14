import { execFileSync } from "node:child_process";
import { mkdir, symlink, lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd(),
  revision = "a196e7784f26675c552997ed5199b96e0a1797b2";
const directory = resolve(root, ".tools/trading-session-legacy-a196e778");
await mkdir(directory, { recursive: true });
const archive = execFileSync(
  "git",
  [
    "archive",
    "--format=tar",
    revision,
    "src",
    "foundry.toml",
    "remappings.txt",
  ],
  { cwd: root, maxBuffer: 16 * 1024 * 1024 },
);
execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
if (!(await lstat(resolve(directory, "lib")).catch(() => null)))
  await symlink("../../lib", resolve(directory, "lib"));
execFileSync(
  resolve(root, ".tools/foundry/bin/forge"),
  [
    "build",
    "src/market/FullMarketVaultV1.sol",
    "--root",
    ".",
    "--offline",
    "-q",
  ],
  { cwd: directory, stdio: "inherit" },
);
await writeFile(resolve(directory, "revision.txt"), revision + "\n");
console.log(`Built legacy-v1 market fixture from pinned revision ${revision}.`);
