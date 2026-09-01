import type { Address, Hex } from "viem";
import type { MarketRules } from "../../sdk/src/market-rules.js";

export interface MetadataChallenge {
  challengeId: Hex;
  chainId: number;
  factory: Address;
  creator: Address;
  rulesHash: Hex;
  nonce: Hex;
  expiresAt: number;
  consumedAt: number | null;
}

export interface MarketPublication {
  chainId: number;
  factory: Address;
  creator: Address;
  rulesHash: Hex;
  canonicalJson: string;
  rules: MarketRules;
  metadataUri: string;
  resolutionSourceHash: Hex;
  resolutionSourceUri: string;
  signature: Hex;
  publishedAt: number;
}

export interface MetadataStore {
  createChallenge(challenge: MetadataChallenge): Promise<void>;
  challenge(challengeId: Hex): Promise<MetadataChallenge | undefined>;
  publish(input: {
    challengeId: Hex;
    signature: Hex;
    canonicalJson: string;
    rules: MarketRules;
    metadataUri: string;
    resolutionSourceHash: Hex;
    now: number;
  }): Promise<MarketPublication>;
  publication(rulesHash: Hex): Promise<MarketPublication | undefined>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export class ChallengeUnavailableError extends Error {
  override readonly name = "ChallengeUnavailableError";
}
