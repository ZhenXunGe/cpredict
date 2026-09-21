import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  validateDenseLineage,
  type DenseCanonicalBlock,
} from "../src/densify-canonical.js";

describe("dense rollback history validation", () => {
  it("accepts a complete parent-linked range", () => {
    expect(() =>
      validateDenseLineage(2n, 4n, hash(1n), hash(4n), blocks(2n, 4n)),
    ).not.toThrow();
  });

  it("rejects a missing block, a fork and the wrong endpoint", () => {
    const missing = blocks(2n, 4n);
    missing.delete(3n);
    expect(() =>
      validateDenseLineage(2n, 4n, hash(1n), hash(4n), missing),
    ).toThrow("missing block 3");

    const fork = blocks(2n, 4n);
    fork.set(3n, { ...fork.get(3n)!, parent_hash: hash(99n) });
    expect(() =>
      validateDenseLineage(2n, 4n, hash(1n), hash(4n), fork),
    ).toThrow("lineage conflict");

    expect(() =>
      validateDenseLineage(2n, 4n, hash(1n), hash(99n), blocks(2n, 4n)),
    ).toThrow("endpoint");
  });
});

function blocks(from: bigint, to: bigint): Map<bigint, DenseCanonicalBlock> {
  const result = new Map<bigint, DenseCanonicalBlock>();
  for (let number = from; number <= to; number += 1n)
    result.set(number, {
      block_number: number.toString(),
      block_hash: hash(number),
      parent_hash: hash(number - 1n),
      block_timestamp: (number * 10n).toString(),
    });
  return result;
}

function hash(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
