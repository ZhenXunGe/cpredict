import { randomBytes } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  getAddress,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { z } from "zod";
import {
  encodePublishedMarketRules,
  publishedMarketRulesSchema,
} from "../../sdk/src/published-market-rules.js";
import { buildMetadataTypedData } from "../../sdk/src/metadata.js";
import type { MetadataServiceConfig } from "./config.js";
import { ChallengeUnavailableError, type MetadataStore } from "./types.js";

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const signatureSchema = z
  .string()
  // ERC-1271 / ERC-6492 signatures contain validator and deployment data.
  // Keep a byte-aligned, bounded envelope rather than accepting arbitrary JSON.
  .max(2 + 8_192 * 2)
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .transform((value) => value as Hex);
const addressSchema = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value));

export interface MetadataServerOptions {
  config: MetadataServiceConfig;
  store: MetadataStore;
  now?: (() => number) | undefined;
  nonce?: (() => Hex) | undefined;
  signatureClient?: Pick<PublicClient, "verifyTypedData"> | undefined;
}

export async function createMetadataServer(
  options: MetadataServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? randomHex32;
  const app = Fastify({
    logger:
      options.config.logLevel === "silent"
        ? false
        : {
            level: options.config.logLevel,
            redact: ["req.body.signature"],
          },
    bodyLimit: 64 * 1_024,
    requestTimeout: 5_000,
    connectionTimeout: 5_000,
    maxRequestsPerSocket: 100,
    trustProxy: options.config.trustedProxies?.length
      ? options.config.trustedProxies
      : false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await options.store.ready();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.post(
    "/v1/challenges",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({
          chainId: z.literal(options.config.chainId),
          factory: addressSchema,
          creator: addressSchema,
          rulesHash: bytes32Schema,
        })
        .strict()
        .parse(request.body);
      if (body.factory !== options.config.factory)
        return metadataError(reply, 400, "invalid_factory", "invalid factory");
      const issuedAt = now();
      const challenge = {
        challengeId: nonce(),
        chainId: body.chainId,
        factory: body.factory,
        creator: body.creator,
        rulesHash: body.rulesHash,
        nonce: nonce(),
        expiresAt: issuedAt + options.config.challengeTtlSeconds,
        consumedAt: null,
      };
      await options.store.createChallenge(challenge);
      const typed = buildMetadataTypedData(challenge);
      reply.header("cache-control", "no-store");
      return {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        typedData: {
          ...typed,
          message: {
            ...typed.message,
            expiresAt: typed.message.expiresAt.toString(),
          },
        },
      };
    },
  );
  app.post(
    "/v1/markets",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({
          challengeId: bytes32Schema,
          signature: signatureSchema,
          rules: publishedMarketRulesSchema,
        })
        .strict()
        .parse(request.body);
      const challenge = await options.store.challenge(body.challengeId);
      const currentTime = now();
      if (challenge === undefined)
        return metadataError(
          reply,
          409,
          "challenge_not_found",
          "challenge not found",
        );
      if (challenge.consumedAt !== null)
        return metadataError(
          reply,
          409,
          "challenge_consumed",
          "challenge already consumed",
        );
      if (challenge.expiresAt <= currentTime)
        return metadataError(
          reply,
          409,
          "challenge_expired",
          "challenge expired",
        );
      const encoded = encodePublishedMarketRules(body.rules);
      if (encoded.rulesHash.toLowerCase() !== challenge.rulesHash.toLowerCase())
        return reply.code(400).send({ error: "rules do not match challenge" });
      const typedData = buildMetadataTypedData(challenge);
      let valid: boolean;
      if (options.signatureClient !== undefined) {
        try {
          // viem performs EOA, deployed ERC-1271 and counterfactual ERC-6492
          // validation against the configured chain, without sending a transaction.
          valid = await options.signatureClient.verifyTypedData({
            ...typedData,
            address: challenge.creator,
            signature: body.signature,
          });
        } catch {
          return reply
            .code(503)
            .send({ error: "signature verification unavailable" });
        }
      } else {
        // Backwards-compatible EOA-only mode for existing deployments.
        try {
          valid =
            getAddress(
              await recoverTypedDataAddress({
                ...typedData,
                signature: body.signature,
              }),
            ) === challenge.creator;
        } catch {
          valid = false;
        }
      }
      if (!valid) return reply.code(401).send({ error: "invalid signature" });
      const metadataUri = `${options.config.publicBaseUrl}/v1/markets/${challenge.rulesHash}/outcomes/{id}.json`;
      const resolutionSourceHash = keccak256(
        toBytes(body.rules.resolutionSource),
      );
      const publication = await options.store.publish({
        challengeId: body.challengeId,
        signature: body.signature,
        canonicalJson: encoded.canonicalJson,
        rules: body.rules,
        metadataUri,
        resolutionSourceHash,
        now: currentTime,
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({
        rulesHash: publication.rulesHash,
        metadataUri: publication.metadataUri,
        resolutionSourceHash: publication.resolutionSourceHash,
        resolutionSourceUri: publication.resolutionSourceUri,
      });
    },
  );
  app.get("/v1/markets/:rulesHash/rules.json", async (request, reply) => {
    const params = z.object({ rulesHash: bytes32Schema }).parse(request.params);
    const publication = await options.store.publication(params.rulesHash);
    if (publication === undefined)
      return reply.code(404).send({ error: "metadata not found" });
    immutableJson(reply, publication.rulesHash);
    return reply.send(publication.canonicalJson);
  });
  app.get(
    "/v1/markets/:rulesHash/outcomes/:tokenId.json",
    async (request, reply) => {
      const params = z
        .object({ rulesHash: bytes32Schema, tokenId: z.string().max(78) })
        .parse(request.params);
      const publication = await options.store.publication(params.rulesHash);
      if (publication === undefined)
        return reply.code(404).send({ error: "metadata not found" });
      const tokenId = parseTokenId(params.tokenId);
      const outcome = publication.rules.outcomes[Number(tokenId)];
      if (outcome === undefined)
        return reply.code(404).send({ error: "outcome not found" });
      immutableJson(reply, publication.rulesHash);
      return {
        name: `${publication.rules.question} — ${outcome}`,
        description: `${publication.rules.resolutionCriteria}\n\nCancellation: ${publication.rules.cancellationPolicy}`,
        external_url: publication.rules.resolutionSource,
        attributes: [
          { trait_type: "Outcome", value: outcome },
          { trait_type: "Outcome ID", value: tokenId.toString() },
          ...(publication.rules.version === "cpredict-rules-v1"
            ? [{ trait_type: "Closes At", value: publication.rules.closesAt }]
            : [
                { trait_type: "Closes At", value: publication.rules.closeAt },
                {
                  trait_type: "Event Starts At",
                  value: publication.rules.eventStartsAt ?? "unknown",
                },
                {
                  trait_type: "Outcome Deadline At",
                  value: publication.rules.outcomeDeadlineAt,
                },
                {
                  trait_type: "Resolution Deadline At",
                  value: publication.rules.resolutionDeadlineAt,
                },
              ]),
          { trait_type: "Rules Hash", value: publication.rulesHash },
        ],
      };
    },
  );
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not found" }),
  );
  app.setErrorHandler(async (error, request, reply) => {
    if (
      error instanceof z.ZodError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      return reply.code(400).send({ error: "invalid request" });
    }
    if (error instanceof ChallengeUnavailableError)
      return reply.code(409).send({ error: "challenge unavailable" });
    // PostgreSQL messages/details can contain the signed row and connection data.
    // Record only a bounded SQLSTATE and this known constraint, never the error object.
    const databaseError = z
      .object({
        code: z.string().regex(/^[0-9A-Z]{5}$/),
        constraint_name: z.string().optional(),
      })
      .safeParse(error);
    const signatureConstraint =
      databaseError.success &&
      databaseError.data.code === "23514" &&
      databaseError.data.constraint_name === "market_publication_signature";
    request.log.error(
      {
        requestId: request.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...(databaseError.success
          ? { databaseErrorCode: databaseError.data.code }
          : {}),
        ...(signatureConstraint
          ? { constraint: "market_publication_signature" }
          : {}),
      },
      "metadata request failed",
    );
    if (signatureConstraint)
      return metadataError(
        reply,
        500,
        "metadata_storage_incompatible",
        "metadata signature storage is incompatible",
      );
    return reply.code(500).send({ error: "internal error" });
  });
  return app;
}

function metadataError(
  reply: FastifyReply,
  status: number,
  code: string,
  error: string,
) {
  // Keep the legacy string envelope for SDK consumers, with a precise reason for new clients.
  return reply.code(status).send({ error, code, requestId: reply.request.id });
}

function immutableJson(reply: FastifyReply, rulesHash: Hex): void {
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("cache-control", "public, max-age=31536000, immutable");
  reply.header("etag", `"${rulesHash}"`);
}

function parseTokenId(value: string): bigint {
  if (/^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  if (/^[0-9a-fA-F]{64}$/.test(value)) return BigInt(`0x${value}`);
  throw new TypeError("invalid token id");
}

function randomHex32(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}
