import { keccak256, stringToHex } from "viem";
const creatorKinds = new Set(
  ["CREATOR_RAKE", "CREATOR_C2C"].map((v) =>
    keccak256(stringToHex(v)).toLowerCase(),
  ),
);
const protocolKinds = new Set(
  ["MARKET_CREATION", "PROTOCOL_RAKE", "PLATFORM_C2C"].map((v) =>
    keccak256(stringToHex(v)).toLowerCase(),
  ),
);
export function feeCategory(kind: unknown): "creator" | "protocol" | "unknown" {
  if (typeof kind !== "string") return "unknown";
  return creatorKinds.has(kind.toLowerCase())
    ? "creator"
    : protocolKinds.has(kind.toLowerCase())
      ? "protocol"
      : "unknown";
}
