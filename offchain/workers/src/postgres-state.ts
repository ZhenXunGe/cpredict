import type { Sql } from "postgres";
import type { Address } from "viem";
import type {
  MaintenanceResult,
  TerminalWorkerState,
} from "./terminal-workers.js";

export class PostgresTerminalWorkerState implements TerminalWorkerState {
  constructor(
    private readonly sql: Sql,
    private readonly chainId: number,
  ) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0)
      throw new RangeError("invalid chainId");
  }

  async lastAttemptBlock(market: Address): Promise<bigint | undefined> {
    const rows = await this.sql<Array<{ last_attempt_block: string }>>`
      SELECT last_attempt_block
      FROM terminal_worker_attempts
      WHERE chain_id = ${this.chainId} AND market = ${market.toLowerCase()}
    `;
    const row = rows[0];
    return row === undefined ? undefined : BigInt(row.last_attempt_block);
  }

  async recordAttempt(
    market: Address,
    blockNumber: bigint,
    results: readonly MaintenanceResult[],
  ): Promise<void> {
    const serialized = results.map((result) => ({
      operation: result.operation,
      outcome: result.outcome,
      hash: result.hash ?? null,
      reason: result.reason ?? null,
    }));
    await this.sql`
      INSERT INTO terminal_worker_attempts (chain_id, market, last_attempt_block, results)
      VALUES (
        ${this.chainId}, ${market.toLowerCase()}, ${blockNumber.toString()},
        ${JSON.stringify(serialized)}
      )
      ON CONFLICT (chain_id, market) DO UPDATE SET
        last_attempt_block = EXCLUDED.last_attempt_block,
        results = EXCLUDED.results,
        updated_at = NOW()
    `;
  }
}
