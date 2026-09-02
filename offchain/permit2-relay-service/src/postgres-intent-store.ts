import postgres, { type Sql } from "postgres";
import { getAddress, type Hex } from "viem";
import type {
  Permit2RelayIntentStore,
  RelayIntentReservation,
} from "./types.js";

interface IntentRow {
  state: "pending" | "submitted";
  transaction_hash: string | null;
}

export class PostgresPermit2RelayIntentStore
  implements Permit2RelayIntentStore
{
  private readonly sql: Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true,
      onnotice: () => undefined,
    });
  }

  async ready(): Promise<void> {
    const rows = await this.sql<Array<{ intents: string | null }>>`
      SELECT to_regclass('permit2_relay_intents')::text AS intents
    `;
    if (rows[0]?.intents === null || rows[0]?.intents === undefined) {
      throw new Error("Permit2 relay migration is not applied");
    }
  }

  async reserve(input: {
    intentId: Hex;
    owner: `0x${string}`;
    vault: `0x${string}`;
    permitNonce: bigint;
    expiresAt: bigint;
  }): Promise<RelayIntentReservation> {
    const inserted = await this.sql<Array<{ intent_id: string }>>`
      INSERT INTO permit2_relay_intents (
        intent_id, owner, vault, permit_nonce, expires_at, state
      ) VALUES (
        ${input.intentId.toLowerCase()}, ${getAddress(input.owner).toLowerCase()},
        ${getAddress(input.vault).toLowerCase()}, ${input.permitNonce.toString()},
        ${input.expiresAt.toString()}, 'pending'
      )
      ON CONFLICT DO NOTHING
      RETURNING intent_id
    `;
    if (inserted.length === 1) {
      return {
        kind: "acquired",
        markSubmitted: async (hash) => {
          const updated = await this.sql<Array<{ intent_id: string }>>`
            UPDATE permit2_relay_intents
            SET state = 'submitted', transaction_hash = ${hash.toLowerCase()}, updated_at = NOW()
            WHERE intent_id = ${input.intentId.toLowerCase()} AND state = 'pending'
            RETURNING intent_id
          `;
          if (updated.length !== 1) {
            const existing = await this.read(input.intentId);
            if (
              existing?.state !== "submitted" ||
              existing.transaction_hash?.toLowerCase() !== hash.toLowerCase()
            ) {
              throw new Error("relay intent submission could not be committed");
            }
          }
        },
      };
    }
    const existing = await this.read(input.intentId);
    if (existing === null) {
      const nonceReservation = await this.readByOwnerNonce(
        input.owner,
        input.permitNonce,
      );
      if (nonceReservation !== null) return { kind: "pending" };
      throw new Error("relay intent reservation disappeared");
    }
    if (existing.state === "pending") return { kind: "pending" };
    if (existing.transaction_hash === null) {
      throw new Error("submitted relay intent has no transaction hash");
    }
    return { kind: "submitted", hash: existing.transaction_hash as Hex };
  }

  async find(
    intentId: Hex,
  ): Promise<{ state: "pending" } | { state: "submitted"; hash: Hex } | null> {
    const row = await this.read(intentId);
    if (row === null) return null;
    if (row.state === "pending") return { state: "pending" };
    if (row.transaction_hash === null) {
      throw new Error("submitted relay intent has no transaction hash");
    }
    return { state: "submitted", hash: row.transaction_hash as Hex };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  private async read(intentId: Hex): Promise<IntentRow | null> {
    const rows = await this.sql<Array<IntentRow>>`
      SELECT state, transaction_hash FROM permit2_relay_intents
      WHERE intent_id = ${intentId.toLowerCase()}
    `;
    return rows[0] ?? null;
  }

  private async readByOwnerNonce(
    owner: `0x${string}`,
    permitNonce: bigint,
  ): Promise<IntentRow | null> {
    const rows = await this.sql<Array<IntentRow>>`
      SELECT state, transaction_hash FROM permit2_relay_intents
      WHERE owner = ${getAddress(owner).toLowerCase()}
        AND permit_nonce = ${permitNonce.toString()}
    `;
    return rows[0] ?? null;
  }
}
