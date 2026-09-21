import type { Sql } from "postgres";
import type { Hex, PublicClient } from "viem";

interface SparseRangeRow {
  from_block: string;
  to_block: string;
  predecessor_block_hash: Hex | null;
  end_block_hash: Hex;
  confirmation_status: "provisional" | "confirmed";
}

export interface DenseCanonicalBlock {
  block_number: string;
  block_hash: Hex;
  parent_hash: Hex;
  block_timestamp: string;
}

export interface DensifyCanonicalReport {
  chainId: number;
  apply: boolean;
  sparseRanges: number;
  missingBlocks: number;
  densifiedRanges: number;
}

/**
 * Materialize every block header in sparse ranges before an old dense-only
 * indexer image is allowed to start. The operation holds the same per-chain
 * advisory lock as ingestion and promotes a range to dense only after the
 * complete parent-hash lineage is present and matches the live chain.
 */
export async function densifyCanonicalRanges(
  sql: Sql,
  client: Pick<PublicClient, "getBlock">,
  chainId: number,
  apply: boolean,
): Promise<DensifyCanonicalReport> {
  const ranges = await sql<SparseRangeRow[]>`
    SELECT from_block,to_block,predecessor_block_hash,end_block_hash,confirmation_status
    FROM canonical_scan_ranges
    WHERE chain_id=${chainId} AND canonical_mode='sparse'
    ORDER BY from_block
  `;
  let missingBlocks = 0;
  let densifiedRanges = 0;
  for (const range of ranges) {
    const from = BigInt(range.from_block), to = BigInt(range.to_block);
    const existing = await sql<DenseCanonicalBlock[]>`
      SELECT block_number,block_hash,parent_hash,block_timestamp
      FROM canonical_blocks
      WHERE chain_id=${chainId}
        AND block_number BETWEEN ${from.toString()} AND ${to.toString()}
      ORDER BY block_number
    `;
    const byNumber = new Map(existing.map((row) => [BigInt(row.block_number), row]));
    const missing: bigint[] = [];
    for (let number = from; number <= to; number += 1n)
      if (!byNumber.has(number)) missing.push(number);
    missingBlocks += missing.length;
    if (!apply) continue;

    const endpointBefore = await client.getBlock({ blockNumber: to });
    if (endpointBefore.hash !== range.end_block_hash)
      throw new Error("sparse range endpoint no longer matches the live chain");
    const fetched = await mapConcurrent(missing, 8, async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      if (block.hash === null)
        throw new Error("RPC returned an incomplete block while densifying");
      return {
        block_number: blockNumber.toString(),
        block_hash: block.hash,
        parent_hash: block.parentHash,
        block_timestamp: block.timestamp.toString(),
      } satisfies DenseCanonicalBlock;
    });
    for (const row of fetched) byNumber.set(BigInt(row.block_number), row);
    validateDenseLineage(from, to, range.predecessor_block_hash, range.end_block_hash, byNumber);
    const endpointAfter = await client.getBlock({ blockNumber: to });
    if (endpointAfter.hash !== endpointBefore.hash)
      throw new Error("sparse range changed while densifying");

    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(${chainId})`;
      const current = (
        await transaction<{ block_hash: Hex }[]>`
          SELECT block_hash FROM canonical_blocks
          WHERE chain_id=${chainId} AND block_number=${to.toString()}
          FOR UPDATE
        `
      )[0];
      if (current?.block_hash !== range.end_block_hash)
        throw new Error("stored sparse endpoint changed while densifying");
      for (const row of fetched)
        await transaction`
          INSERT INTO canonical_blocks(
            chain_id,block_number,block_hash,parent_hash,block_timestamp,confirmation_status
          ) VALUES(
            ${chainId},${row.block_number},${row.block_hash},${row.parent_hash},
            ${row.block_timestamp},${range.confirmation_status}
          ) ON CONFLICT DO NOTHING
        `;
      const stored = await transaction<DenseCanonicalBlock[]>`
        SELECT block_number,block_hash,parent_hash,block_timestamp
        FROM canonical_blocks
        WHERE chain_id=${chainId}
          AND block_number BETWEEN ${from.toString()} AND ${to.toString()}
        ORDER BY block_number
      `;
      validateDenseLineage(
        from,
        to,
        range.predecessor_block_hash,
        range.end_block_hash,
        new Map(stored.map((row) => [BigInt(row.block_number), row])),
      );
      await transaction`
        UPDATE canonical_scan_ranges SET canonical_mode='dense'
        WHERE chain_id=${chainId} AND to_block=${to.toString()}
          AND canonical_mode='sparse' AND end_block_hash=${range.end_block_hash}
      `;
    });
    densifiedRanges += 1;
  }
  return {
    chainId,
    apply,
    sparseRanges: ranges.length,
    missingBlocks,
    densifiedRanges,
  };
}

export function validateDenseLineage(
  from: bigint,
  to: bigint,
  predecessorHash: Hex | null,
  endpointHash: Hex,
  blocks: ReadonlyMap<bigint, DenseCanonicalBlock>,
): void {
  let previousHash = predecessorHash;
  for (let number = from; number <= to; number += 1n) {
    const block = blocks.get(number);
    if (block === undefined)
      throw new Error(`dense rollback history is missing block ${number.toString()}`);
    if (previousHash !== null && block.parent_hash !== previousHash)
      throw new Error(`dense rollback history has a lineage conflict at block ${number.toString()}`);
    previousHash = block.block_hash;
  }
  if (previousHash !== endpointHash)
    throw new Error("dense rollback history endpoint does not match its range");
}

async function mapConcurrent<T, R>(
  inputs: readonly T[],
  concurrency: number,
  worker: (input: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(inputs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (cursor < inputs.length) {
        const index = cursor++;
        output[index] = await worker(inputs[index]!);
      }
    }),
  );
  return output;
}
