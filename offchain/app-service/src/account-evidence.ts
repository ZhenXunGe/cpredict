import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";
import type { Address } from "viem";
import {
  AppError,
  environmentKey,
  type Environment,
} from "../../app-core/src/contracts.js";
import {
  snapshotSchema,
  type LedgerFact,
} from "../../app-core/src/ledger-contracts.js";
import {
  claimReceiptsSchema,
  sponsoredGasSchema,
} from "../../app-core/src/orderbook-contracts.js";
import { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";

const payoutKinds: LedgerFact["kind"][] = [
  "winner-claimed",
  "early-bird-claimed",
  "refunded",
  "timeout-claimed",
  "fee-claimed",
  "bond-claimed",
];
const personalKinds = [
  "winner",
  "early-bird",
  "refund",
  "timeout-bonus",
  "fees",
  "bond",
  "release-order",
];
export interface EvidencePage {
  limit: number;
  cursor?: string;
}
export interface AccountEvidence {
  claimReceipts(owner: Address, page: EvidencePage): Promise<unknown>;
  sponsoredGas(owner: Address, page: EvidencePage): Promise<unknown>;
}
const gasCursor = z.strictObject({
  owner: z.string(),
  snapshot: snapshotSchema,
  before: z.tuple([z.string().datetime({ offset: true }), z.string().max(256)]),
});
type Db = Sql | TransactionSql;
type GasRow = {
  id: string;
  owner: string;
  kind: string;
  source: "user-operation" | "automation";
  transaction_hash: string;
  timestamp: string;
  state: "confirmed" | "reverted";
  actual: string | null;
  personal: boolean;
};

/** Read-only evidence projection. Financial amounts always come from the ledger. */
export class PostgresAccountEvidence implements AccountEvidence {
  readonly ledger: PostgresFinancialLedger;
  constructor(
    readonly sql: Sql,
    readonly environment: Environment,
    readonly control: Sql = sql,
  ) {
    this.ledger = new PostgresFinancialLedger(sql, environment);
  }
  async ready() {
    const [identity] = await this
      .sql`SELECT identity FROM cpredict_environment_identity WHERE singleton`;
    if (identity?.identity !== environmentKey(this.environment))
      throw new AppError("database_environment_mismatch", 503);
    // Check only; migrations must run through the explicit maintenance tool.
    await this
      .control`SELECT actual_gas_cost_wei FROM automation_transactions LIMIT 0`;
  }
  async claimReceipts(owner: Address, page: EvidencePage) {
    const result = await this.ledger.activity({
      owner,
      kinds: payoutKinds,
      ...page,
    });
    const hashes = result.items.map((f) => f.transactionHash);
    const automatic = hashes.length
      ? await this
          .control`SELECT tx_hash,receipt_block::text,receipt_hash,actual_gas_cost_wei::text FROM automation_transactions WHERE chain_id=${this.environment.deployment.chainId} AND deployment_id=${this.environment.deployment.id} AND owner=${owner.toLowerCase()} AND tx_hash IN ${this.control(hashes)} AND state='confirmed' AND canonical_status<>'orphaned'`
      : [];
    const items = await Promise.all(
      result.items
        .filter((f) => f.owner?.toLowerCase() === owner.toLowerCase())
        .map(async (fact) => {
          // EntryPoint emits the operation marker after its calls. The first marker
          // following a claim identifies that exact operation, even in a bundle.
          const [association] = await this.sql`
        SELECT
          marker.fact AS user_operation,operation.id AS manual,operation.billing->>'gasPayment' AS gas_payment,
          (SELECT question FROM public_market_metadata WHERE market=${fact.market?.toLowerCase() ?? null} AND verified=true) AS question,
          CASE WHEN operation.billing->>'gasPayment'='sponsored' AND marker.owner=${owner.toLowerCase()} THEN marker.fact->>'amount' ELSE NULL END AS manual_gas
        FROM (SELECT true) singleton
        LEFT JOIN LATERAL (SELECT f.fact,f.owner FROM ledger_facts f WHERE f.chain_id=${this.environment.deployment.chainId} AND f.kind='user-operation' AND f.transaction_hash=${fact.transactionHash} AND f.log_index>${fact.logIndex} ORDER BY f.log_index,f.fact_index LIMIT 1) marker ON true
        LEFT JOIN LATERAL (SELECT o.id,o.billing FROM app_operations o WHERE o.sender=${owner.toLowerCase()} AND marker.owner=o.sender AND o.record->>'deploymentId'=${this.environment.deployment.id} AND o.record->>'transactionHash'=${fact.transactionHash} AND o.record->>'userOperationHash'=marker.fact->'extra'->>'userOpHash' AND o.kind IN ('claim-winner','claim-early-bird','claim-fees','claim-bond','refund','claim-timeout-bonus','settle-bond-and-claim') ORDER BY o.created_at,o.id LIMIT 1) operation ON true`;
          const automated = automatic.find(
            (t) =>
              t.tx_hash === fact.transactionHash &&
              t.receipt_block === fact.blockNumber &&
              t.receipt_hash === fact.blockHash,
          );
          return {
            fact,
            source: automated
              ? "automatic"
              : association?.manual
                ? "manual"
                : association?.user_operation
                  ? "unknown"
                  : "direct",
            marketQuestion: association?.question ?? null,
            actualGasCostWei:
              automated?.actual_gas_cost_wei ?? association?.manual_gas ?? null,
            gasPayment: automated
              ? "sponsored"
              : (association?.gas_payment ?? "unknown"),
          };
        }),
    );
    await this.ledger.assertSnapshot(result.snapshot);
    return claimReceiptsSchema.parse({ ...result, items });
  }
  private gasRows(
    db: Db,
    block: string,
    automation: unknown,
    owner: Address,
    epoch: string,
  ) {
    const e = this.environment.deployment;
    return db`WITH gas AS (
      SELECT DISTINCT ON (o.record->>'userOperationHash')
        'user-operation:' || (o.record->>'userOperationHash') AS id,o.sender AS owner,o.kind,'user-operation'::text AS source,
        o.record->>'transactionHash' AS transaction_hash,
        COALESCE(to_timestamp(f.occurred_at::double precision),(o.record->>'updatedAt')::timestamptz)::text AS timestamp,
        o.state,CASE WHEN o.billing->>'gasPayment'='sponsored' THEN f.fact->>'amount' ELSE NULL END AS actual,true AS personal
      FROM app_operations o LEFT JOIN ledger_facts f ON f.chain_id=${e.chainId} AND f.kind='user-operation' AND f.owner=o.sender
        AND f.transaction_hash=o.record->>'transactionHash' AND f.fact->'extra'->>'userOpHash'=o.record->>'userOperationHash' AND f.block_number<=${block}
      WHERE o.sender=${owner.toLowerCase()} AND o.record->>'deploymentId'=${e.id} AND o.record->>'userOperationHash' IS NOT NULL AND o.record->>'transactionHash' IS NOT NULL
        AND o.state IN ('confirmed','reverted') AND COALESCE(o.billing->>'gasPayment','unknown')<>'self-funded'
        AND (o.record->>'blockNumber')::numeric<=${block}
      ORDER BY o.record->>'userOperationHash',o.updated_at DESC,o.id
      ), automation_gas AS (
      SELECT DISTINCT ON (t.tx_hash) 'automation:'||t.tx_hash AS id,t.owner,t.kind,'automation'::text AS source,t.tx_hash AS transaction_hash,
        COALESCE(to_timestamp(b.block_timestamp::double precision),to_timestamp(t.actual_gas_timestamp::double precision),t.updated_at)::text AS timestamp,t.state,
        CASE WHEN b.block_hash=t.receipt_hash OR (b.block_hash IS NULL AND anchor.block_hash=t.gas_anchor_hash AND t.gas_anchor_epoch=${epoch}::numeric AND t.gas_anchor_block BETWEEN t.receipt_block AND ${block}::numeric) THEN t.actual_gas_cost_wei::text ELSE NULL END AS actual,
        (t.kind IN ${db(personalKinds)} OR t.kind LIKE 'return-listing:%') AS personal
      FROM jsonb_to_recordset(${db.json(automation as never)}::jsonb) AS t(id text,chain_id bigint,deployment_id text,owner text,kind text,tx_hash text,state text,receipt_block numeric,receipt_hash text,actual_gas_cost_wei numeric,updated_at timestamptz,canonical_status text,gas_anchor_epoch numeric,gas_anchor_block numeric,gas_anchor_hash text,actual_gas_timestamp numeric) LEFT JOIN canonical_blocks b ON b.chain_id=t.chain_id AND b.block_number=t.receipt_block LEFT JOIN canonical_blocks anchor ON anchor.chain_id=t.chain_id AND anchor.block_number=t.gas_anchor_block
      WHERE t.chain_id=${e.chainId} AND t.deployment_id=${e.id} AND t.state IN ('confirmed','reverted') AND t.receipt_block<=${block}
        AND t.canonical_status<>'orphaned' AND t.tx_hash IS NOT NULL
      ORDER BY t.tx_hash,t.updated_at DESC,t.id
      ), all_gas AS (SELECT * FROM gas UNION ALL SELECT * FROM automation_gas)`;
  }
  async sponsoredGas(owner: Address, page: EvidencePage) {
    let cursor: z.infer<typeof gasCursor> | undefined;
    if (page.cursor) {
      try {
        cursor = gasCursor.parse(
          JSON.parse(Buffer.from(page.cursor, "base64url").toString()),
        );
      } catch {
        throw new AppError("invalid_cursor", 400);
      }
      if (
        cursor.owner !== owner.toLowerCase() ||
        cursor.snapshot.deploymentId !== this.environment.deployment.id
      )
        throw new AppError("cursor_filter_mismatch", 400);
    }
    return this.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const snapshot = cursor?.snapshot ?? (await this.ledger.snapshot(db));
        await this.ledger.assertSnapshot(snapshot, db);
        const control = this.control === this.sql ? db : this.control;
        const automation =
          await control`SELECT DISTINCT ON(tx_hash) id::text,chain_id,deployment_id,owner,kind,tx_hash,state,receipt_block::text,receipt_hash,actual_gas_cost_wei::text,updated_at,canonical_status,gas_anchor_epoch::text,gas_anchor_block::text,gas_anchor_hash,actual_gas_timestamp::text FROM automation_transactions WHERE chain_id=${this.environment.deployment.chainId} AND deployment_id=${this.environment.deployment.id} AND state IN ('confirmed','reverted') AND canonical_status<>'orphaned' AND receipt_block<=${snapshot.blockNumber} AND tx_hash IS NOT NULL AND (owner=${owner.toLowerCase()} OR NOT (kind IN ${control(personalKinds)} OR kind LIKE 'return-listing:%')) ORDER BY tx_hash,updated_at DESC,id`;
        const cte = this.gasRows(
          db,
          snapshot.blockNumber,
          JSON.parse(JSON.stringify(automation)),
          owner,
          snapshot.epoch,
        );
        const totals =
          await db`${cte} SELECT personal,COALESCE(sum(actual::numeric),0)::text AS known,count(*) FILTER(WHERE actual IS NULL)::int AS missing FROM all_gas WHERE (personal AND owner=${owner.toLowerCase()}) OR NOT personal GROUP BY personal`;
        const before = cursor
          ? db`AND (timestamp::timestamptz,id)<(${cursor.before[0]}::timestamptz,${cursor.before[1]})`
          : db``;
        const rows = await db<
          GasRow[]
        >`${cte} SELECT * FROM all_gas WHERE personal AND owner=${owner.toLowerCase()} ${before} ORDER BY timestamp::timestamptz DESC,id DESC LIMIT ${page.limit + 1}`;
        const [pending] =
          await db`SELECT count(*)::int AS count FROM app_operations WHERE sender=${owner.toLowerCase()} AND record->>'deploymentId'=${this.environment.deployment.id} AND COALESCE(billing->>'gasPayment','unknown')<>'self-funded' AND (state IN ('submitted','confirming','unknown') OR (state IN ('confirmed','reverted') AND (record->>'blockNumber')::numeric>${snapshot.blockNumber}))`;
        const [keeperPending] =
          await control`SELECT count(*)::int AS count FROM automation_transactions WHERE chain_id=${this.environment.deployment.chainId} AND deployment_id=${this.environment.deployment.id} AND owner=${owner.toLowerCase()} AND (kind IN ${control(personalKinds)} OR kind LIKE 'return-listing:%') AND (state IN ('broadcasting','unknown') OR (state IN ('confirmed','reverted') AND receipt_block>${snapshot.blockNumber}))`;
        const [sharedPending] =
          await control`SELECT count(*)::int AS count FROM automation_transactions WHERE chain_id=${this.environment.deployment.chainId} AND deployment_id=${this.environment.deployment.id} AND NOT (kind IN ${control(personalKinds)} OR kind LIKE 'return-listing:%') AND (state IN ('broadcasting','unknown') OR (state IN ('confirmed','reverted') AND receipt_block>${snapshot.blockNumber}))`;
        const own = totals.find((t) => t.personal),
          shared = totals.find((t) => !t.personal),
          selected = rows.slice(0, page.limit),
          last = selected.at(-1);
        return sponsoredGasSchema.parse({
          scope: "current-environment",
          currency: "ETH",
          knownActualWei: own?.known ?? "0",
          totalActualWei:
            own?.missing ||
            !snapshot.complete ||
            pending?.count ||
            keeperPending?.count
              ? null
              : (own?.known ?? "0"),
          missingCount: own?.missing ?? 0,
          pendingCount: (pending?.count ?? 0) + (keeperPending?.count ?? 0),
          shared: {
            knownActualWei: shared?.known ?? "0",
            totalActualWei:
              shared?.missing || sharedPending?.count || !snapshot.complete
                ? null
                : (shared?.known ?? "0"),
            missingCount: shared?.missing ?? 0,
          },
          items: selected.map((r) => ({
            id: r.id,
            kind: r.kind,
            source: r.source,
            transactionHash: r.transaction_hash,
            timestamp: new Date(r.timestamp).toISOString(),
            state: r.state,
            actualGasCostWei: r.actual,
          })),
          nextCursor:
            rows.length > page.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    owner: owner.toLowerCase(),
                    snapshot,
                    before: [new Date(last.timestamp).toISOString(), last.id],
                  }),
                ).toString("base64url")
              : null,
          snapshot,
        });
      },
    );
  }
}
export function accountEvidenceStore(
  url: string,
  environment: Environment,
  controlUrl = url,
) {
  const sql = postgres(url, {
    max: 4,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  const control =
    controlUrl === url
      ? sql
      : postgres(controlUrl, {
          max: 2,
          connect_timeout: 5,
          onnotice: () => undefined,
        });
  return {
    store: new PostgresAccountEvidence(sql, environment, control),
    close: async () => {
      await sql.end({ timeout: 5 });
      if (control !== sql) await control.end({ timeout: 5 });
    },
  };
}
