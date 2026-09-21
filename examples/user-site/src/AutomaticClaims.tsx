import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./wallets.js";
import { ErrorNotice, Notice } from "./ui.js";
import { automaticClaimsStatusSchema as statusSchema } from "../../../offchain/app-core/src/orderbook-contracts.js";
const reasons: Record<string, string> = {
  waiting_for_entitlement: "待权益满足领取条件",
  received: "已到账",
  confirming: "正在确认到账",
  checking_original_transaction: "正在查询原交易状态",
  daily_gas_budget_exhausted: "今日代付额度已用完，等待恢复；也可手动领取",
  gas_balance_insufficient: "代付 Gas 余额不足，等待恢复；也可手动领取",
  retry_after_chain_check: "链上状态核验中",
  transaction_reverted: "上次领取未成功，正在重新核验",
};
const kindLabel = (kind: string) =>
  kind.startsWith("settle-bond:")
    ? "押金结算"
    : ({
        winner: "赢家收益",
        "early-bird": "早鸟奖励",
        refund: "本金退款",
        "timeout-bonus": "超时补偿",
        fees: "费用收入",
        bond: "可退押金",
        "void-timeout": "超时作废",
      }[kind] ?? "权益处理");
export function AutomaticClaimsPanel() {
  const { api, account } = useSession();
  const cache = useQueryClient();
  const [checked, setChecked] = useState(true);
  const key = [api.key, "automatic-claims", account?.id];
  const status = useQuery({
    queryKey: key,
    enabled: !!account && !!api.environment.features.automaticClaims,
    queryFn: () =>
      api.request(
        `/v1/automatic-claims?accountId=${account!.id}`,
        statusSchema,
        { auth: true },
      ),
    refetchInterval: 5000,
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      api.request("/v1/automatic-claims", statusSchema, {
        auth: true,
        body: { accountId: account!.id, enabled },
      }),
    onSuccess: (data) => {
      cache.setQueryData(key, data);
    },
    onError: () => setChecked(status.data?.enabled ?? true),
  });
  useEffect(() => {
    setChecked(status.data?.enabled ?? true);
  }, [status.data?.enabled, api.key, account?.id]);
  const lastReceived = useRef<string | undefined>(undefined);
  useEffect(() => {
    const confirmed = status.data?.transactions
      .filter((t) => t.state === "confirmed")
      .map((t) => t.id)
      .join(",");
    if (confirmed && confirmed !== lastReceived.current) {
      lastReceived.current = confirmed;
      void cache.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === api.key && q.queryKey[1] !== "automatic-claims",
      });
    }
  }, [status.data, cache, api.key]);
  if (!account || !api.environment.features.automaticClaims) return null;
  return (
    <section className="card" aria-label="自动领取">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={!status.data || change.isPending}
          onChange={(e) => {
            setChecked(e.target.checked);
            change.mutate(e.target.checked);
          }}
        />{" "}
        自动领取权益（默认开启）
      </label>
      <p>
        平台代付
        Gas，收益直接进入你的资产账户，离线也可到账。包含历史未领取权益，可随时关闭。
      </p>
      <Notice>
        有权益人开启自动领取的市场，超过最终结算期限后将自动作废，并按规则处理创作者押金。关闭你的开关不影响其他权益人触发。
      </Notice>
      {status.data && (
        <p role="status">
          {status.data.enabled
            ? (reasons[status.data.reason] ?? "后台核验中")
            : "自动领取已关闭；已提交的交易继续确认，你仍可手动领取。"}
        </p>
      )}
      {status.data?.transactions.length ? (
        <ul aria-label="自动领取记录">
          {status.data.transactions.map((t) => (
            <li key={t.id}>
              {kindLabel(t.kind)} ·{" "}
              {t.state === "confirmed"
                ? "已到账"
                : t.state === "reverted"
                  ? "未成功"
                  : t.state === "cancelled"
                    ? "已取消"
                    : "处理中"}
              {t.tx_hash && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={`${api.environment.explorerUrl}/tx/${t.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看链上记录
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(status.error || change.error) && (
        <ErrorNotice error={status.error ?? change.error} />
      )}
    </section>
  );
}
