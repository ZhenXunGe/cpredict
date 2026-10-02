import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import type { Sql } from "postgres";
import type { Environment } from "../../app-core/src/contracts.js";
import { orderbookAbi } from "../../sdk/src/orderbook.js";
import type { AutomaticAction, AutomationSource } from "./automatic-claims.js";
import type { PostgresAutomaticStore } from "./automatic-store.js";
export class MatchingSource implements AutomationSource {
  private lastRevision: string | undefined;
  private lastFullScanAt = Number.NEGATIVE_INFINITY;
  private pendingActions: AutomaticAction[] = [];
  private indexedBlock: bigint | undefined;
  private activeOrders = new Map<
    string,
    readonly [
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      number,
      number,
      boolean,
      boolean,
      bigint,
    ]
  >();
  private partialPolicy = new Map<string, boolean>();
  private lastMatchKey: string | undefined;
  private lastEpoch: string | undefined;
  constructor(
    readonly sql: Sql,
    readonly client: PublicClient,
    readonly env: Environment,
    readonly nowMs: () => number = Date.now,
    readonly maintenanceIntervalMs = 30000,
    readonly quota?: PostgresAutomaticStore,
  ) {}
  async *candidates(): AsyncIterable<AutomaticAction> {
    if (this.env.deployment.marketplaceVersion !== "orderbook-v2") return;
    const target = this.env.deployment.marketplace;
    const grouped = this.env.deployment.orderbookFillPolicyVersion === 1;
    const epoch = grouped
      ? (
          await this
            .sql`SELECT epoch::text AS epoch FROM ledger_environment WHERE singleton`
        )[0]?.epoch
      : undefined;
    if (grouped && !epoch) throw new Error("matching_indexer_unavailable");
    const [latest] = await this
      .sql`SELECT block_number,transaction_hash,transaction_index,log_index FROM orderbook_events WHERE chain_id=${this.env.deployment.chainId} AND marketplace=${target.toLowerCase()} ORDER BY block_number DESC,transaction_index DESC,log_index DESC LIMIT 1`;
    const revision = latest
        ? `${latest.block_number}:${latest.transaction_hash}:${latest.transaction_index}:${latest.log_index}`
        : "empty",
      scanAt = this.nowMs();
    if (
      epoch === this.lastEpoch &&
      revision === this.lastRevision &&
      scanAt - this.lastFullScanAt < this.maintenanceIntervalMs
    ) {
      while (this.pendingActions.length > 0) {
        const action = this.pendingActions.shift()!;
        if (action.kind === "match-orders") this.lastMatchKey = action.key;
        yield action;
      }
      return;
    }
    const head = await this.client.getBlock();
    const currentBlock = latest ? BigInt(latest.block_number) : 0n;
    // A backwards watermark invalidates the derived cache; repeat the bounded
    // open-order bootstrap. Same-block updates are deliberately replayed.
    const incremental =
      grouped &&
      epoch === this.lastEpoch &&
      this.indexedBlock !== undefined &&
      currentBlock >= this.indexedBlock;
    const rows = incremental
      ? await this
          .sql`SELECT DISTINCT order_id FROM orderbook_events WHERE chain_id=${this.env.deployment.chainId} AND marketplace=${target.toLowerCase()} AND order_id IS NOT NULL AND block_number >= ${this.indexedBlock!.toString()} ORDER BY order_id`
      : await this
          .sql`SELECT c.order_id,c.args FROM orderbook_events c WHERE c.event_name='OrderCreated' AND c.chain_id=${this.env.deployment.chainId} AND c.marketplace=${target.toLowerCase()} AND NOT EXISTS(SELECT 1 FROM orderbook_events e WHERE e.chain_id=c.chain_id AND e.marketplace=c.marketplace AND e.order_id=c.order_id AND (e.event_name='OrderReleased' OR (e.event_name='OrderFilled' AND e.args->>'remainingUnits'='0'))) ORDER BY c.order_id`;
    const orders = incremental
      ? new Map(this.activeOrders)
      : new Map<
          string,
          readonly [
            Address,
            Address,
            bigint,
            bigint,
            bigint,
            number,
            number,
            boolean,
            boolean,
            bigint,
          ]
        >();
    const policies = incremental
      ? new Map(this.partialPolicy)
      : new Map<string, boolean>();
    for (const row of rows) {
      const id = BigInt(row.order_id);
      const order = await this.client.readContract({
        address: target,
        abi: orderbookAbi,
        functionName: "orders",
        args: [id],
        blockNumber: head.number,
      });
      if (order[8]) {
        orders.set(id.toString(), order);
        if (grouped && !policies.has(id.toString()))
          policies.set(
            id.toString(),
            await this.client.readContract({
              address: target,
              abi: orderbookAbi,
              functionName: "orderAllowsPartialFills",
              args: [id],
              blockNumber: head.number,
            }),
          );
      } else {
        orders.delete(id.toString());
        policies.delete(id.toString());
      }
    }
    const terminalBlocking: AutomaticAction[] = [];
    const routineCleanup: AutomaticAction[] = [];
    const matches: AutomaticAction[] = [];
    const pairs = new Map<
      string,
      { market: Address; outcome: number; units?: bigint }
    >();
    const terminalByMarket = new Map<string, boolean>();
    for (const [orderId, o] of orders) {
      const id = BigInt(orderId);
      if (!o[8]) continue;
      const action = (
        kind: string,
        data: AutomaticAction["data"],
      ): AutomaticAction => ({
        key: `${kind}:${id}`,
        owner: o[1],
        kind,
        target,
        data,
        requiresClaimPreference: false,
      });
      const marketKey = o[0].toLowerCase();
      let terminal = terminalByMarket.get(marketKey);
      if (terminal === undefined) {
        terminal = await this.client.readContract({
          address: o[0],
          abi: parseAbi(["function isTerminal() view returns(bool)"]),
          functionName: "isTerminal",
          blockNumber: head.number,
        });
        terminalByMarket.set(marketKey, terminal);
      }
      if (terminal || o[4] <= head.timestamp) {
        const cleanup: AutomaticAction = {
          ...action(
            "release-order",
            encodeFunctionData({
              abi: orderbookAbi,
              functionName: "releaseOrder",
              args: [id],
            }),
          ),
          cleanupMarket: o[0],
          cleanupPriority:
            terminal && o[6] === 1 ? "terminal-blocking" : "routine",
        };
        const blocked = await this.quota?.cleanupQuota(cleanup);
        if (blocked) await this.quota?.status(cleanup.owner, blocked);
        else
          (cleanup.cleanupPriority === "terminal-blocking"
            ? terminalBlocking
            : routineCleanup
          ).push(cleanup);
      } else if (o[7]) {
        if (grouped) {
          pairs.set(`${o[0]}:${o[5]}:${o[2]}`, {
            market: o[0],
            outcome: o[5],
            units: o[2],
          });
          if (policies.get(orderId))
            pairs.set(`${o[0]}:${o[5]}:partial`, {
              market: o[0],
              outcome: o[5],
            });
        } else pairs.set(`${o[0]}:${o[5]}`, { market: o[0], outcome: o[5] });
      }
    }
    for (const { market, outcome, units: groupUnits } of pairs.values()) {
      const base = {
        address: target,
        abi: orderbookAbi,
        blockNumber: head.number,
      };
      const bidId = await this.client.readContract({
        ...base,
        functionName: grouped
          ? groupUnits === undefined
            ? "bestPartialOrder"
            : "bestOrderForUnits"
          : "bestOrder",
        args:
          groupUnits === undefined
            ? [market, outcome, 0]
            : [market, outcome, 0, groupUnits],
      });
      const askId = await this.client.readContract({
        ...base,
        functionName: grouped
          ? groupUnits === undefined
            ? "bestPartialOrder"
            : "bestOrderForUnits"
          : "bestOrder",
        args:
          groupUnits === undefined
            ? [market, outcome, 1]
            : [market, outcome, 1, groupUnits],
      });
      if (!bidId || !askId) continue;
      const bid = await this.client.readContract({
        ...base,
        functionName: "orders",
        args: [bidId],
      });
      const ask = await this.client.readContract({
        ...base,
        functionName: "orders",
        args: [askId],
      });
      if (bid[3] < ask[3]) continue;
      // Equal partial heads are already served through the quantity group;
      // don't queue a second transaction for the same pair.
      if (grouped && groupUnits === undefined && bid[2] === ask[2]) continue;
      const units = bid[2] < ask[2] ? bid[2] : ask[2],
        price = bidId < askId ? bid[3] : ask[3];
      if (
        bid[1].toLowerCase() !== ask[1].toLowerCase() &&
        (units * price) / 1000000n === 0n
      )
        continue;
      matches.push({
        key: `match:${market}:${outcome}${grouped ? (groupUnits === undefined ? ":partial" : `:units:${groupUnits}`) : ""}`,
        owner: bid[1],
        kind: "match-orders",
        target,
        data: encodeFunctionData({
          abi: orderbookAbi,
          functionName:
            groupUnits === undefined ? "matchOrders" : "matchOrdersForUnits",
          args:
            groupUnits === undefined
              ? [market, outcome, 1n]
              : [market, outcome, groupUnits, 1n],
        }),
        requiresClaimPreference: false,
      });
    }
    this.activeOrders = orders;
    this.partialPolicy = policies;
    this.indexedBlock = currentBlock;
    this.lastEpoch = epoch;
    const previous = matches.findIndex(
      (action) => action.key === this.lastMatchKey,
    );
    if (previous >= 0) matches.push(...matches.splice(0, previous + 1));
    this.lastRevision = revision;
    this.lastFullScanAt = scanAt;
    this.pendingActions = [...terminalBlocking, ...routineCleanup, ...matches];
    while (this.pendingActions.length > 0) {
      const action = this.pendingActions.shift()!;
      if (action.kind === "match-orders") this.lastMatchKey = action.key;
      yield action;
    }
  }
}
