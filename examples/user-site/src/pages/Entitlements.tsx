import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { z } from "zod";
import {
  entitlementsResponseSchema,
  pnlResponseSchema,
  type Entitlement,
} from "../../../../offchain/app-core/src/ledger-contracts.js";
import {
  operationSchema,
  type BusinessIntent,
} from "../../../../offchain/app-core/src/contracts.js";
import { useSession } from "../wallets.js";
import { AccountGate, useOperation } from "../operations.js";
import {
  AddressText,
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
  credited_to_aggregate_balance: "已记入押金可领取余额；在汇总余额中领取到账。",
  bond_slashed_into_timeout_pool: "押金已罚没并注入超时补偿池。",
  settle_bond_before_claiming_credit: "先结算押金，再领取汇总余额。",
  chain_read_unavailable: "链上查询暂不可用，请重新查询。",
  cancel_listing_to_recover_shares: "撤单取回未成交份额，不产生已实现收益。",
  return_terminal_listing: "市场已终局，先取回托管份额再领取权益。",
};
export function entitlementIntent(e: Entitlement): BusinessIntent | null {
  if (e.status !== "claimable") return null;
  if (e.kind === "escrow" && e.listingId)
    return {
      kind:
        e.reason === "return_terminal_listing"
          ? "return-listing"
          : "cancel-listing",
      listingId: e.listingId,
    };
  if (e.kind === "bond")
    return e.market
      ? { kind: "settle-bond", market: e.market }
      : { kind: "claim-bond" };
  if (e.kind === "fees") return { kind: "claim-fees" };
  if (!e.market) return null;
  if (e.kind === "winner") return { kind: "claim-winner", market: e.market };
  if (e.kind === "early-bird")
    return { kind: "claim-early-bird", market: e.market };
  if (e.kind === "refund") return { kind: "refund", market: e.market };
  if (e.kind === "timeout-bonus")
    return { kind: "claim-timeout-bonus", market: e.market };
  return null;
}
export function EntitlementsPage() {
  const { api, account } = useSession(),
    request = useOperation();
  const pnl = useQuery({
    queryKey: [api.key, "pnl", account?.address],
    enabled: !!account,
    queryFn: ({ signal }) =>
      api.request(`/v2/pnl/${account!.address}`, pnlResponseSchema, {
        service: "indexer",
        signal,
      }),
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
  });
  const snapshot = rights.data?.pages[0]?.snapshot,
    items = rights.data?.pages.flatMap((p) => p.items) ?? [];
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
  });
  return (
    <>
      <PageTitle
        title="持仓与权益"
        description="持仓、托管份额与原始购买产生的权益分别记录。领取后以实际到账核算收益。"
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
            error={pnl.error ?? rights.error}
            retry={() => {
              void rights.refetch();
              void pnl.refetch();
            }}
          />
          {rights.isPending && <Loading />}
          {!rights.isPending && !rights.error && items.length === 0 && (
            <Empty title="还没有发现权益">
              首次交易后，普通持仓和其他权益会在链上确认并完成索引后显示。
            </Empty>
          )}
          {items.length > 0 && (
            <DataTable
              headers={[
                "权益 / 市场",
                "份额",
                "可领取测试资产",
                "状态",
                "操作",
              ]}
            >
              {items.map((e) => {
                const intent = entitlementIntent(e);
                const executing =
                  intent &&
                  pending.data?.items.some(
                    (o) =>
                      [
                        "preparing",
                        "awaiting-signature",
                        "submitted",
                        "confirming",
                        "unknown",
                      ].includes(o.state) &&
                      o.intent.kind === intent.kind &&
                      ("market" in intent
                        ? "market" in o.intent &&
                          o.intent.market.toLowerCase() ===
                            intent.market.toLowerCase()
                        : "listingId" in intent
                          ? "listingId" in o.intent &&
                            o.intent.listingId === intent.listingId
                          : true),
                  );
                return (
                  <tr key={e.id}>
                    <td>
                      <strong>{rightLabels[e.kind]}</strong>
                      <div className="small muted">
                        {e.market ? (
                          <Link
                            to={`/${api.environment.id}/markets/${e.market}`}
                          >
                            {shortAddress(e.market)}
                          </Link>
                        ) : (
                          "跨市场汇总余额"
                        )}
                      </div>
                      {e.reason && reasons[e.reason] && (
                        <p className="small">{reasons[e.reason]}</p>
                      )}
                    </td>
                    <td>
                      <Amount value={e.units} />
                    </td>
                    <td>
                      <Amount value={e.amount} asset={api.environment.asset} />
                    </td>
                    <td>
                      <span
                        className={`badge ${e.status === "claimable" ? "badge-blue" : ""}`}
                      >
                        {executing ? states.executing : states[e.status]}
                      </span>
                    </td>
                    <td>
                      {executing ? (
                        <Link to={`/${api.environment.id}/history`}>
                          查询原操作
                        </Link>
                      ) : intent ? (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            request({
                              intent,
                              summary: [
                                { label: "权益", value: rightLabels[e.kind] },
                                {
                                  label: "归属",
                                  value: e.market ?? "跨市场汇总余额",
                                },
                              ],
                              feeNote:
                                e.kind === "escrow"
                                  ? "仅取回托管份额，不实现盈亏。网络 Gas 可选择项目代付或自行支付 ETH。"
                                  : e.kind === "bond" && e.market
                                    ? "本次将押金结算至汇总可领取余额，实际到账需再领取余额。"
                                    : "实际到账以链上交易为准；已含费用不会重复扣除。网络 Gas 可选择项目代付或自行支付 ETH。",
                            })
                          }
                        >
                          {e.kind === "escrow"
                            ? "取回份额"
                            : e.kind === "bond" && e.market
                              ? "结算押金"
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
          {pnl.data && pnl.data.pnl.lots.length > 0 && (
            <section className="card stack">
              <h2>持仓成本明细</h2>
              <Notice>
                采用移动加权平均成本。托管份额仍属于卖家，未领取权益和估算收益不计入已实现收益。
              </Notice>
              <DataTable
                headers={[
                  "市场 / 结果编号",
                  "全部份额",
                  "其中托管",
                  "已知成本",
                  "成本完整性",
                ]}
              >
                {pnl.data.pnl.lots.map((lot) => (
                  <tr key={`${lot.market}:${lot.outcomeId}`}>
                    <td>
                      <Link to={`/${api.environment.id}/markets/${lot.market}`}>
                        {lot.market.slice(0, 10)}… / {lot.outcomeId}
                      </Link>
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
