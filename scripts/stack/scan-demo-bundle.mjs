#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".map", ".txt"]);
const FORBIDDEN = [
  ["private-key", /\b(?:DEPLOYER_PRIVATE_KEY|PRIVATE_KEY|privateKey|private_key)\s*[:=]\s*["'`](?:0x)?[0-9a-fA-F]{64}["'`]/],
  ["postgres-url", /postgres(?:ql)?:\/\/[^\s"']+/i],
  ["server-env", /\b(?:ARBITRUM_SEPOLIA_RPC_URL|CPREDICT_STACK_[A-Z0-9_]*PASSWORD|DEPLOYER_PRIVATE_KEY|ARBISCAN_API_KEY)\b/],
  ["url-credential", /https?:\/\/[A-Za-z0-9._~%-]+:[A-Za-z0-9._~!$&'()*+;=%-]+@[A-Za-z0-9.-]+/i],
  ["common-api-token", /\b(?:sk_live|sk_test|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/],
];

export async function scanDemoBundle(root) {
  const files = await collect(resolve(root));
  const findings = [];
  for (const path of files) {
    if (!TEXT_EXTENSIONS.has(extname(path))) continue;
    const source = await readFile(path, "utf8");
    for (const [kind, pattern] of FORBIDDEN)
      if (pattern.test(source)) findings.push({ path, kind });
  }
  if (findings.length > 0)
    throw new Error(`Demo bundle contains forbidden server material: ${findings.map(({ path, kind }) => `${kind}:${path}`).join(", ")}`);
  return { files: files.length, findings: 0 };
}

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? resolve(import.meta.dirname, "../../dist/web-demo");
  scanDemoBundle(root).then((result) => process.stdout.write(`PASS Demo bundle ${result.files} files, 0 secret findings\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
