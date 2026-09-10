import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PublicClient } from "viem";
import { z } from "zod";
import { AppError, address, uint } from "../../app-core/src/contracts.js";
import {
  discoverEntitlements,
  hydrateEntitlements,
} from "../../app-core/src/entitlements.js";
import {
  factKind,
  snapshotSchema,
} from "../../app-core/src/ledger-contracts.js";
import { computePnl } from "../../app-core/src/pnl.js";
import type { PostgresFinancialLedger } from "./financial-store.js";
import { OnchainRightsReader } from "./rights-reader.js";
import { Leaderboards } from "./leaderboards.js";
export function registerFinancialApi(
  app: FastifyInstance,
  ledger: PostgresFinancialLedger,
  client: PublicClient,
  confirmations: bigint,
): void {
  const binding = {
    environment: z.literal(ledger.environment.id),
    deploymentId: z.literal(ledger.environment.deployment.id),
  };
  app.get("/v2/leaderboards", async (request) => {
    z.object(binding).parse(request.query);
    return new Leaderboards(ledger).page(request.query);
  });
  const range = { from: uint.optional(), to: uint.optional() };
  const checkRange = (value: {
    from?: string | undefined;
    to?: string | undefined;
  }) => {
    if (value.from && value.to && BigInt(value.from) >= BigInt(value.to))
      throw new AppError(
        "invalid_window",
        400,
        "时间范围必须为起点包含、终点不包含的有效区间",
      );
  };
  app.get("/v2/pnl/:owner", async (request) => {
    const { owner } = z.object({ owner: address }).parse(request.params),
      q = z
        .object({ ...binding, ...range, market: address.optional() })
        .parse(request.query);
    checkRange(q);
    return ledger.pnl(owner, {
      ...(q.from ? { from: BigInt(q.from) } : {}),
      ...(q.to ? { to: BigInt(q.to) } : {}),
      ...(q.market ? { markets: new Set([q.market.toLowerCase()]) } : {}),
    });
  });
  app.get("/v2/pnl/:owner/facts/:factId", async (request) => {
    z.object(binding).parse(request.query);
    const { owner, factId } = z
        .object({ owner: address, factId: z.string().min(1).max(180) })
        .parse(request.params),
      result = await ledger.pnl(owner);
    return {
      items: result.pnl.entries.filter((e) => e.factId === factId),
      snapshot: result.snapshot,
    };
  });
  app.get("/v2/entitlements/:owner", async (request) => {
    const { owner } = z.object({ owner: address }).parse(request.params),
      q = z
        .object({
          ...binding,
          limit: z.coerce.number().int().min(1).max(30).default(20),
          cursor: z.string().max(2048).optional(),
        })
        .parse(request.query);
    const fingerprint = createHash("sha256")
      .update(
        `${ledger.environment.id}:${ledger.environment.deployment.id}:${owner.toLowerCase()}:entitlements`,
      )
      .digest("hex");
    const parsed = q.cursor
      ? z
          .strictObject({
            snapshot: snapshotSchema,
            filter: z.string(),
            after: z.string().max(180),
          })
          .parse(
            JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")),
          )
      : undefined;
    if (parsed && parsed.filter !== fingerprint)
      throw new AppError("cursor_filter_mismatch", 400);
    const snapshot =
      parsed?.snapshot ??
      (await ledger.accountSnapshot(owner, await ledger.snapshot()));
    const facts = await ledger.accountFacts(owner, snapshot),
      pnl = computePnl(owner, facts, { coverageComplete: snapshot.complete });
    const candidates = discoverEntitlements(owner, facts, pnl).filter(
      (e) => !parsed || e.id.localeCompare(parsed.after) > 0,
    );
    const items = await hydrateEntitlements(
      owner,
      candidates.slice(0, q.limit),
      new OnchainRightsReader(
        client,
        ledger.environment,
        BigInt(snapshot.blockNumber),
      ),
    );
    await ledger.assertSnapshot(snapshot);
    const block = await client.getBlock({
      blockNumber: BigInt(snapshot.blockNumber),
    });
    if (block.hash !== snapshot.blockHash)
      throw new AppError("snapshot_invalidated", 409);
    const last = items.at(-1),
      nextCursor =
        candidates.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ snapshot, filter: fingerprint, after: last.id }),
            ).toString("base64url")
          : null;
    return { items, nextCursor, snapshot };
  });
  app.get("/v2/sync-status", async (request) => {
    z.object(binding).parse(request.query);
    const [chainHead, indexed, safe, finalized] = await Promise.allSettled([
      client.getBlockNumber(),
      ledger.snapshot(),
      client.getBlock({ blockTag: "safe" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    if (chainHead.status !== "fulfilled")
      throw new AppError("rpc_unavailable", 503);
    return {
      environment: ledger.environment.id,
      deploymentId: ledger.environment.deployment.id,
      chainHead: chainHead.value.toString(),
      applicationConfirmedBlock: (chainHead.value >= confirmations
        ? chainHead.value - confirmations
        : 0n
      ).toString(),
      indexedBlock:
        indexed.status === "fulfilled" ? indexed.value.blockNumber : null,
      indexedHash:
        indexed.status === "fulfilled" ? indexed.value.blockHash : null,
      safeBlock:
        safe.status === "fulfilled"
          ? (safe.value.number?.toString() ?? null)
          : null,
      finalizedBlock:
        finalized.status === "fulfilled"
          ? (finalized.value.number?.toString() ?? null)
          : null,
      snapshot: indexed.status === "fulfilled" ? indexed.value : null,
    };
  });
}
export async function financialActivity(
  ledger: PostgresFinancialLedger,
  ownerInput: unknown,
  query: unknown,
) {
  const owner = address.parse(ownerInput),
    q = z
      .object({
        environment: z.literal(ledger.environment.id),
        deploymentId: z.literal(ledger.environment.deployment.id),
        market: address.optional(),
        kind: z
          .string()
          .max(512)
          .transform((v) => v.split(",").map((k) => factKind.parse(k)))
          .optional(),
        from: uint.optional(),
        to: uint.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().max(2048).optional(),
      })
      .parse(query);
  if (q.from && q.to && BigInt(q.from) >= BigInt(q.to))
    throw new AppError("invalid_window", 400);
  return ledger.activity({
    owner,
    limit: q.limit,
    ...(q.market ? { market: q.market } : {}),
    ...(q.kind ? { kinds: q.kind } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
}
