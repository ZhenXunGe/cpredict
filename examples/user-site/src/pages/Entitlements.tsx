import { useEffect } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { z } from "zod";
import {
  entitlementsResponseSchema,
  pnlResponseSchema,
  type Entitlement,
} from "../../../../offchain/app-core/src/ledger-contracts.js";
import { operationSchema } from "../../../../offchain/app-core/src/contracts.js";
import {
  marketSchema,
  type Market,
} from "../../../../offchain/app-core/src/catalog-contracts.js";
import { useSession } from "../wallets.js";
import { useRules } from "../data.js";
import {
  AccountGate,
  useCurrentOperation,
  useOperation,
} from "../operations.js";
import {
  entitlementIntent,
  entitlementOperations,
  entitlementProgress,
  entitlementRefreshInterval,
  snapshotIncludesOperation,
} from "../entitlements-sync.js";
import {
  Amount,
  Button,
  DataTable,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageTitle,
  shortAddress,
} from "../ui.js";

export const rightLabels: Record<Entitlement["kind"], string> = {
  holding: "普通持仓",
  escrow: "挂单托管份额",
  winner: "赢家收益",
  "early-bird": "早鸟返还",
  refund: "本金退款",
  "timeout-bonus": "超时补偿",
  bond: "创作者押金",
  fees: "费用收入",
};
const states: Record<Entitlement["status"], string> = {
  conditional: "待满足条件",
  claimable: "可领取",
  executing: "执行中",
  claimed: "已处理",
  unknown: "待核对",
};
const reasons: Record<string, string> = {
  waiting_for_timeout_bond_funding: "本金退款后，须等待押金注入补偿池。",
  refund_before_timeout_compensation:
    "预计补偿金额如下，请先领取本金，再领取超时补偿。实际到账以链上结算为准。",
  refund_and_funding_before_timeout_compensation:
    "请先领取本金，并等待押金注入超时补偿池后领取补偿。",
  principal_first_then_timeout_compensation: "领取本金后，可继续领取超时补偿。",
  credited_to_aggregate_balance: "已记入押金可领取余额；在汇总余额中领取到账。",
  bond_slashed_into_timeout_pool: "押金已罚没并注入超时补偿池。",
  bond_slashed_pending_timeout_funding:
    "市场已超时作废，押金已罚没，待注入超时补偿池，无法领取。",
  settle_bond_before_claiming_credit: "先结算押金，再领取汇总余额。",
  settle_and_claim_bond: "将结算并领取押金，一笔操作到账。",
  chain_read_unavailable: "链上查询暂不可用，请重新查询。",
  cancel_listing_to_recover_shares: "撤单取回未成交份额，不产生已实现收益。",
  return_terminal_listing: "市场已终局，先取回托管份额再领取权益。",
};
export function EntitlementsPage() {
  const { api, account } = useSession(),
    request = useOperation(),
    currentOperation = useCurrentOperation();
  const pending = useQuery({
    queryKey: [api.key, "entitlement-operations", account?.id],
    enabled: !!account,
    queryFn: ({ signal }) =>
      api.request(
        `/v1/operations?accountId=${account!.id}&limit=100`,
        z.object({ items: z.array(operationSchema) }),
        { auth: true, signal },
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  const operations = entitlementOperations(
    account,
    pending.data?.items,
    currentOperation,
  );
  const pnl = useQuery({
    queryKey: [api.key, "pnl", account?.address],
    enabled: !!account,
    queryFn: ({ signal }) =>
      api.request(`/v2/pnl/${account!.address}`, pnlResponseSchema, {
        service: "indexer",
        signal,
      }),
    refetchInterval: (q) =>
      entitlementRefreshInterval(operations, [q.state.data?.snapshot]),
    refetchOnWindowFocus: true,
  });
  const rights = useInfiniteQuery({
    queryKey: [api.key, "entitlements", account?.address],
    enabled: !!account,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v2/entitlements/${account!.address}?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        entitlementsResponseSchema,
        { service: "indexer", signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (q) =>
      entitlementRefreshInterval(
        operations,
        q.state.data?.pages.map((p) => p.snapshot) ?? [],
      ),
    refetchOnWindowFocus: true,
  });
  const snapshot = rights.data?.pages[0]?.snapshot,
    items =
      rights.data?.pages.flatMap((p) =>
        p.items.map((item) => ({ item, snapshot: p.snapshot })),
      ) ?? [],
    currentItems = items.filter(({ item, snapshot: rowSnapshot }) => {
      if (entitlementProgress(item, operations, rowSnapshot)) return true;
      if (item.status === "claimed") return false;
      if (item.status === "unknown" || item.status === "executing") return true;
      if (item.kind === "holding" && item.units === "0") return false;
      if (
        item.status === "conditional" &&
        item.amount === "0" &&
        ["winner", "refund", "early-bird"].includes(item.kind)
      )
        return false;
      return !(
        item.market === null &&
        (item.kind === "fees" || item.kind === "bond") &&
        item.status === "conditional" &&
        item.amount === "0"
      );
    }),
    marketIds = [
      ...new Set(
        [
          ...currentItems.flatMap(({ item }) =>
            item.market ? [item.market] : [],
          ),
          ...(pnl.data?.pnl.lots
            .filter((lot) => BigInt(lot.units) > 0n)
            .map((lot) => lot.market) ?? []),
        ].map((market) => market.toLowerCase()),
      ),
    ],
    syncing = operations.some(
      (o) =>
        o.state === "confirmed" &&
        (!snapshotIncludesOperation(pnl.data?.snapshot, o) ||
          !rights.data?.pages.every((p) =>
            snapshotIncludesOperation(p.snapshot, o),
          )),
    );
  const marketQueries = useQueries({
      queries: marketIds.map((market) => ({
        queryKey: [api.key, "market", market],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.request(`/v2/markets/${market}`, marketSchema, {
            service: "indexer",
            signal,
          }),
        staleTime: 10000,
        refetchInterval: 15000,
      })),
    }),
    marketsByAddress = new Map<string, Market>(
      marketQueries.flatMap((query, index) =>
        query.data ? [[marketIds[index]!, query.data]] : [],
      ),
    ),
    marketsPending = marketQueries.some((query) => query.isPending),
    pendingMarkets = new Set(
      marketIds.filter((_, index) => marketQueries[index]?.isPending),
    ),
    marketFor = (market: string) => marketsByAddress.get(market.toLowerCase()),
    marketLabel = (market: string) =>
      marketFor(market)?.question?.trim() ||
      (pendingMarkets.has(market.toLowerCase())
        ? "正在读取市场名称"
        : `名称暂不可用（${shortAddress(market)}）`),
    visibleItems = currentItems.filter(
      ({ item }) =>
        !(
          item.kind === "holding" &&
          item.status !== "unknown" &&
          item.status !== "executing" &&
          item.market &&
          (pendingMarkets.has(item.market.toLowerCase()) ||
            marketFor(item.market)?.state === 1 ||
            marketFor(item.market)?.state === 2)
        ),
    ),
    visibleLots = (pnl.data?.pnl.lots ?? []).filter(
      (lot) =>
        BigInt(lot.units) > 0n &&
        !pendingMarkets.has(lot.market.toLowerCase()) &&
        marketFor(lot.market)?.state !== 1 &&
        marketFor(lot.market)?.state !== 2,
    );
  useEffect(() => {
    if (
      !visibleItems.length &&
      !marketsPending &&
      rights.hasNextPage &&
      !rights.isFetching &&
      !rights.error
    )
      void rights.fetchNextPage();
  }, [
    visibleItems.length,
    marketsPending,
    rights.hasNextPage,
    rights.isFetching,
    rights.error,
    rights.fetchNextPage,
  ]);
  return (
    <>
      <PageTitle
        title="持仓与权益"
        description="仅显示当前持仓和待处理权益。领取完成并同步后自动移除，历史记录可在交易历史中查看。"
      />
      <AccountGate />
      {account && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <span>已实现净收益</span>
              <strong>
                <Amount
                  value={pnl.data?.pnl.realizedNet}
                  asset={api.environment.asset}
                  sign
                />
              </strong>
            </div>
            <div className="stat-card">
              <span>已知部分净收益</span>
              <strong>
                <Amount
                  value={pnl.data?.pnl.knownRealizedNet}
                  asset={api.environment.asset}
                  sign
                />
              </strong>
            </div>
            <div className="stat-card">
              <span>统计区块</span>
              <strong>{snapshot?.blockNumber ?? "等待同步"}</strong>
            </div>
          </div>
          {syncing && (
            <Notice>
              交易已确认，权益与收益正在等待同步。页面会自动更新，请勿重复领取。
            </Notice>
          )}
          {pnl.data && !pnl.data.pnl.complete && (
            <Notice tone="warning">
              成本或历史覆盖不完整，暂不提供完整净收益，也不以已知部分参与排名。
              <details>
                <summary>查看缺失原因</summary>
                <ul>
                  {pnl.data.pnl.missingReasons.map((r) => (
                    <li key={r}>
                      <code>{r}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </Notice>
          )}
          {snapshot?.status === "shadow" && (
            <Notice>
              当前是影子账本，尚未通过与链上状态的切换对账。领取资格仍需在确认时重新核对。
            </Notice>
          )}
          <ErrorNotice
            error={
              pnl.error ??
              rights.error ??
              pending.error ??
              marketQueries.find((q) => q.error)?.error
            }
            retry={() => {
              void rights.refetch();
              void pnl.refetch();
              for (const query of marketQueries) void query.refetch();
              void pending.refetch();
            }}
          />
          {rights.isPending && <Loading />}
          {marketsPending && <Loading label="正在读取市场名称与结算状态" />}
          {!rights.isPending &&
            !rights.error &&
            !marketsPending &&
            visibleItems.length === 0 &&
            !rights.hasNextPage && (
              <Empty title="暂无待处理权益">
                已领取或已处理的项目不再显示。
                <Link to={`/${api.environment.id}/history`}>查看交易历史</Link>
              </Empty>
            )}
          {visibleItems.length === 0 && rights.hasNextPage && !rights.error && (
            <Loading label="正在查找待处理权益" />
          )}
          {visibleItems.length > 0 && (
            <DataTable
              headers={[
                "权益 / 市场",
                "持有结果",
                "份额",
                "可领取测试资产",
                "状态",
                "操作",
              ]}
            >
              {visibleItems.map(({ item: e, snapshot: rowSnapshot }) => {
                const pendingTimeoutFunding =
                  e.kind === "bond" &&
                  e.reason === "bond_slashed_pending_timeout_funding";
                const timeoutFunded =
                  e.kind === "bond" &&
                  e.reason === "bond_slashed_into_timeout_pool";
                const waitingForRefund =
                  e.kind === "timeout-bonus" &&
                  (e.reason === "refund_before_timeout_compensation" ||
                    e.reason ===
                      "refund_and_funding_before_timeout_compensation");
                const waitingForFunding =
                  e.kind === "timeout-bonus" &&
                  (e.reason === "waiting_for_timeout_bond_funding" ||
                    e.reason ===
                      "refund_and_funding_before_timeout_compensation");
                const intent = entitlementIntent(e);
                const progress =
                  pendingTimeoutFunding || timeoutFunded
                    ? null
                    : entitlementProgress(e, operations, rowSnapshot);
                return (
                  <tr key={e.id}>
                    <td>
                      <strong>
                        {e.market ? (
                          <Link
                            to={`/${api.environment.id}/markets/${e.market}`}
                            title={e.market}
                          >
                            {marketLabel(e.market)}
                          </Link>
                        ) : (
                          "跨市场汇总余额"
                        )}
                      </strong>
                      <div className="small muted">{rightLabels[e.kind]}</div>
                      {e.reason && reasons[e.reason] && (
                        <p className="small">{reasons[e.reason]}</p>
                      )}
                    </td>
                    <td>
                      <HoldingOutcome
                        market={e.market ? marketFor(e.market) : undefined}
                        outcomeId={e.outcomeId}
                      />
                    </td>
                    <td>
                      <Amount value={e.units} />
                    </td>
                    <td>
                      {waitingForFunding ? (
                        <span className="muted">待补偿池注入</span>
                      ) : (
                        <>
                          <Amount
                            value={e.amount}
                            asset={api.environment.asset}
                          />
                          {waitingForRefund && (
                            <div className="small muted">预计补偿</div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${e.status === "claimable" && !pendingTimeoutFunding ? "badge-blue" : ""}`}
                      >
                        {progress?.phase === "syncing"
                          ? "已确认，等待同步"
                          : progress
                            ? progress.operation.state === "unknown"
                              ? "结果待核对"
                              : states.executing
                            : pendingTimeoutFunding
                              ? "已罚没，待注入"
                              : timeoutFunded
                                ? "已罚没并注入"
                                : waitingForRefund
                                  ? "待领取本金"
                                  : states[e.status]}
                      </span>
                    </td>
                    <td>
                      {progress ? (
                        <div className="stack">
                          <Button variant="secondary" disabled>
                            {progress.phase === "syncing"
                              ? "等待同步"
                              : "核对原操作中"}
                          </Button>
                          <Link
                            to={`/${api.environment.id}/history?operation=${progress.operation.id}`}
                          >
                            查询原操作
                          </Link>
                        </div>
                      ) : intent ? (
                        <Button
                          variant="secondary"
                          disabled={!pending.isSuccess}
                          onClick={() =>
                            request({
                              intent,
                              summary: [
                                { label: "权益", value: rightLabels[e.kind] },
                                {
                                  label: "归属",
                                  value: e.market
                                    ? marketLabel(e.market)
                                    : "跨市场汇总余额",
                                },
                              ],
                              feeNote:
                                e.kind === "escrow"
                                  ? "仅取回托管份额，不实现盈亏。网络 Gas 可选择项目代付或自行支付 ETH。"
                                  : e.kind === "bond" && e.market
                                    ? e.reason === "settle_and_claim_bond"
                                      ? "本次将结算并领取押金，确认后一次到账。"
                                      : "本次将押金结算至汇总可领取余额；超时弃盘且有参与者时，押金将进入补偿池。"
                                    : "实际到账以链上交易为准；已含费用不会重复扣除。网络 Gas 可选择项目代付或自行支付 ETH。",
                            })
                          }
                        >
                          {!pending.isSuccess
                            ? pending.error
                              ? "暂不可领取"
                              : "正在核对操作"
                            : e.kind === "escrow"
                              ? "取回份额"
                              : e.kind === "bond" && e.market
                                ? e.reason === "settle_and_claim_bond"
                                  ? "领取押金"
                                  : "结算押金"
                                : "领取"}
                        </Button>
                      ) : e.kind === "holding" && e.market ? (
                        <Link to={`/${api.environment.id}/markets/${e.market}`}>
                          查看市场
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
          {rights.hasNextPage && (
            <Button
              variant="secondary"
              disabled={rights.isFetchingNextPage}
              onClick={() => void rights.fetchNextPage()}
            >
              加载更多权益
            </Button>
          )}
          {pnl.data && visibleLots.length > 0 && (
            <section className="card stack">
              <h2>持仓成本明细</h2>
              <Notice>
                采用移动加权平均成本。托管份额仍属于卖家，未领取权益和估算收益不计入已实现收益。
              </Notice>
              <DataTable
                headers={[
                  "市场",
                  "持有结果",
                  "全部份额",
                  "其中托管",
                  "已知成本",
                  "成本完整性",
                ]}
              >
                {visibleLots.map((lot) => (
                  <tr key={`${lot.market}:${lot.outcomeId}`}>
                    <td>
                      <Link
                        to={`/${api.environment.id}/markets/${lot.market}`}
                        title={lot.market}
                      >
                        {marketLabel(lot.market)}
                      </Link>
                    </td>
                    <td>
                      <HoldingOutcome
                        market={marketFor(lot.market)}
                        outcomeId={lot.outcomeId}
                      />
                    </td>
                    <td>
                      <Amount value={lot.units} />
                    </td>
                    <td>
                      <Amount value={lot.escrowUnits} />
                    </td>
                    <td>
                      <Amount
                        value={lot.knownCost}
                        asset={api.environment.asset}
                      />
                    </td>
                    <td>{lot.costComplete ? "完整" : "存在未知取得成本"}</td>
                  </tr>
                ))}
              </DataTable>
            </section>
          )}
        </>
      )}
    </>
  );
}

function HoldingOutcome({
  market,
  outcomeId,
}: {
  market: Market | undefined;
  outcomeId: string | null;
}) {
  const rules = useRules(outcomeId === null ? undefined : market);
  if (outcomeId === null) return <>—</>;
  const label = rules.data?.outcomes.find(
    (_, index) => String(index) === outcomeId,
  );
  return (
    <span title={`结果编号 ${outcomeId}`}>
      {label ??
        `结果 #${outcomeId}（名称${rules.isFetching ? "读取中" : "暂不可用"}）`}
    </span>
  );
}
