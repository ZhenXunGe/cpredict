import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../src", import.meta.url).pathname;

describe("web demo frontend security invariants", () => {
  it("does not ship known executable DOM sinks or persistent secret storage", () => {
    const source = sourceFiles(sourceRoot).map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      "dangerouslySetInnerHTML",
      ".innerHTML",
      "document.write(",
      "eval(",
      "new Function(",
      "localStorage.setItem",
      "sessionStorage.setItem",
      "postMessage(",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps deployment, RPC, indexer, metadata and evidence endpoints same-origin", () => {
    const config = JSON.parse(readFileSync(new URL("../public/runtime-config.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).toContain('"rpcPath":"/rpc"');
    expect(serialized).toContain('"manifestPath":"/deployment/final.json"');
    expect(serialized).toContain('"basePath":"/metadata"');
  });

  it("ships precompiled validators without eval or CommonJS runtime loaders", () => {
    const validators = readFileSync(new URL("../src/generated-validators.js", import.meta.url), "utf8");
    expect(validators).not.toContain("require(");
    expect(validators).not.toContain("new Function");
    expect(validators).toContain("validateRuntime");
    expect(validators).toContain("validateManifest");
  });
});

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    if (statSync(candidate).isDirectory()) files.push(...sourceFiles(candidate));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry)) files.push(candidate);
  }
  return files;
}
