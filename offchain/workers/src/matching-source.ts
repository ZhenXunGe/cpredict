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
export class MatchingSource implements AutomationSource {
  constructor(
    readonly sql: Sql,
    readonly client: PublicClient,
    readonly env: Environment,
  ) {}
  async *candidates(): AsyncIterable<AutomaticAction> {
    if (this.env.deployment.marketplaceVersion !== "orderbook-v2") return;
    const target = this.env.deployment.marketplace,
      head = await this.client.getBlock();
    const rows = await this
      .sql`SELECT c.order_id,c.args FROM orderbook_events c WHERE c.event_name='OrderCreated' AND c.chain_id=${this.env.deployment.chainId} AND c.marketplace=${target.toLowerCase()} AND NOT EXISTS(SELECT 1 FROM orderbook_events e WHERE e.chain_id=c.chain_id AND e.marketplace=c.marketplace AND e.order_id=c.order_id AND (e.event_name='OrderReleased' OR (e.event_name='OrderFilled' AND e.args->>'remainingUnits'='0'))) ORDER BY c.order_id`;
    const pairs = new Map<string, { market: Address; outcome: number }>();
    for (const r of rows) {
      const id = BigInt(r.order_id);
      const o = await this.client.readContract({
        address: target,
        abi: orderbookAbi,
        functionName: "orders",
        args: [id],
        blockNumber: head.number,
      });
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
      const terminal = await this.client.readContract({
        address: o[0],
        abi: parseAbi(["function isTerminal() view returns(bool)"]),
        functionName: "isTerminal",
        blockNumber: head.number,
      });
      if (terminal || o[4] <= head.timestamp)
        yield action(
          "release-order",
          encodeFunctionData({
            abi: orderbookAbi,
            functionName: "releaseOrder",
            args: [id],
          }),
        );
      else if (o[7])
        pairs.set(`${o[0]}:${o[5]}`, { market: o[0], outcome: o[5] });
    }
    for (const { market, outcome } of pairs.values()) {
      const base = {
        address: target,
        abi: orderbookAbi,
        blockNumber: head.number,
      };
      const bidId = await this.client.readContract({
        ...base,
        functionName: "bestOrder",
        args: [market, outcome, 0],
      });
      const askId = await this.client.readContract({
        ...base,
        functionName: "bestOrder",
        args: [market, outcome, 1],
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
      const units = bid[2] < ask[2] ? bid[2] : ask[2],
        price = bidId < askId ? bid[3] : ask[3];
      if (
        bid[1].toLowerCase() !== ask[1].toLowerCase() &&
        (units * price) / 1000000n === 0n
      )
        continue;
      yield {
        key: `match:${market}:${outcome}`,
        owner: bid[1],
        kind: "match-orders",
        target,
        data: encodeFunctionData({
          abi: orderbookAbi,
          functionName: "matchOrders",
          args: [market, outcome, 1n],
        }),
        requiresClaimPreference: false,
      };
    }
  }
}
