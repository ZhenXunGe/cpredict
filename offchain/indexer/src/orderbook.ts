import { decodeEventLog, toHex, type Address, type Hex } from "viem";
import type { Sql, TransactionSql } from "postgres";
import { orderbookAbi } from "../../sdk/src/orderbook.js";
import { jsonSafe } from "../../app-core/src/contracts.js";
import type { IndexedEvent } from "./store.js";
export async function projectOrderbook(
  db: Sql | TransactionSql,
  events: readonly IndexedEvent[],
  marketplace: Address,
) {
  for (const e of events) {
    if (e.address.toLowerCase() !== marketplace.toLowerCase()) continue;
    let log;
    try {
      log = decodeEventLog({
        abi: orderbookAbi,
        data: e.data,
        topics: e.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      continue;
    }
    const args = log.args;
    await db`INSERT INTO orderbook_events(chain_id,block_number,transaction_hash,transaction_index,log_index,marketplace,event_name,order_id,args)
    VALUES(${e.chainId},${e.blockNumber.toString()},${e.transactionHash},${e.transactionIndex},${e.logIndex},${marketplace.toLowerCase()},${log.eventName},${"orderId" in args ? args.orderId.toString() : null},${db.json(JSON.parse(JSON.stringify(jsonSafe(args))))}) ON CONFLICT DO NOTHING`;
  }
}
export async function orderbookPage(
  sql: Sql,
  chainId: number,
  marketplace: Address,
  market?: Address,
  owner?: Address,
  cursor = "0",
) {
  const rows =
    await sql`WITH projected AS (SELECT c.order_id::text AS id,c.args AS created,COALESCE(s.args,c.args) AS latest,s.event_name AS last_event
 FROM orderbook_events c LEFT JOIN LATERAL (
   SELECT args,event_name FROM orderbook_events s WHERE s.chain_id=c.chain_id AND s.marketplace=c.marketplace AND s.order_id=c.order_id
    AND s.event_name IN ('OrderFilled','OrderReleased') ORDER BY s.block_number DESC,s.transaction_index DESC,s.log_index DESC LIMIT 1
 ) s ON true WHERE c.chain_id=${chainId} AND c.marketplace=${marketplace.toLowerCase()} AND c.event_name='OrderCreated'
   AND (${market?.toLowerCase() ?? null}::text IS NULL OR lower(c.args->>'vault')=${market?.toLowerCase() ?? null})
   AND (${owner?.toLowerCase() ?? null}::text IS NULL OR lower(c.args->>'owner')=${owner?.toLowerCase() ?? null})
 ), totals AS (SELECT *,sum(CASE WHEN last_event='OrderReleased' THEN 0 ELSE COALESCE((latest->>'lockedPayment')::numeric,(created->>'lockedPayment')::numeric,0) END) OVER ()::text AS total_locked FROM projected)
 SELECT * FROM totals WHERE id::numeric>${cursor}::numeric ORDER BY id::numeric LIMIT 51`;
  const items = rows
    .slice(0, 50)
    .map((r) => ({
      id: r.id,
      market: r.created.vault,
      owner: r.created.owner,
      outcomeId: String(r.created.outcomeId),
      side: Number(r.created.side) === 0 ? "bid" : "ask",
      unitPrice: r.created.unitPrice,
      expiresAt: r.created.expiresAt,
      autoMatch: r.created.autoMatch,
      remainingUnits:
        r.last_event === "OrderReleased"
          ? "0"
          : (r.latest.remainingUnits ?? r.created.units),
      lockedPayment:
        r.last_event === "OrderReleased"
          ? "0"
          : (r.latest.lockedPayment ?? r.created.lockedPayment),
      active:
        r.last_event !== "OrderReleased" &&
        (r.latest.remainingUnits ?? r.created.units) !== "0",
    }));
  return {
    items,
    totalLockedPayment: rows[0]?.total_locked ?? "0",
    nextCursor: rows.length > 50 ? items.at(-1)!.id : null,
  };
}
export const orderListingId = (id: bigint) => toHex(id, { size: 32 });
