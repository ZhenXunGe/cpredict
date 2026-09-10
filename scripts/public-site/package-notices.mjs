import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { readNpmLicenseEvidence } from "../sbom/npm-license-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "dist/user-site/third-party");
const lock = JSON.parse(
  await readFile(resolve(root, "package-lock.json"), "utf8"),
);
const inputs = new Map();
const { declarations } = await readNpmLicenseEvidence(root, lock, inputs);
const evidence = JSON.parse(
  inputs.get("manifests/npm-license-evidence.json").toString("utf8"),
);
const supplemental = new Map(
  evidence.entries.map((entry) => [entry.path, entry]),
);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
await mkdir(output, { recursive: true });
const packages = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  const directory = resolve(root, path);
  if (!directory.startsWith(`${resolve(root, "node_modules")}${sep}`))
    throw new Error("Invalid locked package path");
  const name = path.slice(path.lastIndexOf("node_modules/") + 13);
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" && metadata.optional) continue;
    throw error;
  }
  const item = {
    name,
    version: metadata.version,
    integrity: metadata.integrity,
    declared:
      declarations.get(path)?.declared ?? metadata.license ?? "NOASSERTION",
    licenseCopies: [],
  };
  const candidates = new Map();
  for (const file of files) {
    if (
      file.isFile() &&
      /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file.name)
    )
      candidates.set(
        `${path}/${file.name}`,
        await readFile(resolve(directory, file.name)),
      );
  }
  const supplement = supplemental.get(path);
  if (supplement && supplement.status !== "missing-license")
    candidates.set(supplement.evidence, inputs.get(supplement.evidence));
  const seen = new Set();
  for (const [source, bytes] of candidates) {
    if (bytes.length > 2097152 || bytes.includes(0))
      throw new Error(`Invalid license text: ${source}`);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    await writeFile(resolve(output, `${sha256}.txt`), bytes);
    item.licenseCopies.push({
      file: `${sha256}.txt`,
      source,
      sha256,
      bytes: bytes.length,
    });
  }
  packages.push(item);
}
packages.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
const manifest = {
  schemaVersion: 1,
  scope:
    "Locked production npm dependencies; may include packages removed by browser tree shaking",
  legalConclusion: false,
  packages,
};
await writeFile(
  resolve(output, "inventory.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  resolve(output, "index.html"),
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cpredict · 第三方软件声明</title></head>
<body><main><a href="/">返回 Cpredict</a><h1>第三方软件声明</h1>
<p>本产品使用 MetaMask SDK。Copyright ConsenSys Software Inc. 2022. All rights reserved.</p>
<p>Portions © 2025 Reown, Inc. All Rights Reserved</p>
<p>以下保留锁定依赖的许可声明及随包许可文件。各文件适用于相应第三方软件。</p>
<ul>${packages.map((item) => `<li><strong>${escape(item.name)} ${escape(item.version)}</strong> — ${escape(item.declared)}${item.licenseCopies.map((copy) => ` · <a href="${copy.file}">${escape(basename(copy.source))}</a>`).join("")}${item.licenseCopies.length ? "" : " · 未随包提供独立许可文件"}</li>`).join("\n")}</ul>
</main></body></html>\n`,
);
console.log(
  JSON.stringify({
    packages: packages.length,
    withoutLicenseCopy: packages.filter(
      (item) => item.licenseCopies.length === 0,
    ).length,
    legalConclusion: false,
    output: "dist/user-site/third-party",
  }),
);
