import type { z } from "zod";
import type { automaticClaimsStatusSchema } from "../../../offchain/app-core/src/orderbook-contracts.js";
type Status = z.infer<typeof automaticClaimsStatusSchema>;
export function automaticQueueMessage(queue: Status["queue"]): string | null {
  if (!queue) return null;
  switch (queue.state) {
    case "unavailable":
      return "自动领取队列状态暂不可用，后台正在恢复核验。";
    case "confirming":
      return `正在确认 ${queue.inFlightCount} 笔领取交易`;
    case "queued":
      return `有 ${queue.readyCount + queue.deferredCount} 项权益等待自动领取`;
    case "discovering":
      return "后台正在核验权益";
    case "idle":
      return "当前没有待自动领取的权益";
    case "paused": {
      const messages: Record<string, string> = {
        chain_check_rate_limit: "RPC 节点请求限流，领取任务已保留并等待重试。",
        chain_check_timeout: "RPC 节点响应超时，领取任务已保留并等待重试。",
        chain_check_rpc_unavailable: "RPC 节点暂不可用，领取任务已保留。",
        chain_check_quota: "RPC 节点额度不足，领取任务已保留。",
        automatic_claims_read_unavailable:
          "RPC 权益读取暂不可用，领取任务已保留。",
        snapshot_invalidated: "规范链快照已变化，后台正在重新核验权益。",
        daily_gas_budget_exhausted: "今日代付 Gas 预算已用完，领取任务已保留。",
        per_transaction_gas_cap_exceeded:
          "本笔领取的预计 Gas 超过代付上限，任务已保留。",
        gas_balance_insufficient: "平台领取账户的 Gas 余额不足，任务已保留。",
        submission_rpc_unavailable: "提交节点暂不可用，领取任务已保留。",
        queue_blocked_unknown_transaction:
          "后台正在核对一笔提交结果未知的交易，后续领取暂时排队。",
        automatic_claims_index_lag: "链上记录索引暂时落后，追平后继续领取。",
        automatic_claims_index_incomplete:
          "链上记录索引尚未完整，后台正在核验。",
        automatic_claims_reorg: "链上发生重组，后台正在重新核验权益。",
        rechecking_after_reorg: "链上发生重组，后台正在重新核验权益。",
      };
      return (
        messages[queue.reason ?? ""] ??
        "链上核验暂未完成，领取任务已保留并等待重试。"
      );
    }
  }
}
export function automaticClaimsRefresh(
  queue: Status["queue"],
  visible: boolean,
): number | false {
  if (!visible) return false;
  return queue &&
    (queue.readyCount + queue.inFlightCount + queue.deferredCount > 0 ||
      queue.state === "discovering")
    ? 2000
    : 5000;
}
