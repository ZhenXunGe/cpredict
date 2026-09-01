import {
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import {
  buildMetadataTypedData,
  encodeMarketRules,
  type MarketRules,
} from "../../../offchain/sdk/src/index.js";
import type { ConnectedWallet } from "./wallet.js";

export interface PublishedMarketMetadata {
  rulesHash: Hex;
  metadataURI: string;
  resolutionSourceHash: Hex;
  resolutionSourceURI: string;
}

export async function publishMarketMetadata(input: {
  basePath: string;
  chainId: number;
  factory: Address;
  wallet: ConnectedWallet;
  rules: MarketRules;
}): Promise<PublishedMarketMetadata> {
  const basePath = sameOriginBasePath(input.basePath);
  const encoded = encodeMarketRules(input.rules);
  const challengeResponse = await fetch(`${basePath}/v1/challenges`, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: input.chainId,
      factory: input.factory,
      creator: input.wallet.address,
      rulesHash: encoded.rulesHash,
    }),
  });
  if (!challengeResponse.ok)
    throw new Error(`Metadata challenge HTTP ${challengeResponse.status}`);
  requireJson(challengeResponse);
  const challenge = parseChallenge(await challengeResponse.json());
  const signature = await input.wallet.walletClient.signTypedData({
    account: input.wallet.account,
    ...buildMetadataTypedData({
      chainId: input.chainId,
      factory: input.factory,
      creator: input.wallet.address,
      rulesHash: encoded.rulesHash,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    }),
  });
  const publicationResponse = await fetch(`${basePath}/v1/markets`, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      signature,
      rules: input.rules,
    }),
  });
  if (!publicationResponse.ok)
    throw new Error(`Metadata publish HTTP ${publicationResponse.status}`);
  requireJson(publicationResponse);
  const publication = parsePublication(await publicationResponse.json());
  const expectedSourceHash = keccak256(toBytes(input.rules.resolutionSource));
  if (
    publication.rulesHash.toLowerCase() !== encoded.rulesHash.toLowerCase() ||
    publication.resolutionSourceHash.toLowerCase() !==
      expectedSourceHash.toLowerCase() ||
    publication.resolutionSourceURI !== input.rules.resolutionSource
  ) {
    throw new Error("Metadata service returned mismatched commitments");
  }
  validateMetadataUri(publication.metadataUri, basePath, encoded.rulesHash);
  return {
    rulesHash: encoded.rulesHash,
    metadataURI: publication.metadataUri,
    resolutionSourceHash: expectedSourceHash,
    resolutionSourceURI: input.rules.resolutionSource,
  };
}

function parseChallenge(value: unknown): {
  challengeId: Hex;
  nonce: Hex;
  expiresAt: number;
} {
  if (value === null || typeof value !== "object")
    throw new TypeError("Metadata challenge response is invalid");
  const candidate = value as Record<string, unknown>;
  if (
    !isBytes32(candidate.challengeId) ||
    !isBytes32(candidate.nonce) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt <= Math.floor(Date.now() / 1_000) ||
    candidate.expiresAt > Math.floor(Date.now() / 1_000) + 900
  ) {
    throw new TypeError("Metadata challenge response is invalid");
  }
  return {
    challengeId: candidate.challengeId,
    nonce: candidate.nonce,
    expiresAt: candidate.expiresAt,
  };
}

function parsePublication(value: unknown): {
  rulesHash: Hex;
  metadataUri: string;
  resolutionSourceHash: Hex;
  resolutionSourceURI: string;
} {
  if (value === null || typeof value !== "object")
    throw new TypeError("Metadata publication response is invalid");
  const candidate = value as Record<string, unknown>;
  if (
    !isBytes32(candidate.rulesHash) ||
    !isBytes32(candidate.resolutionSourceHash) ||
    typeof candidate.metadataUri !== "string" ||
    typeof candidate.resolutionSourceUri !== "string"
  ) {
    throw new TypeError("Metadata publication response is invalid");
  }
  return {
    rulesHash: candidate.rulesHash,
    metadataUri: candidate.metadataUri,
    resolutionSourceHash: candidate.resolutionSourceHash,
    resolutionSourceURI: candidate.resolutionSourceUri,
  };
}

function sameOriginBasePath(value: string): string {
  if (!/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/.test(value))
    throw new TypeError("Metadata base path is invalid");
  return value.replace(/\/$/, "");
}

function validateMetadataUri(value: string, basePath: string, rulesHash: Hex): void {
  if (
    value.length > 512 ||
    !value.endsWith(`/v1/markets/${rulesHash}/outcomes/{id}.json`)
  ) {
    throw new TypeError("Metadata URI is invalid");
  }
  const parsed = new URL(value.replace("{id}", "0"));
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== `${basePath}/v1/markets/${rulesHash}/outcomes/0.json` ||
    (globalThis.location?.origin !== undefined && parsed.origin !== globalThis.location.origin)
  ) {
    throw new TypeError("Metadata URI is invalid");
  }
}

function requireJson(response: Response): void {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new TypeError("Metadata service response is not JSON");
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
