import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  address,
  jsonSafe,
  environmentKey,
} from "../../app-core/src/contracts.js";
import { snapshotSchema } from "../../app-core/src/ledger-contracts.js";
import { fetchJson } from "../../app-core/src/fetch-json.js";
import {
  encodeMarketRules,
  marketRulesMatchTimes,
  marketRulesSchema,
} from "../../sdk/src/market-rules.js";
import {
  mapMarket,
  mapListing,
  type MarketRow,
  type ListingRow,
} from "./postgres-store.js";
import type { PostgresFinancialLedger } from "./financial-store.js";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2048).optional(),
  q: z.string().trim().max(120).default(""),
  status: z.enum(["open", "resolved", "voided"]).optional(),
  owner: address.optional(),
  creator: address.optional(),
  vault: address.optional(),
  active: z.enum(["true", "false"]).optional(),
});
/** Materialize filtered query rows at one MVCC snapshot. Later changes cannot move items between pages. */
export async function publicCatalog(
  ledger: PostgresFinancialLedger,
  kind: "markets" | "listings",
  input: unknown,
) {
  const q = querySchema.parse(input),
    fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          environmentKey(ledger.environment),
          kind,
          q.q.toLowerCase(),
          q.status ?? null,
          q.owner?.toLowerCase() ?? null,
          q.creator?.toLowerCase() ?? null,
          q.vault?.toLowerCase() ?? null,
          q.active ?? null,
        ]),
      )
      .digest("hex");
  let cursor: { id: string; filter: string; offset: number } | undefined;
  if (q.cursor) {
    try {
      cursor = z
        .strictObject({
          id: z.string().length(64),
          filter: z.string().length(64),
          offset: z.number().int().nonnegative().max(10000),
        })
        .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
    } catch {
      throw new AppError("invalid_cursor");
    }
    if (cursor.filter !== fingerprint)
      throw new AppError("cursor_filter_mismatch");
  }
  return ledger.sql.begin("isolation level repeatable read", async (db) => {
    const metadataVersion =
      kind === "markets"
        ? ((
            await db<
              { version: string | null }[]
            >`SELECT max(checked_at)::text AS version FROM public_market_metadata`
          )[0]?.version ?? "empty")
        : "listings";
    const snapshot = await ledger.snapshot(db),
      key =
        cursor?.id ??
        createHash("sha256")
          .update(
            `${fingerprint}:${snapshot.epoch}:${snapshot.blockHash}:${metadataVersion}`,
          )
          .digest("hex");
    let stored = (
      await db<
        {
          items: unknown[];
          ledger_snapshot: unknown;
          metadata_pending: number;
        }[]
      >`SELECT items,ledger_snapshot,metadata_pending FROM public_query_snapshots WHERE id=${key} AND filter=${fingerprint} AND created_at>now()-interval '30 minutes'`
    )[0];
    if (!stored) {
      if (cursor) throw new AppError("cursor_expired", 410);
      await db`SELECT pg_advisory_xact_lock(hashtextextended('public-query-snapshots',0))`;
      await db`DELETE FROM public_query_snapshots WHERE created_at<=now()-interval '30 minutes'`;
      const count = (
        await db<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM public_query_snapshots`
      )[0]!;
      if (Number(count.count) >= 500)
        throw new AppError("query_snapshot_capacity", 503);
      let items: unknown[],
        metadataPending = 0;
      if (kind === "markets") {
        const state =
          q.status === undefined
            ? db``
            : db`AND m.state=${{ open: 0, resolved: 1, voided: 2 }[q.status]}`;
        const owner = q.owner
          ? db`AND (lower(m.creator)=${q.owner.toLowerCase()} OR lower(m.market) IN (SELECT market FROM ledger_facts WHERE owner=${q.owner.toLowerCase()} OR counterparty=${q.owner.toLowerCase()}))`
          : db``;
        const creator = q.creator
          ? db`AND lower(m.creator)=${q.creator.toLowerCase()}`
          : db``;
        const search = q.q
          ? db`AND (strpos(lower(m.market),${q.q.toLowerCase()})>0 OR (c.verified AND strpos(lower(c.question),${q.q.toLowerCase()})>0))`
          : db``;
        const rows = await db<
          (MarketRow & { question: string | null })[]
        >`SELECT m.*,CASE WHEN c.verified THEN c.question ELSE NULL END AS question FROM markets m LEFT JOIN public_market_metadata c ON c.market=lower(m.market) AND c.rules_hash=m.rules_hash WHERE m.chain_id=${ledger.environment.deployment.chainId} ${state} ${owner} ${creator} ${search} ORDER BY m.created_block DESC,m.market DESC LIMIT 5001`;
        if (rows.length > 5000)
          throw new AppError("catalog_capacity_exceeded", 503);
        items = rows.map((row) =>
          jsonSafe({ ...mapMarket(row), question: row.question }),
        );
        metadataPending = Number(
          (
            await db<
              { count: string }[]
            >`SELECT count(*)::text AS count FROM markets m LEFT JOIN public_market_metadata c ON c.market=lower(m.market) AND c.rules_hash=m.rules_hash WHERE m.chain_id=${ledger.environment.deployment.chainId} AND (c.verified IS DISTINCT FROM true)`
          )[0]!.count,
        );
      } else {
        const vault = q.vault
            ? db`AND lower(vault)=${q.vault.toLowerCase()}`
            : db``,
          active = q.active ? db`AND active=${q.active === "true"}` : db``;
        const rows = await db<
          ListingRow[]
        >`SELECT * FROM listings WHERE chain_id=${ledger.environment.deployment.chainId} ${vault} ${active} ORDER BY updated_block DESC,listing_id DESC LIMIT 10001`;
        if (rows.length > 10000)
          throw new AppError("catalog_capacity_exceeded", 503);
        items = rows.map((row) => jsonSafe(mapListing(row)));
      }
      if (Buffer.byteLength(JSON.stringify(items)) > 8388608)
        throw new AppError("catalog_capacity_exceeded", 503);
      await db`INSERT INTO public_query_snapshots(id,filter,ledger_snapshot,items,metadata_pending) VALUES(${key},${fingerprint},${db.json(snapshot)},${db.json(items as never)},${metadataPending}) ON CONFLICT DO NOTHING`;
      stored = {
        items,
        ledger_snapshot: snapshot,
        metadata_pending: metadataPending,
      };
    }
    const fixed = snapshotSchema.parse(stored.ledger_snapshot);
    await ledger.assertSnapshot(fixed, db);
    const offset = cursor?.offset ?? 0,
      items = stored.items.slice(offset, offset + q.limit),
      next = offset + items.length;
    return {
      items,
      snapshot: fixed,
      metadataPending: stored.metadata_pending,
      nextCursor:
        next < stored.items.length
          ? Buffer.from(
              JSON.stringify({ id: key, filter: fingerprint, offset: next }),
            ).toString("base64url")
          : null,
    };
  });
}

/** Only the configured metadata host is fetched; content must match the market's on-chain commitment and times. */
export async function refreshPublicMetadata(
  ledger: PostgresFinancialLedger,
  baseUrl: string,
): Promise<void> {
  const rows = await ledger.sql<
    MarketRow[]
  >`SELECT m.* FROM markets m LEFT JOIN public_market_metadata c ON c.market=lower(m.market) WHERE m.chain_id=${ledger.environment.deployment.chainId} AND m.rules_hash IS NOT NULL AND (c.market IS NULL OR c.rules_hash<>m.rules_hash OR (NOT c.verified AND c.checked_at<now()-interval '5 minutes')) ORDER BY m.created_block,m.market LIMIT 20`;
  for (let start = 0; start < rows.length; start += 4)
    await Promise.all(
      rows.slice(start, start + 4).map(async (row) => {
        let rules: z.infer<typeof marketRulesSchema> | null = null;
        try {
          const m = mapMarket(row),
            parsed = marketRulesSchema.parse(
              await fetchJson(
                `${baseUrl.replace(/\/$/, "")}/v1/markets/${m.rulesHash}/rules.json`,
                { signal: AbortSignal.timeout(4000) },
                32768,
              ),
            );
          if (
            encodeMarketRules(parsed).rulesHash.toLowerCase() ===
              m.rulesHash?.toLowerCase() &&
            marketRulesMatchTimes(parsed, {
              closeAt: m.closeAt,
              eventStartsAt: m.eventStartsAt,
              outcomeDeadlineAt: m.outcomeDeadlineAt,
              resolutionDeadlineAt:
                m.outcomeDeadlineAt === null || m.resolutionWindow === null
                  ? null
                  : m.outcomeDeadlineAt + m.resolutionWindow,
            })
          )
            rules = parsed;
        } catch {
          /* An unavailable or invalid rule is explicitly excluded from title search. */
        }
        await ledger.sql`INSERT INTO public_market_metadata(market,rules_hash,question,rules,verified) VALUES(${row.market.toLowerCase()},${row.rules_hash!},${rules?.question ?? null},${rules ? ledger.sql.json(rules) : null},${rules !== null}) ON CONFLICT(market) DO UPDATE SET rules_hash=EXCLUDED.rules_hash,question=EXCLUDED.question,rules=EXCLUDED.rules,verified=EXCLUDED.verified,checked_at=now()`;
      }),
    );
}
