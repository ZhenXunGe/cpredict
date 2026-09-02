import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bondEscrowAbi,
  exposureGuardAbi,
  marketFactoryAbi,
  marketVaultAbi,
  marketplaceAbi,
} from "../src/abis.js";

interface AbiFunction {
  type: "function";
  name: string;
  inputs: readonly { type: string }[];
  outputs: readonly { type: string }[];
}

interface AbiError {
  type: "error";
  name: string;
  inputs: readonly { type: string }[];
}

interface AbiEvent {
  type: "event";
  name: string;
  inputs: readonly { type: string; indexed: boolean }[];
}

describe("SDK ABI subsets", () => {
  it("matches the generated Full vault ABI", () => {
    const generated = loadFunctionAbi(
      "../../../generated/abi/FullMarketVaultV1.json",
    );
    expect(expectMissingFunctions(marketVaultAbi, generated)).toEqual([]);
  });

  it("matches terminal event signatures in the generated Full vault ABI", () => {
    const generated = loadEventAbi(
      "../../../generated/abi/FullMarketVaultV1.json",
    );
    expect(expectMissingEvents(marketVaultAbi, generated)).toEqual([]);
  });

  it("matches settlement error signatures in the generated Full vault ABI", () => {
    const generated = loadErrorAbi(
      "../../../generated/abi/FullMarketVaultV1.json",
    );
    expect(expectMissingErrors(marketVaultAbi, generated)).toEqual([]);
  });

  it("matches the generated Marketplace ABI", () => {
    const generated = loadFunctionAbi(
      "../../../generated/abi/FixedPriceMarketplaceV1.json",
    );
    expect(expectMissingFunctions(marketplaceAbi, generated)).toEqual([]);
  });

  it("matches the generated Factory and maintenance ABIs", () => {
    expect(
      expectMissingFunctions(
        marketFactoryAbi,
        loadFunctionAbi("../../../generated/abi/MarketFactoryV1.json"),
      ),
    ).toEqual([]);
    expect(
      expectMissingFunctions(
        bondEscrowAbi,
        loadFunctionAbi("../../../generated/abi/BondEscrowV1.json"),
      ),
    ).toEqual([]);
    expect(
      expectMissingFunctions(
        exposureGuardAbi,
        loadFunctionAbi("../../../generated/abi/LaunchExposureGuardV1.json"),
      ),
    ).toEqual([]);
  });
});

function loadFunctionAbi(relativePath: string): AbiFunction[] {
  const parsed = JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Array<{
    type: string;
    name?: string;
    inputs?: readonly { type: string }[];
    outputs?: readonly { type: string }[];
  }>;
  return parsed.filter((item): item is AbiFunction => item.type === "function");
}

function loadEventAbi(relativePath: string): AbiEvent[] {
  const parsed = JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Array<{
    type: string;
    name?: string;
    inputs?: readonly { type: string; indexed?: boolean }[];
  }>;
  return parsed.filter(
    (item): item is AbiEvent =>
      item.type === "event" &&
      typeof item.name === "string" &&
      item.inputs?.every((input) => typeof input.indexed === "boolean") ===
        true,
  );
}

function expectMissingFunctions(
  subset: readonly unknown[],
  generated: readonly AbiFunction[],
): string[] {
  return subset
    .filter(
      (item): item is AbiFunction =>
        (item as { type?: string }).type === "function",
    )
    .map(signature)
    .filter(
      (candidate) => !generated.some((item) => signature(item) === candidate),
    );
}

function signature(item: AbiFunction): string {
  const inputs = item.inputs.map((input) => input.type).join(",");
  const outputs = item.outputs.map((output) => output.type).join(",");
  return `${item.name}(${inputs}):(${outputs})`;
}

function expectMissingEvents(
  subset: readonly unknown[],
  generated: readonly AbiEvent[],
): string[] {
  return subset
    .filter(
      (item): item is AbiEvent => (item as { type?: string }).type === "event",
    )
    .map(eventSignature)
    .filter(
      (candidate) =>
        !generated.some((item) => eventSignature(item) === candidate),
    );
}

function eventSignature(item: AbiEvent): string {
  const inputs = item.inputs
    .map((input) => `${input.type}${input.indexed ? " indexed" : ""}`)
    .join(",");
  return `${item.name}(${inputs})`;
}

function loadErrorAbi(relativePath: string): AbiError[] {
  const parsed = JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Array<{
    type: string;
    name?: string;
    inputs?: readonly { type: string }[];
  }>;
  return parsed.filter((item): item is AbiError => item.type === "error");
}

function expectMissingErrors(
  subset: readonly unknown[],
  generated: readonly AbiError[],
): string[] {
  return subset
    .filter(
      (item): item is AbiError => (item as { type?: string }).type === "error",
    )
    .map(errorSignature)
    .filter(
      (candidate) =>
        !generated.some((item) => errorSignature(item) === candidate),
    );
}

function errorSignature(item: AbiError): string {
  return `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
}
