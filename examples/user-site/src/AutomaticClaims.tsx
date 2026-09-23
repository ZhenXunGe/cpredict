import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatUnits } from "viem";
import { automaticClaimsStatusSchema as statusSchema } from "../../../offchain/app-core/src/orderbook-contracts.js";
import {
  marketSchema,
  type Market,
} from "../../../offchain/app-core/src/catalog-contracts.js";
import { useSession } from "./wallets.js";
import {
  Amount,
  DataTable,
  ErrorNotice,
  Loading,
  Notice,
  PaginationControls,
  shortAddress,
} from "./ui.js";

export function AutomaticClaimsPanel() {
  const { api, account } = useSession();
  const cache = useQueryClient();
  const scope = `${api.key}:${account?.id ?? "signed-out"}`;
  const [checked, setChecked] = useState(true);
  const [pagination, setPagination] = useState<PaginationState>({
    scope,
    page: 0,
    cursors: [null],
  });
  const activePagination =
    pagination.scope === scope
      ? pagination
      : { scope, page: 0, cursors: [null] };
  const cursor = activePagination.cursors[activePagination.page] ?? null;
  const key = [api.key, "automatic-claims", account?.id, cursor];
  const status = useQuery({
    queryKey: key,
    enabled: !!account && !!api.environment.features.automaticClaims,
    queryFn: () =>
      api.request(
        `/v1/automatic-claims?accountId=${account!.id}&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
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
      setPagination({ scope, page: 0, cursors: [null] });
      cache.setQueryData(
        [api.key, "automatic-claims", account?.id, null],
        data,
      );
    },
    onError: () => setChecked(status.data?.enabled ?? true),
  });
  useEffect(() => {
    setChecked(status.data?.enabled ?? true);
  }, [status.data?.enabled, api.key, account?.id]);
  const lastReceived = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (activePagination.page !== 0) return;
    const confirmed = status.data?.transactions
      .filter((transaction) => transaction.state === "confirmed")
      .map((transaction) => transaction.id)
      .join(",");
    if (confirmed && confirmed !== lastReceived.current) {
      lastReceived.current = confirmed;
      void cache.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === api.key &&
          query.queryKey[1] !== "automatic-claims",
      });
    }
  }, [status.data, cache, api.key, activePagination.page]);

  const marketIds = [
    ...new Set(
      (status.data?.transactions ?? []).flatMap((transaction) =>
        [
          transaction.context?.market ?? transaction.market,
          ...(transaction.context?.relatedMarkets ?? []).map(
            (related) => related.market,
          ),
        ].flatMap((market) => (market ? [market.toLowerCase()] : [])),
      ),
    ),
  ];
  const marketQueries = useQueries({
    queries: marketIds.map((market) => ({
      queryKey: [api.key, "market", market],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.request(`/v2/markets/${market}`, marketSchema, {
          service: "indexer",
          signal,
        }),
      staleTime: 10000,
    })),
  });
  const marketsByAddress = new Map<string, Market>(
    marketQueries.flatMap((query, index) =>
      query.data ? [[marketIds[index]!, query.data]] : [],
    ),
  );
  const pendingMarkets = new Set(
    marketIds.filter((_, index) => marketQueries[index]?.isPending),
  );
  const marketLabel = (market: string) =>
    marketsByAddress.get(market.toLowerCase())?.question?.trim() ||
    (pendingMarkets.has(market.toLowerCase())
      ? "正在读取市场名称"
      : `名称暂不可用（${shortAddress(market)}）`);

  if (!account || !api.environment.features.automaticClaims) return null;
  return (
    <section className="card" aria-label="自动领取">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={!status.data || change.isPending}
          onChange={(event) => {
            setChecked(event.target.checked);
            change.mutate(event.target.checked);
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
      {status.isPending && <Loading label="正在读取自动领取记录" />}
      {status.data?.transactions.length ? (
        <div role="region" aria-label="自动领取记录">
          <DataTable
            headers={[
              "类型",
              "市场",
              "实际到账",
              "到账 / 处理时间（上海）",
              "状态",
              "链上记录",
            ]}
          >
            {status.data.transactions.map((transaction) => {
              const market = transaction.context?.market ?? transaction.market;
              const amount = transaction.context?.amount ?? transaction.amount;
              const relatedMarkets = transaction.context?.relatedMarkets ?? [];
              return (
                <tr key={transaction.id}>
                  <td>{kindLabel(transaction.kind)}</td>
                  <td>
                    {market ? (
                      <Link
                        to={`/${api.environment.id}/markets/${market}`}
                        title={market}
                      >
                        {transaction.context?.marketQuestion?.trim() ||
                          marketLabel(market)}
                      </Link>
                    ) : relatedMarkets.length ? (
                      <div>
                        {relatedMarkets.map((related) => (
                          <div key={related.market}>
                            <Link
                              to={`/${api.environment.id}/markets/${related.market}`}
                              title={related.market}
                            >
                              {related.marketQuestion?.trim() ||
                                marketLabel(related.market)}
                            </Link>
                          </div>
                        ))}
                      </div>
                    ) : transaction.kind === "fees" ||
                      transaction.kind === "bond" ? (
                      "跨市场汇总"
                    ) : (
                      "—"
                    )}
                    {transaction.context?.outcomeId !== null &&
                      transaction.context?.outcomeId !== undefined && (
                        <div className="small muted">
                          结果：
                          {transaction.context.outcomeLabel ??
                            `#${transaction.context.outcomeId}`}
                        </div>
                      )}
                    {transaction.kind === "bond" &&
                      transaction.context &&
                      !transaction.context.market && (
                        <div className="small muted">
                          {relatedMarkets.length
                            ? "按账户合并领取以上市场的可退押金。"
                            : "按账户合并领取已结算市场的可退押金；该笔到账可能汇总多个市场。"}
                        </div>
                      )}
                    {transaction.kind === "fees" &&
                      transaction.context &&
                      !transaction.context.market && (
                        <div className="small muted">
                          {relatedMarkets.length
                            ? "按账户合并领取以上市场的累计费用。"
                            : "按账户合并领取累计费用；该笔到账可能汇总多个市场或费用来源。"}
                        </div>
                      )}
                  </td>
                  <td>
                    <AutomaticClaimAmount
                      kind={transaction.kind}
                      effect={transaction.effect}
                      state={transaction.state}
                      amount={amount}
                      units={transaction.context?.units ?? null}
                      asset={api.environment.asset}
                    />
                  </td>
                  <td>
                    {formatTime(
                      transaction.completed_at ?? transaction.created_at,
                    )}
                  </td>
                  <td>
                    {transactionStateLabel(
                      transaction.kind,
                      transaction.effect,
                      transaction.state,
                    )}
                    {transaction.kind.startsWith("settle-bond:") && (
                      <div className="small muted">
                        仅完成市场级押金结算，不代表押金进入你的账户
                      </div>
                    )}
                    {transaction.state === "confirmed" &&
                      !transaction.context &&
                      PERSONAL_CLAIM_KINDS.has(transaction.kind) && (
                        <div className="small muted">链上明细索引中</div>
                      )}
                  </td>
                  <td>
                    {transaction.tx_hash ? (
                      <a
                        href={`${api.environment.explorerUrl}/tx/${transaction.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </div>
      ) : null}
      <PaginationControls
        ariaLabel="自动领取记录分页"
        page={activePagination.page}
        hasPrevious={activePagination.page > 0}
        hasNext={!!status.data?.nextCursor}
        busy={status.isFetching}
        onPrevious={() =>
          setPagination((current) => {
            const value = current.scope === scope ? current : activePagination;
            return { ...value, page: Math.max(0, value.page - 1) };
          })
        }
        onNext={() => {
          const nextCursor = status.data?.nextCursor;
          if (!nextCursor) return;
          setPagination((current) => {
            const value = current.scope === scope ? current : activePagination;
            const cursors = value.cursors.slice(0, value.page + 1);
            cursors[value.page + 1] = nextCursor;
            return { ...value, page: value.page + 1, cursors };
          });
        }}
      />
      {(status.error || change.error || marketQueries.find((q) => q.error)) && (
        <ErrorNotice
          error={
            status.error ??
            change.error ??
            marketQueries.find((query) => query.error)?.error
          }
          retry={() => {
            void status.refetch();
            for (const query of marketQueries) void query.refetch();
          }}
        />
      )}
    </section>
  );
}

function AutomaticClaimAmount({
  kind,
  effect,
  state,
  amount,
  units,
  asset,
}: {
  kind: string;
  effect: "payout" | "asset-return" | undefined;
  state: string;
  amount: string | null;
  units: string | null;
  asset: string;
}) {
  if (effect === "asset-return" || kind.startsWith("return-listing:")) {
    if (state !== "confirmed") return <span className="muted">待链上确认</span>;
    if (units === null) return <span className="muted">等待索引返还份额</span>;
    return <>{formatUnits(BigInt(units), 6)} 份</>;
  }
  if (!PERSONAL_CLAIM_KINDS.has(kind))
    return <span className="muted">不涉及个人到账</span>;
  if (state !== "confirmed") return <span className="muted">待链上确认</span>;
  if (amount === null) return <span className="muted">等待索引到账金额</span>;
  return <Amount value={amount} asset={asset} />;
}

function kindLabel(kind: string) {
  if (kind.startsWith("settle-bond:")) return "市场押金处理";
  if (kind.startsWith("return-listing:")) return "挂单资产返还";
  return KIND_LABELS[kind] ?? "权益处理";
}

function transactionStateLabel(
  kind: string,
  effect: "payout" | "asset-return" | undefined,
  state: string,
) {
  if (state === "confirmed") {
    if (effect === "payout" || (!effect && PERSONAL_CLAIM_KINDS.has(kind)))
      return "已到账";
    if (effect === "asset-return" || kind.startsWith("return-listing:"))
      return "已返还";
    return "已完成";
  }
  if (state === "reverted") return "未成功";
  if (state === "cancelled") return "已取消";
  return "处理中";
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

interface PaginationState {
  scope: string;
  page: number;
  cursors: (string | null)[];
}

const PAGE_SIZE = 5;
const PERSONAL_CLAIM_KINDS = new Set([
  "winner",
  "early-bird",
  "refund",
  "timeout-bonus",
  "fees",
  "bond",
]);
const KIND_LABELS: Record<string, string> = {
  winner: "赢家收益",
  "early-bird": "早鸟奖励",
  refund: "本金退款",
  "timeout-bonus": "超时补偿",
  fees: "费用收入",
  bond: "可退押金",
  "void-timeout": "超时作废",
};
const reasons: Record<string, string> = {
  waiting_for_entitlement: "待权益满足领取条件",
  received: "已到账",
  confirming: "正在确认到账",
  checking_original_transaction: "正在查询原交易状态",
  queue_blocked_unknown_transaction:
    "自动领取队列暂缓：一笔后台交易尚未确认，正在核查。无需重复开关，可先手动领取。",
  submission_rpc_unavailable:
    "自动领取暂缓：发送服务当前不可用，等待恢复；也可手动领取。",
  daily_gas_budget_exhausted: "今日代付额度已用完，等待恢复；也可手动领取",
  gas_balance_insufficient: "代付 Gas 余额不足，等待恢复；也可手动领取",
  cleanup_account_quota_exceeded: "自动挂单清理已达账户配额；可手动撤单、取回资产或领取",
  cleanup_market_quota_exceeded: "自动挂单清理已达市场配额；可手动撤单、取回资产或领取",
  retry_after_chain_check: "链上状态核验中",
  transaction_reverted: "上次领取未成功，正在重新核验",
  rechecking_after_reorg: "链上发生重组，原到账记录已撤回，后台正在重新核验",
  assets_returned: "挂单资产已返还",
};
