import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadBondOperation,
  saveBondOperation,
} from "../src/bond-operation-storage.js";
import type { BondSubmission } from "../src/creator-bond.js";

const sourceRoot = new URL("../src", import.meta.url).pathname;

describe("web demo frontend security invariants", () => {
  it("does not ship known executable DOM sinks or persistent secret storage", () => {
    const files = sourceFiles(sourceRoot);
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      "dangerouslySetInnerHTML",
      ".innerHTML",
      "document.write(",
      "eval(",
      "new Function(",
      "localStorage.setItem",
      "postMessage(",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    // Only the fixed-shape public bond checkpoint may persist; no arbitrary UI writer.
    for (const file of files.filter(
      (file) => file !== join(sourceRoot, "bond-operation-storage.ts"),
    )) {
      expect(
        readFileSync(file, "utf8").includes("sessionStorage.setItem"),
        file,
      ).toBe(false);
    }
  });

  it("persists only validated public bond receipt identities, rejecting extra payloads and secret-shaped values", () => {
    const setItem = vi.fn();
    const identity = {
      chainId: 421614,
      wallet: "0x0000000000000000000000000000000000000001",
      creator: "0x0000000000000000000000000000000000000001",
      market: "0x0000000000000000000000000000000000000002",
      escrow: "0x0000000000000000000000000000000000000003",
    } as const;
    const submission = {
      action: "claim",
      hash: `0x${"12".repeat(32)}`,
      afterBlock: "100",
    } as const;
    const getItem = vi.fn(() => JSON.stringify(submission));
    vi.stubGlobal("window", {
      sessionStorage: { setItem, getItem, removeItem: vi.fn() },
    });
    try {
      saveBondOperation(identity, submission);
      expect(setItem).toHaveBeenCalledWith(
        expect.stringMatching(/^cpredict:bond-pending:v1:421614:/),
        JSON.stringify(submission),
      );
      expect(loadBondOperation(identity)).toEqual(submission);
      for (const extra of [
        "signature",
        "privateKey",
        "rules",
        "authorization",
        "error",
      ]) {
        expect(() =>
          saveBondOperation(identity, {
            ...submission,
            [extra]: "must-not-persist",
          } as BondSubmission),
        ).toThrow();
      }
      expect(() =>
        saveBondOperation(identity, {
          ...submission,
          hash: "secret",
        } as unknown as BondSubmission),
      ).toThrow();
      expect(() =>
        saveBondOperation(
          { ...identity, market: "secret" as `0x${string}` },
          submission,
        ),
      ).toThrow();
      expect(setItem).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps deployment, RPC, indexer, metadata, relay and evidence endpoints same-origin", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../public/runtime-config.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).toContain('"rpcPath":"/rpc"');
    expect(serialized).toContain('"manifestPath":"/deployment/final.json"');
    expect(serialized).toContain('"basePath":"/metadata"');
    expect(serialized).toContain('"basePath":"/relay"');
  });

  it("ships precompiled validators without eval or CommonJS runtime loaders", () => {
    const validators = readFileSync(
      new URL("../src/generated-validators.js", import.meta.url),
      "utf8",
    );
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
    if (statSync(candidate).isDirectory())
      files.push(...sourceFiles(candidate));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry)) files.push(candidate);
  }
  return files;
}
