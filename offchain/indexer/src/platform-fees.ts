import { feeCategory } from "../../app-core/src/fees.js";
import { platformFeesSchema } from "../../app-core/src/report-contracts.js";
import type { PostgresFinancialLedger } from "./financial-store.js";

/** Public aggregate only: no account, operation or administrator data. */
export async function publicPlatformFees(ledger: PostgresFinancialLedger) {
  return ledger.sql.begin("isolation level repeatable read", async (db) => {
    const snapshot = await ledger.snapshot(db);
    const groups = await db<
      {
        kind: string | null;
        amount: string;
        missing: string;
      }[]
    >`
      SELECT fact->'extra'->>'feeKind' AS kind,
        coalesce(sum((fact->>'amount')::numeric),0)::text AS amount,
        count(*) FILTER (WHERE fact->>'amount' IS NULL)::text AS missing
      FROM ledger_facts
      WHERE chain_id=${ledger.environment.deployment.chainId}
        AND block_number<=${snapshot.blockNumber} AND kind='fee-accrued'
      GROUP BY fact->'extra'->>'feeKind'
    `;
    let accrued = 0n,
      complete = snapshot.complete;
    for (const group of groups) {
      const category = feeCategory(group.kind);
      if (category === "protocol") {
        accrued += BigInt(group.amount);
        if (BigInt(group.missing) > 0n) complete = false;
      } else if (category === "unknown") complete = false;
    }
    return platformFeesSchema.parse({
      accrued: accrued.toString(),
      complete,
      snapshot,
    });
  });
}
