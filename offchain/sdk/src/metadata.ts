import type { Address, Hex } from "viem";

export const METADATA_TYPED_DATA_TYPES = {
  PublishMarketMetadata: [
    { name: "creator", type: "address" },
    { name: "rulesHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export function buildMetadataTypedData(input: {
  chainId: number;
  factory: Address;
  creator: Address;
  rulesHash: Hex;
  nonce: Hex;
  expiresAt: number;
}) {
  return {
    domain: {
      name: "Cpredict Metadata",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.factory,
    },
    types: METADATA_TYPED_DATA_TYPES,
    primaryType: "PublishMarketMetadata" as const,
    message: {
      creator: input.creator,
      rulesHash: input.rulesHash,
      nonce: input.nonce,
      expiresAt: BigInt(input.expiresAt),
    },
  };
}
