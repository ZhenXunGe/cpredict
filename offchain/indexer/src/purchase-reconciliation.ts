import type { PublicClient } from "viem";
import { operationSchema } from "../../app-core/src/contracts.js";
import type { PostgresEventStore } from "./postgres-store.js";
import { verifiedPurchaseEvents } from "./purchase-receipt.js";

/** Recover confirmed purchases even when a range-log response omitted the entire transaction. */
export async function reconcileConfirmedPurchases(
  store: PostgresEventStore,
  client: PublicClient,
): Promise<number> {
  const ledger = store.financial;
  if (!ledger) return 0;
  const sql = ledger.sql;
  if (!(await sql`SELECT to_regclass('app_operations') AS name`)[0]?.name)
    return 0;
  if (!(await store.checkpoint(ledger.environment.deployment.chainId)))
    return 0;
  const snapshot = await ledger.snapshot();
  const rows = await sql<{ record: unknown }[]>`
    SELECT record FROM app_operations o WHERE state='confirmed' AND kind='buy'
      AND record->>'environment'=${ledger.environment.id} AND record->>'deploymentId'=${ledger.environment.deployment.id}
      AND (record->>'blockNumber')::numeric<=${snapshot.blockNumber}::numeric
      AND (NOT EXISTS (SELECT 1 FROM ledger_facts f WHERE f.transaction_hash=record->>'transactionHash'
        AND f.kind='primary-buy' AND f.owner=lower(o.sender) AND f.market=lower(record->'intent'->>'market'))
        OR EXISTS (SELECT 1 FROM ledger_facts f WHERE f.transaction_hash=record->>'transactionHash' AND f.kind='coverage-gap' AND f.owner=lower(o.sender)))
    ORDER BY created_at LIMIT 5`;
  for (const row of rows) {
    const operation = operationSchema.parse(row.record);
    if (!operation.transactionHash || !operation.blockNumber)
      throw new Error("confirmed purchase receipt reference missing");
    const receipt = await client.getTransactionReceipt({
      hash: operation.transactionHash,
    });
    const events = verifiedPurchaseEvents(
      operation,
      receipt,
      ledger.environment,
    );
    const block = await store.canonicalBlock(
      ledger.environment.deployment.chainId,
      receipt.blockNumber,
    );
    const live = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (
      !block ||
      block.blockHash !== live.hash ||
      block.blockHash !== receipt.blockHash
    )
      throw new Error("purchase receipt canonical history mismatch");
    await store.repairPurchaseLogs(events, block);
  }
  return rows.length;
}
