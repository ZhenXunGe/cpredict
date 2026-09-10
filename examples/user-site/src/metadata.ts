import { keccak256, stringToHex } from "viem";
import { z } from "zod";
import {
  AppError,
  hash,
  secureUrl,
  type AppAccount,
} from "../../../offchain/app-core/src/contracts.js";
import { createAppKernel } from "../../../offchain/app-core/src/kernel.js";
import { buildMetadataTypedData } from "../../../offchain/sdk/src/metadata.js";
import {
  encodeMarketRules,
  type MarketRules,
} from "../../../offchain/sdk/src/market-rules.js";
import type { WalletSession } from "./wallets.js";

export async function publishRules(
  session: WalletSession,
  account: AppAccount,
  rules: MarketRules,
  assertScope: () => void,
) {
  const { api } = session,
    env = api.environment,
    encoded = encodeMarketRules(rules);
  assertScope();
  const challenge = await api.request(
    "/v1/challenges",
    z.object({
      challengeId: hash,
      nonce: hash,
      expiresAt: z.number().int().safe(),
    }),
    {
      service: "metadata",
      body: {
        chainId: env.deployment.chainId,
        factory: env.deployment.factory,
        creator: account.address,
        rulesHash: encoded.rulesHash,
      },
    },
  );
  if (
    challenge.expiresAt <= Date.now() / 1000 ||
    challenge.expiresAt > Date.now() / 1000 + 900
  )
    throw new AppError("invalid_challenge");
  const provider = await session.controller(account);
  assertScope();
  const kernel = await createAppKernel(api.publicClient(), provider, env);
  assertScope();
  if (kernel.address.toLowerCase() !== account.address.toLowerCase())
    throw new AppError("account_derivation_mismatch");
  const signature = await kernel.signTypedData(
    buildMetadataTypedData({
      chainId: env.deployment.chainId,
      factory: env.deployment.factory,
      creator: account.address,
      rulesHash: encoded.rulesHash,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    }),
  );
  assertScope();
  const result = await api.request(
    "/v1/markets",
    z.object({
      rulesHash: hash,
      metadataUri: secureUrl,
      resolutionSourceHash: hash,
      resolutionSourceUri: secureUrl,
    }),
    {
      service: "metadata",
      body: { challengeId: challenge.challengeId, signature, rules },
    },
  );
  assertScope();
  if (
    result.rulesHash !== encoded.rulesHash ||
    result.resolutionSourceHash !==
      keccak256(stringToHex(rules.resolutionSource)) ||
    result.resolutionSourceUri !== rules.resolutionSource ||
    (!new URL(result.metadataUri).pathname.endsWith(
      `/v1/markets/${encoded.rulesHash}/outcomes/%7Bid%7D.json`,
    ) &&
      !new URL(result.metadataUri).pathname.endsWith(
        `/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
      ))
  )
    throw new AppError("rules_unverified");
  return {
    rulesHash: result.rulesHash,
    metadataURI: result.metadataUri,
    resolutionSourceHash: result.resolutionSourceHash,
    resolutionSourceURI: result.resolutionSourceUri,
  };
}
