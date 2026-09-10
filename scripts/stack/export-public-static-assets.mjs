#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
let container = "cpredict-web-demo-1";
let output = resolve(root, "runtime/public-site/static-handoff");
for (let index = 0; index < args.length; index += 2) {
  const [flag, value] = args.slice(index, index + 2);
  if (!value || value.startsWith("--"))
    throw new Error("Each option requires a value");
  if (flag === "--container") container = value;
  else if (flag === "--output") output = resolve(root, value);
  else throw new Error("Unknown export option");
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container))
  throw new Error("Invalid container name");
const boundary = resolve(root, "runtime/public-site");
const within = relative(boundary, output);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw new Error("Export output must be a child of runtime/public-site");
const docker = (argv) =>
  execFileSync("docker", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
const [live] = JSON.parse(docker(["inspect", container]));
if (live.State.Status !== "running")
  throw new Error("Source container is not running");
const [image] = JSON.parse(docker(["image", "inspect", live.Image]));
await mkdir(output, { recursive: true, mode: 0o755 });
await chmod(output, 0o755);
const staging = await mkdtemp(join(boundary, ".static-export-"));
await chmod(staging, 0o700);
const temporaryArchive = join(output, ".assets-" + randomUUID() + ".tmp");
try {
  for (const path of ["assets"]) {
    await mkdir(join(staging, path), { recursive: true, mode: 0o755 });
    docker([
      "cp",
      container + ":/usr/share/nginx/html/" + path + "/.",
      join(staging, path),
    ]);
  }
  const files = [];
  let excludedSourceMaps = 0;
  async function visit(path) {
    for (const entry of (
      await readdir(join(staging, path), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path + "/" + entry.name;
      if (/[\\\u0000-\u001f\u007f]/.test(child))
        throw new Error("Unsafe asset filename");
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error("Static assets must be regular files or directories");
      if (entry.isDirectory()) {
        await chmod(join(staging, child), 0o755);
        await visit(child);
        continue;
      }
      if (
        entry.name.endsWith(".map") ||
        entry.name === ".DS_Store" ||
        entry.name.startsWith("._")
      ) {
        if (entry.name.endsWith(".map")) excludedSourceMaps++;
        await rm(join(staging, child));
        continue;
      }
      const bytes = await readFile(join(staging, child));
      if (
        /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|privy_app_secret_[A-Za-z0-9]/.test(
          bytes.toString("utf8"),
        )
      )
        throw new Error(
          "Unexpected private credential material in public asset; export stopped",
        );
      await chmod(join(staging, child), 0o644);
      files.push({
        path: child,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await visit("assets");
  if (!files.length) throw new Error("Site assets must be nonempty");
  execFileSync(
    "tar",
    [
      "--format=ustar",
      "-czf",
      temporaryArchive,
      "-C",
      staging,
      "assets",
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const entries = execFileSync("tar", ["-tzf", temporaryArchive], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  const expected = new Set(files.map((file) => file.path));
  for (const entry of entries) {
    if (
      !entry.startsWith("assets/") ||
      entry.split("/").includes("..") ||
      entry.endsWith(".map")
    )
      throw new Error("Unexpected archive entry");
    if (!entry.endsWith("/")) {
      if (!expected.delete(entry))
        throw new Error("Duplicate or unrecorded archive file");
    }
  }
  if (expected.size) throw new Error("Archive omitted an asset");
  const archiveBytes = await readFile(temporaryArchive);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const filename =
    "ctusd-public-assets-" + archiveSha256.slice(0, 16) + ".tar.gz";
  await rename(temporaryArchive, join(output, filename));
  await chmod(join(output, filename), 0o644);
  const manifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    sourceContainer: container,
    sourceImageId: live.Image,
    imageSourceCommit:
      image.Config.Labels?.["org.opencontainers.image.revision"] ?? null,
    archive: filename,
    archiveSha256,
    archiveBytes: archiveBytes.length,
    uncompressedFileBytes: files.reduce((total, file) => total + file.bytes, 0),
    fileCount: files.length,
    siteAssetFiles: files.filter((file) => file.path.startsWith("assets/"))
      .length,
    excludedSourceMaps,
    files,
  };
  const manifestFilename = filename.replace(/\.tar\.gz$/, ".manifest.json");
  await writeFile(
    join(output, manifestFilename),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o644 },
  );
  await chmod(join(output, manifestFilename), 0o644);
  console.log(
    JSON.stringify(
      {
        ...manifest,
        files: undefined,
        outputDirectory: output,
        manifest: manifestFilename,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(temporaryArchive, { force: true });
}
