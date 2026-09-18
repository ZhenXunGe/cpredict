import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { PublicClient } from "viem";
import { operationSchema } from "../../app-core/src/contracts.js";
import type { PostgresEventStore } from "./postgres-store.js";
import {
  reconciledOperationKinds,
  verifiedOperationEvents,
} from "./operation-receipt.js";

/** SQL alias `o`: observational timestamps/finality/billing are not new receipt evidence. */
export function operationReceiptFingerprint(sql: Sql) {
  return sql`md5(jsonb_build_array(o.record->'environment',o.record->'deploymentId',o.record->'account',
    o.record->'kind',o.record->'intent',o.record->'state',o.record->'nonce',o.record->'userOperationHash',
    o.record->'transactionHash',o.record->'blockNumber',o.record->'blockHash')::text)`;
}

export async function reconcileConfirmedOperations(
  store: PostgresEventStore,
  client: PublicClient,
) {
  const result = {
    checked: 0,
    repaired: 0,
    insertedLogs: 0,
    errors: 0,
    pending: 0,
    unresolved: 0,
  };
  const ledger = store.financial;
  if (!ledger) return result;
  const sql = ledger.sql,
    chainId = ledger.environment.deployment.chainId;
  if (!(await sql`SELECT to_regclass('app_operations') AS name`)[0]?.name)
    return result;
  const head = await store.checkpoint(chainId);
  if (!head) return result;
  const fingerprint = operationReceiptFingerprint(sql);
  const rows = await sql<
    { id: string; record: unknown; digest: string; attempts: number }[]
  >`
    SELECT o.id,o.record,${fingerprint} AS digest,COALESCE(r.attempts,0) AS attempts
    FROM app_operations o LEFT JOIN ledger_operation_receipts r ON r.operation_id=o.id
    WHERE o.state='confirmed' AND o.kind IN ${sql([...reconciledOperationKinds])}
      AND o.record->>'environment'=${ledger.environment.id} AND o.record->>'deploymentId'=${ledger.environment.deployment.id}
      AND (o.record->>'blockNumber')::numeric<=${head.blockNumber.toString()}::numeric
      AND (r.operation_id IS NULL OR r.operation_digest<>${fingerprint} OR r.next_check_at<=now())
    ORDER BY r.checked_at ASC NULLS FIRST,(o.record->>'blockNumber')::numeric,o.created_at,o.id LIMIT 5`;
  for (const row of rows) {
    let inserted = 0,
      digest: string | null = null,
      error: string | null = null;
    let transactionHash = "",
      blockHash = "";
    try {
      const op = operationSchema.parse(row.record);
      transactionHash = op.transactionHash ?? "";
      blockHash = op.blockHash ?? "";
      if (!op.transactionHash) throw new Error("operation_receipt_mismatch");
      const receipt = await client.getTransactionReceipt({
        hash: op.transactionHash,
      });
      const events = verifiedOperationEvents(
        op,
        receipt,
        ledger.environment,
        await store.registeredMarkets(chainId),
        await ledger.trackedAccounts(),
      );
      const block = await store.canonicalBlock(chainId, receipt.blockNumber);
      const live = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (
        !block ||
        block.blockHash !== receipt.blockHash ||
        block.blockHash !== live.hash
      )
        throw new Error("operation_repair_canonical_mismatch");
      digest = createHash("sha256")
        .update(
          JSON.stringify(events, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        )
        .digest("hex");
      inserted = await store.repairOperationLogs(events, block);
      if (inserted) {
        result.repaired++;
        result.insertedLogs += inserted;
      }
    } catch (e) {
      // Never persist raw RPC/SQL errors; they can contain provider credentials.
      error =
        e instanceof Error && /^operation_[a-z_]+$/.test(e.message)
          ? e.message
          : "operation_verification_unavailable";
      result.errors++;
    }
    const status = error ? "error" : inserted ? "repaired" : "verified";
    const attempts = error ? row.attempts + 1 : 0;
    const delay = error ? Math.min(900, 30 * 2 ** Math.min(attempts, 5)) : 600;
    await sql`INSERT INTO ledger_operation_receipts(operation_id,operation_digest,transaction_hash,block_hash,next_check_at,status,receipt_digest,inserted_logs,attempts,last_error)
      VALUES(${row.id},${row.digest},${transactionHash},${blockHash},now()+${delay}*interval '1 second',${status},${digest},${inserted},${attempts},${error})
      ON CONFLICT(operation_id) DO UPDATE SET operation_digest=EXCLUDED.operation_digest,transaction_hash=EXCLUDED.transaction_hash,
        block_hash=EXCLUDED.block_hash,checked_at=now(),next_check_at=EXCLUDED.next_check_at,status=EXCLUDED.status,
        receipt_digest=EXCLUDED.receipt_digest,inserted_logs=EXCLUDED.inserted_logs,attempts=EXCLUDED.attempts,last_error=EXCLUDED.last_error`;
    result.checked++;
  }
  const counts = (
    await sql<{ pending: number; unresolved: number }[]>`SELECT
    count(*) FILTER(WHERE r.operation_id IS NULL OR r.operation_digest<>${fingerprint})::int AS pending,
    count(*) FILTER(WHERE r.status='error')::int AS unresolved
    FROM app_operations o LEFT JOIN ledger_operation_receipts r ON r.operation_id=o.id
    WHERE o.state='confirmed' AND o.kind IN ${sql([...reconciledOperationKinds])}
      AND o.record->>'environment'=${ledger.environment.id} AND o.record->>'deploymentId'=${ledger.environment.deployment.id}
      AND (o.record->>'blockNumber')::numeric<=${head.blockNumber.toString()}::numeric`
  )[0]!;
  return { ...result, ...counts };
}
