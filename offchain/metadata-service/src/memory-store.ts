import type { Hex } from "viem";
import {
  ChallengeUnavailableError,
  type MarketPublication,
  type MetadataChallenge,
  type MetadataStore,
} from "./types.js";

export class MemoryMetadataStore implements MetadataStore {
  private readonly challenges = new Map<string, MetadataChallenge>();
  private readonly publications = new Map<string, MarketPublication>();

  async createChallenge(challenge: MetadataChallenge): Promise<void> {
    if (this.challenges.has(challenge.challengeId.toLowerCase()))
      throw new Error("challenge collision");
    this.challenges.set(challenge.challengeId.toLowerCase(), challenge);
  }

  async challenge(challengeId: Hex): Promise<MetadataChallenge | undefined> {
    return this.challenges.get(challengeId.toLowerCase());
  }

  async publish(input: {
    challengeId: Hex;
    signature: Hex;
    canonicalJson: string;
    rules: MarketPublication["rules"];
    metadataUri: string;
    resolutionSourceHash: Hex;
    now: number;
  }): Promise<MarketPublication> {
    const key = input.challengeId.toLowerCase();
    const challenge = this.challenges.get(key);
    if (
      challenge === undefined ||
      challenge.consumedAt !== null ||
      challenge.expiresAt <= input.now
    ) {
      throw new ChallengeUnavailableError("challenge unavailable");
    }
    const publication: MarketPublication = {
      chainId: challenge.chainId,
      factory: challenge.factory,
      creator: challenge.creator,
      rulesHash: challenge.rulesHash,
      canonicalJson: input.canonicalJson,
      rules: input.rules,
      metadataUri: input.metadataUri,
      resolutionSourceHash: input.resolutionSourceHash,
      resolutionSourceUri: input.rules.resolutionSource,
      signature: input.signature,
      publishedAt: input.now,
    };
    const publicationKey = challenge.rulesHash.toLowerCase();
    const existing = this.publications.get(publicationKey);
    if (
      existing !== undefined &&
      existing.canonicalJson !== publication.canonicalJson
    ) {
      throw new Error("rules hash collision");
    }
    this.publications.set(publicationKey, existing ?? publication);
    this.challenges.set(key, { ...challenge, consumedAt: input.now });
    return existing ?? publication;
  }

  async publication(rulesHash: Hex): Promise<MarketPublication | undefined> {
    return this.publications.get(rulesHash.toLowerCase());
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}
}
