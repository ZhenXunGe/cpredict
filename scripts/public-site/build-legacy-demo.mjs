import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, symlink, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Retain the UI that matches the deployed ABI, under /demo. The new public site
// remains built from main. Source and output stay in ignored runtime storage.
const root = resolve(import.meta.dirname, "../..");
const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("an exact reviewed legacy source commit is required");
const directory = resolve(
  root,
  "runtime/public-site",
  `legacy-demo-${revision}`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const archive = execFileSync("git", ["archive", revision], {
  cwd: root,
  maxBuffer: 64 * 1024 * 1024,
});
execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
try {
  await access(resolve(directory, "node_modules"));
} catch {
  await symlink(
    resolve(root, "node_modules"),
    resolve(directory, "node_modules"),
    "dir",
  );
}
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "build",
    "--config",
    resolve(directory, "examples/web-demo/vite.config.ts"),
    "--base=/demo/",
  ],
  { cwd: directory, stdio: "inherit" },
);
const output = resolve(directory, "dist/web-demo");
await writeFile(
  resolve(output, "legacy-build.json"),
  JSON.stringify(
    {
      sourceCommit: revision,
      protocolVersion: "legacy-v1",
      base: "/demo/",
      indexSha256: createHash("sha256")
        .update(await readFile(resolve(output, "index.html")))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Legacy demo built: ${output}`);
