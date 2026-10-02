import type { Sql } from "postgres";
import type { Hex } from "viem";
import type { AutomationChain } from "./automatic-claims.js";
import type { PostgresAutomaticStore } from "./automatic-store.js";

/** Low priority receipt enrichment; canonical evidence belongs to the indexed epoch.
 * Sparse indexers may omit empty receipt blocks, so verify their checkpoint too.
 * Never creates or changes a signed transaction intent or nonce. */
export async function backfillAutomaticGas(
  store: PostgresAutomaticStore,
  chain: AutomationChain,
  index?: Sql,
) {
  const [checkpoint] = index
    ? await index<
        { epoch: string; block: string; hash: Hex }[]
      >`SELECT epoch::text,indexed_block::text AS block,indexed_hash AS hash FROM ledger_environment WHERE singleton`
    : [];
  if (index && (!checkpoint?.block || !checkpoint.hash)) return;
  for (const row of await store.missingGasReceipts(1, checkpoint?.epoch)) {
    const receipt = await chain.receipt(row.hash);
    if (
      !receipt ||
      receipt.blockHash !== row.blockHash ||
      !(await chain.canonicalFinal(receipt))
    )
      continue;
    if (checkpoint) {
      if (
        receipt.blockNumber > BigInt(checkpoint.block) ||
        !(await chain.canonicalFinal({
          status: "success",
          blockNumber: BigInt(checkpoint.block),
          blockHash: checkpoint.hash,
        }))
      )
        continue;
      const [current] =
        await index!`SELECT epoch::text,indexed_block::text AS block,indexed_hash AS hash FROM ledger_environment WHERE singleton`;
      if (
        current?.epoch !== checkpoint.epoch ||
        current.block !== checkpoint.block ||
        current.hash !== checkpoint.hash
      )
        continue;
    }
    await store.saveReceiptGas(row.id, row.hash, receipt, checkpoint);
  }
}
