import { orderbookAbi } from "../../../../offchain/sdk/src/orderbook.js";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { formatEther, zeroAddress, type Address, type Hex } from "viem";
import {
  isRecoverable,
  operationSchema,
  AppError,
  type Operation,
} from "../../../../offchain/app-core/src/contracts.js";
import {
  factsPageSchema,
  factKind,
  pnlFactResponseSchema,
  type LedgerFact,
} from "../../../../offchain/app-core/src/ledger-contracts.js";
import { useSession } from "../wallets.js";
import {
  AccountGate,
  operationLabels,
  operationStateCopy,
} from "../operations.js";
import {
  AddressText,
  Amount,
  Button,
  DataTable,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Notice,
  PaginationControls,
  PageTitle,
  shortAddress,
} from "../ui.js";
import { usePaginatedList } from "../pagination.js";
import { dateText, marketSchema, useRules } from "../data.js";
import {
  listingTotal,
  operationBusinessFacts,
  businessFactKinds,
} from "../history-details.js";
import { marketplaceAbi } from "../../../../offchain/sdk/src/abis.js";
import { DepositHistory } from "../DepositHistory.js";
const labels: Record<LedgerFact["kind"], string> = {
  "market-created": "创建市场",
  "market-initialized": "市场初始化",
  "market-metadata": "发布规则",
  "economic-snapshot": "费率快照",
  "primary-buy": "一级购买",
  "order-created": "创建买卖单",
  "order-released": "释放订单资产",
  "order-shares-deferred": "挂单份额暂存待取回",
  "order-funds-returned": "求购余款退回",
  "listing-created": "创建挂单",
  "listing-filled": "挂单成交",
  "listing-cancelled": "撤销挂单",
  "listing-returned": "返还托管份额",
  "market-resolved": "市场结算",
  "market-voided": "市场作废",
  "winner-claimed": "赢家到账",
  "early-bird-claimed": "早鸟到账",
  refunded: "退款到账",
  "timeout-funded": "超时资金入池",
  "timeout-claimed": "超时补偿到账",
  "losing-burned": "清理败方份额",
  "remainder-assigned": "尾差分配",
  "share-transfer": "份额转移",
  "payment-transfer": "支付资产流转",
  "bond-locked": "押金锁定",
  "bond-credited": "押金记入余额",
  "bond-timeout-funded": "押金罚没入池",
  "bond-claimed": "押金余额到账",
  "fee-accrued": "费用产生",
  "fee-claimed": "费用余额到账",
  "user-operation": "智能账户执行",
  "coverage-gap": "数据缺口",
};
const operationsPage = z.object({
  items: z.array(operationSchema),
  nextCursor: z.string().nullable(),
});
export function HistoryPage() {
  const { api, account, identityKey } = useSession(),
    [params, setParams] = useSearchParams(),
    [type, setType] = useState(""),
    [market, setMarket] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [filters, setFilters] = useState("");
  const [selectedFact, setSelectedFact] = useState<LedgerFact | null>(null),
    [filterError, setFilterError] = useState("");
  const previousAccount = useRef(account?.id);
  useEffect(() => {
    setSelectedFact(null);
    if (previousAccount.current && previousAccount.current !== account?.id)
      setParams({});
    previousAccount.current = account?.id;
  }, [account?.id, setParams]);
  const rows = useInfiniteQuery({
    queryKey: [api.key, "activity", account?.address, filters],
    enabled: !!account,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v2/activity/${account!.address}?limit=20&${filters}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        factsPageSchema,
        { service: "indexer", signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const operations = useInfiniteQuery({
    queryKey: [api.key, "operations", identityKey, account?.id],
    enabled: !!account,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v1/operations?accountId=${account!.id}&limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        operationsPage,
        { auth: true, signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15000,
  });
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [],
    attempts = operations.data?.pages.flatMap((p) => p.items) ?? [];
  const operationPagination = usePaginatedList({
    pages: operations.data?.pages.map((page) => page.items) ?? [],
    pageSize: 10,
    scope: `${api.key}:${identityKey}:${account?.id ?? "signed-out"}`,
    hasMore: !!operations.hasNextPage,
    isLoadingMore: operations.isFetchingNextPage,
    loadMore: operations.fetchNextPage,
  });
  const historyPagination = usePaginatedList({
    pages: rows.data?.pages.map((page) => page.items) ?? [],
    pageSize: 10,
    scope: `${api.key}:${account?.address ?? "signed-out"}:${filters}`,
    hasMore: !!rows.hasNextPage,
    isLoadingMore: rows.isFetchingNextPage,
    loadMore: rows.fetchNextPage,
  });
  const cost = useQuery({
    queryKey: [
      api.key,
      "fact-pnl",
      account?.address,
      selectedFact?.id,
      rows.data?.pages[0]?.snapshot.epoch,
    ],
    enabled: !!account && !!selectedFact,
    queryFn: async ({ signal }) => {
      const result = await api.request(
        `/v2/pnl/${account!.address}/facts/${encodeURIComponent(selectedFact!.id)}`,
        pnlFactResponseSchema,
        { service: "indexer", signal },
      );
      if (result.snapshot.epoch !== rows.data?.pages[0]?.snapshot.epoch)
        throw new AppError("snapshot_invalidated", 409);
      return result;
    },
    retry: false,
  });
  const apply = () => {
    const q = new URLSearchParams();
    if (type) q.set("kind", type);
    if (market.trim()) {
      if (/^0x[0-9a-fA-F]{40}$/.test(market.trim()))
        q.set("market", market.trim());
      else q.set("marketQuery", market.trim());
    }
    const start = from ? Date.parse(`${from}T00:00:00+08:00`) : null,
      end = to ? Date.parse(`${to}T00:00:00+08:00`) : null;
    if (start !== null && end !== null && start >= end) {
      setFilterError("结束日期必须晚于开始日期，结束当天不计入。");
      return;
    }
    if (start !== null) q.set("from", String(start / 1000));
    if (end !== null) q.set("to", String(end / 1000));
    setFilterError("");
    setFilters(q.toString());
  };
  return (
    <>
      <PageTitle
        title="交易历史"
        description="链上历史与操作进度分别展示。结果未知的操作仅继续查询，不自动重新发送。"
      />
      <AccountGate />
      {account && api.environment.asset === "USDC" && <DepositHistory />}
      {account && (
        <>
          <section className="card stack history-operations">
            <h2>操作进度</h2>
            <ErrorNotice
              error={operations.error}
              retry={() => void operations.refetch()}
            />
            {operations.isPending && <Loading />}
            {!operations.isPending &&
              !operations.error &&
              attempts.length === 0 && (
                <p className="muted">此应用账户还没有登记操作。</p>
              )}
            {attempts.length > 0 && (
              <DataTable
                headers={[
                  "操作",
                  "市场 / 申请明细",
                  "登记时间",
                  "状态",
                  "详情",
                ]}
              >
                {operationPagination.items.map((o) => (
                  <tr key={o.id}>
                    <td>{operationLabels[o.kind]}</td>
                    <td>
                      {"market" in o.intent ? (
                        <HistoryMarket market={o.intent.market} />
                      ) : (
                        <ListingOperationMarket operation={o} />
                      )}
                      <IntentSummary operation={o} />
                    </td>
                    <td>
                      {new Date(o.createdAt).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                      })}
                    </td>
                    <td>{operationStateCopy[o.state]}</td>
                    <td>
                      <Button
                        variant="quiet"
                        onClick={() => setParams({ operation: o.id })}
                      >
                        查询原操作
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            <PaginationControls
              ariaLabel="操作进度分页"
              page={operationPagination.page}
              hasPrevious={operationPagination.hasPrevious}
              hasNext={operationPagination.hasNext}
              busy={operationPagination.isLoading}
              onPrevious={operationPagination.previous}
              onNext={() => void operationPagination.next()}
            />
          </section>
          <section className="stack">
            <h2>已确认链上历史</h2>
            <form
              className="filter-form"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <Field label="类型">
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">全部类型</option>
                  {factKind.options.map((k) => (
                    <option key={k} value={k}>
                      {labels[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="市场名称或地址">
                <input
                  value={market}
                  onChange={(e) => setMarket(e.target.value)}
                  placeholder="输入市场名称或完整地址"
                  maxLength={200}
                />
              </Field>
              <Field label="开始日期（上海）">
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="结束日期（不含）">
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
              <Button type="submit">筛选</Button>
            </form>
            {filterError && <p role="alert">{filterError}</p>}
            <ErrorNotice error={rows.error} retry={() => void rows.refetch()} />
            {rows.isPending && <Loading />}
            {!rows.isPending && !rows.error && items.length === 0 && (
              <Empty title="此范围内还没有记录">
                链上确认后的数据需等待索引完成。可在上方查询已登记操作。
              </Empty>
            )}
            {items.length > 0 && (
              <>
                <p className="small muted">
                  快照区块 {rows.data?.pages[0]?.snapshot.blockNumber} ·
                  同一交易的业务事件与资产流转关联展示，金额不能直接相加为成本。
                </p>
                <DataTable
                  headers={[
                    "事件",
                    "时间（上海）",
                    "市场",
                    "结果选项",
                    "份数",
                    "金额 / 挂单总额",
                    "详情",
                  ]}
                >
                  {historyPagination.items.map((f) => (
                    <tr key={f.id}>
                      <td>{labels[f.kind]}</td>
                      <td>{dateText(f.timestamp)}</td>
                      <td>
                        {f.market ? (
                          <HistoryMarket market={f.market} />
                        ) : (
                          "跨市场 / 账户"
                        )}
                      </td>
                      <td>
                        <HistoryOutcome
                          market={f.market}
                          outcomeId={f.outcomeId}
                        />
                      </td>
                      <td>
                        <Amount value={f.units} />
                      </td>
                      <td>
                        <FactAmount fact={f} />
                        {f.kind === "listing-created" && (
                          <div className="small muted">
                            挂单总额，尚非成交收入
                          </div>
                        )}
                        {(f.kind === "listing-cancelled" ||
                          f.kind === "listing-returned") && (
                          <div className="small muted">
                            {f.kind === "listing-cancelled" ? "撤销" : "取回"}
                            部分的挂单总额，非资金到账
                          </div>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="quiet"
                          onClick={() => setSelectedFact(f)}
                        >
                          查看
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </>
            )}
            <PaginationControls
              ariaLabel="链上历史分页"
              page={historyPagination.page}
              hasPrevious={historyPagination.hasPrevious}
              hasNext={historyPagination.hasNext}
              busy={historyPagination.isLoading}
              onPrevious={historyPagination.previous}
              onNext={() => void historyPagination.next()}
            />
          </section>
          <OperationDetail
            id={params.get("operation")}
            close={() => setParams({})}
          />
          <Modal
            open={selectedFact !== null}
            onOpenChange={(v) => {
              if (!v) setSelectedFact(null);
            }}
            title={selectedFact ? labels[selectedFact.kind] : "链上事件"}
            description="原始事件与业务事实可通过交易哈希核对。"
          >
            {selectedFact && (
              <div className="stack">
                <dl className="data-list">
                  <dt>市场</dt>
                  <dd>
                    {selectedFact.market ? (
                      <div className="stack">
                        <HistoryMarket market={selectedFact.market} />
                        <AddressText value={selectedFact.market} />
                      </div>
                    ) : (
                      "跨市场汇总 / 账户流转"
                    )}
                  </dd>
                  <dt>事件编号</dt>
                  <dd className="break-all">{selectedFact.id}</dd>
                  <FactFields fact={selectedFact} />
                  <dt>区块</dt>
                  <dd>{selectedFact.blockNumber}</dd>
                </dl>
                <ErrorNotice error={cost.error} />
                {cost.isFetching && <Loading label="正在核对本次成本与收益" />}
                {cost.data?.items.map((entry, index) => (
                  <section className="stack" key={`${entry.factId}:${index}`}>
                    <h3>
                      本次交易损益
                      {entry.outcomeId !== null
                        ? ` · 结果 ${entry.outcomeId}`
                        : ""}
                    </h3>
                    <dl className="data-list">
                      <dt>实际净到账</dt>
                      <dd>
                        <Amount
                          value={entry.proceeds}
                          asset={api.environment.asset}
                        />
                      </dd>
                      <dt>分摊持仓成本</dt>
                      <dd>
                        <Amount
                          value={entry.complete ? entry.allocatedCost : null}
                          asset={api.environment.asset}
                        />
                      </dd>
                      <dt>已实现净收益</dt>
                      <dd>
                        <Amount
                          value={entry.amount}
                          asset={api.environment.asset}
                          sign
                        />
                      </dd>
                    </dl>
                    {!entry.complete && (
                      <Notice tone="warning">
                        取得成本或历史不完整，本次不能提供完整收益结论。
                      </Notice>
                    )}
                  </section>
                ))}
                {cost.data?.items.length === 0 && (
                  <Notice>
                    此事件没有单独实现交易损益。买入支付增加成本；托管、充值、转出及创作者费用按各自口径记录。
                  </Notice>
                )}
                <a
                  href={`${api.environment.explorerUrl}/tx/${selectedFact.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看链上交易
                </a>
                <details>
                  <summary>事件细节</summary>
                  <pre>{JSON.stringify(selectedFact.extra, null, 2)}</pre>
                </details>
              </div>
            )}
          </Modal>
        </>
      )}
    </>
  );
}
function OperationDetail({
  id,
  close,
}: {
  id: string | null;
  close: () => void;
}) {
  const { api, account, identityKey } = useSession(),
    cache = useQueryClient(),
    [error, setError] = useState<unknown>(null);
  const valid = z.string().uuid().safeParse(id),
    query = useQuery({
      queryKey: [api.key, "operation", identityKey, account?.id, id],
      enabled: valid.success && !!account,
      queryFn: ({ signal }) =>
        api.request(
          `/v1/operations/${id}`,
          z.object({
            operation: operationSchema,
            recovery: z.string().optional(),
          }),
          { auth: true, signal },
        ),
      refetchInterval: (q) =>
        q.state.data && isRecoverable(q.state.data.operation.state)
          ? 5000
          : false,
      retry: 1,
    });
  const o = query.data?.operation,
    scoped = o?.accountId === account?.id ? o : undefined;
  const cancel = async (operation: Operation) => {
    try {
      await api.request(
        `/v1/operations/${operation.id}/cancel`,
        z.object({ operation: operationSchema }),
        { auth: true, body: {} },
      );
      await cache.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === api.key &&
          String(q.queryKey[1]).startsWith("operation"),
      });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal
      open={id !== null}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="原操作记录"
      description="操作已登记后，只查询已保存的 UserOperation 和链上交易。"
      footer={<Button onClick={close}>关闭</Button>}
    >
      {!valid.success ? (
        <Notice tone="warning">操作编号无效。</Notice>
      ) : query.isPending ? (
        <Loading />
      ) : null}
      <ErrorNotice
        error={error ?? query.error}
        retry={() => void query.refetch()}
      />
      {o && !scoped && (
        <Notice tone="warning">
          此记录属于其他应用账户，请先切换至该账户。
        </Notice>
      )}
      {scoped && (
        <div className="stack">
          <Notice tone={scoped.state === "confirmed" ? "success" : "info"}>
            {operationLabels[scoped.kind]} · {operationStateCopy[scoped.state]}
          </Notice>
          {query.data?.recovery === "unavailable" && (
            <Notice tone="warning">
              恢复查询服务暂不可用，保留上次已知状态。
            </Notice>
          )}
          <OperationBusinessDetails operation={scoped} />
          <dl className="data-list">
            <dt>业务操作 ID</dt>
            <dd className="break-all">{scoped.id}</dd>
            <dt>应用账户</dt>
            <dd>
              <AddressText value={scoped.account} />
            </dd>
            <dt>环境</dt>
            <dd>{scoped.environment}</dd>
            {scoped.intent.kind === "deposit-usdc" && (
              <>
                <dt>入金记录</dt>
                <dd className="break-all">{scoped.intent.depositId}</dd>
                <dt>资金来源</dt>
                <dd>
                  <AddressText value={scoped.intent.authorization.from} />
                </dd>
                <dt>入金金额</dt>
                <dd>
                  <Amount
                    value={scoped.intent.authorization.value}
                    asset="USDC"
                  />
                </dd>
              </>
            )}
            <dt>确认程度</dt>
            <dd>
              {scoped.finality === "finalized"
                ? "链已最终确认"
                : scoped.finality === "application-confirmed"
                  ? "已达到应用确认数"
                  : "等待链上确认"}
            </dd>
            <dt>Gas 支付方式</dt>
            <dd>
              {scoped.gasPayment === "self-funded"
                ? "智能账户自行支付 ETH"
                : "项目代付"}
            </dd>
            <dt>实际 Gas 成本（ETH）</dt>
            <dd>
              {scoped.actualGasCost === null
                ? "等待回执"
                : formatEther(BigInt(scoped.actualGasCost)) + " ETH"}
            </dd>
          </dl>
          <details>
            <summary>交易标识与调用详情</summary>
            <pre>
              {JSON.stringify(
                {
                  providerOperationId: scoped.providerOperationId,
                  userOperationHash: scoped.userOperationHash,
                  transactionHash: scoped.transactionHash,
                  nonce: scoped.nonce,
                  calls:
                    scoped.intent.kind === "deposit-usdc"
                      ? scoped.calls.map((c) => ({
                          to: c.to,
                          value: c.value,
                          method: "receiveWithAuthorization",
                        }))
                      : scoped.calls,
                  reason: scoped.reason,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {scoped.transactionHash && (
            <a
              href={`${api.environment.explorerUrl}/tx/${scoped.transactionHash}`}
              target="_blank"
              rel="noreferrer"
            >
              查看链上交易
            </a>
          )}
          {scoped.state === "awaiting-signature" && (
            <Button variant="secondary" onClick={() => void cancel(scoped)}>
              取消尚未提交的操作
            </Button>
          )}
          {isRecoverable(scoped.state) && (
            <Notice tone="warning">
              正在继续查询此操作。不要为了重试而重复付款。
            </Notice>
          )}
          {scoped.state === "reverted" && scoped.kind === "create-market" && (
            <Notice tone="warning">
              本次创建已在链上回滚，没有生成市场，因此不会出现在市场列表或创作者中心。请检查创建参数；封盘时间须给签名和上链留出余量，再发起新的创建。
            </Notice>
          )}
          {scoped.state === "confirmed" && (
            <Notice>
              交易已经确认。若余额或权益尚未更新，请等待索引同步，交易结果不受页面刷新影响。
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
}

function useHistoryMarket(market: Address | null | undefined) {
  const { api } = useSession();
  return useQuery({
    queryKey: [api.key, "market", market],
    enabled: !!market,
    queryFn: ({ signal }) =>
      api.request(`/v2/markets/${market}`, marketSchema, {
        service: "indexer",
        signal,
      }),
    staleTime: 30000,
    refetchInterval: (q) => (q.state.data?.question?.trim() ? false : 30000),
    retry: 1,
  });
}
function HistoryMarket({ market }: { market: Address }) {
  const { api } = useSession();
  const query = useHistoryMarket(market);
  return (
    <Link to={`/${api.environment.id}/markets/${market}`} title={market}>
      {query.data?.question?.trim() ||
        (query.isPending
          ? "正在读取市场名称"
          : `后台核验中（${shortAddress(market)}）`)}
    </Link>
  );
}
function HistoryOutcome({
  market,
  outcomeId,
}: {
  market: Address | null;
  outcomeId: string | null;
}) {
  const query = useHistoryMarket(outcomeId === null ? null : market);
  const rules = useRules(query.data);
  if (outcomeId === null) return <>—</>;
  const label = rules.data?.outcomes[Number(outcomeId)];
  return <>{label || `选项 #${outcomeId}（名称待核验）`}</>;
}
function useHistoryListing(id: Hex | undefined) {
  const { api } = useSession();
  return useQuery({
    queryKey: [api.key, "history-listing", id],
    enabled: !!id,
    queryFn: async () => {
      if (api.environment.deployment.marketplaceVersion === "orderbook-v2") {
        const o = await api.publicClient().readContract({
          address: api.environment.deployment.marketplace,
          abi: orderbookAbi,
          functionName: "orders",
          args: [BigInt(id!)],
        });
        if (o[0] === zeroAddress) throw new AppError("order_not_found", 404);
        return {
          market: o[0],
          outcomeId: String(o[5]),
          unitPrice: o[3].toString(),
        };
      }
      const row = await api.publicClient().readContract({
        address: api.environment.deployment.marketplace,
        abi: marketplaceAbi,
        functionName: "listings",
        args: [id!],
      });
      if (row[0] === zeroAddress) throw new AppError("listing_not_found", 404);
      // These listing identity/price fields never change after creation, even after closure.
      return {
        market: row[0],
        outcomeId: String(row[5]),
        unitPrice: row[3].toString(),
      };
    },
    staleTime: Infinity,
    retry: 1,
  });
}
function ListingOperationMarket({ operation: o }: { operation: Operation }) {
  const listing = useHistoryListing(
    "listingId" in o.intent
      ? o.intent.listingId
      : "orderId" in o.intent
        ? (`0x${BigInt(o.intent.orderId).toString(16).padStart(64, "0")}` as Hex)
        : undefined,
  );
  if (!("listingId" in o.intent) && !("orderId" in o.intent))
    return <>跨市场 / 账户</>;
  return listing.data ? (
    <HistoryMarket market={listing.data.market} />
  ) : (
    <>
      挂单{" "}
      {"listingId" in o.intent
        ? shortAddress(o.intent.listingId)
        : o.intent.orderId}
      {listing.isPending ? " · 正在读取" : " · 明细暂未取得"}
    </>
  );
}
function IntentSummary({ operation: o }: { operation: Operation }) {
  const { api } = useSession(),
    intent = o.intent;
  const listing = useHistoryListing(
    "listingId" in intent
      ? intent.listingId
      : "orderId" in intent
        ? (`0x${BigInt(intent.orderId).toString(16).padStart(64, "0")}` as Hex)
        : undefined,
  );
  if (
    intent.kind === "create-order" ||
    intent.kind === "fill-order" ||
    intent.kind === "cancel-order" ||
    intent.kind === "release-order" ||
    intent.kind === "withdraw-order-shares"
  ) {
    const market =
        intent.kind === "create-order" ? intent.market : listing.data?.market,
      choice =
        intent.kind === "create-order"
          ? intent.outcomeId
          : listing.data?.outcomeId,
      price =
        intent.kind === "create-order"
          ? intent.unitPrice
          : listing.data?.unitPrice;
    return (
      <div className="small muted">
        结果选项：
        {market && choice !== undefined ? (
          <HistoryOutcome market={market} outcomeId={choice} />
        ) : (
          "待核对"
        )}{" "}
        ·{" "}
        {"units" in intent && (
          <>
            份数 <Amount value={intent.units} /> ·{" "}
          </>
        )}
        每份 <Amount value={price ?? null} asset={api.environment.asset} />
        {"units" in intent && (
          <>
            {" "}
            · 总额（未扣手续费）
            <Amount
              value={listingTotal(intent.units, price)}
              asset={api.environment.asset}
            />
          </>
        )}
        {intent.kind === "create-order" && (
          <>
            {" "}
            · {intent.side === "bid" ? "求购" : "挂卖"} ·{" "}
            {intent.autoMatch ? "自动撮合" : "仅主动接单"}
          </>
        )}
      </div>
    );
  }
  if (intent.kind === "buy")
    return (
      <div className="small muted">
        结果选项：
        <HistoryOutcome market={intent.market} outcomeId={intent.outcomeId} /> ·
        申请购买 <Amount value={intent.units} /> 份
      </div>
    );
  if (intent.kind === "create-listing" || intent.kind === "fill-listing") {
    const creating = intent.kind === "create-listing";
    const market = creating ? intent.market : listing.data?.market;
    const outcome = creating ? intent.outcomeId : listing.data?.outcomeId;
    const price = creating ? intent.unitPrice : listing.data?.unitPrice;
    return (
      <div className="small muted">
        结果选项：
        {market && outcome !== undefined ? (
          <HistoryOutcome market={market} outcomeId={outcome} />
        ) : (
          "待核对"
        )}{" "}
        ·{creating ? "挂单" : "申请购买"} <Amount value={intent.units} /> 份 ·
        每份 <Amount value={price ?? null} asset={api.environment.asset} /> ·
        {creating
          ? "挂单总额（未扣成交手续费）"
          : "申请成交总额（未扣成交手续费）"}{" "}
        <Amount
          value={listingTotal(intent.units, price)}
          asset={api.environment.asset}
        />
      </div>
    );
  }
  if (intent.kind === "cancel-listing" || intent.kind === "return-listing")
    return (
      <div className="small muted">
        结果选项：
        {listing.data ? (
          <HistoryOutcome
            market={listing.data.market}
            outcomeId={listing.data.outcomeId}
          />
        ) : (
          "待核对"
        )}
        {" · "}每份{" "}
        <Amount
          value={listing.data?.unitPrice ?? null}
          asset={api.environment.asset}
        />
        {" · "}
        {intent.kind === "cancel-listing" ? "撤单" : "取回"}
        份数和总额以本次链上事件为准。
      </div>
    );
  return null;
}

function FactAmount({ fact }: { fact: LedgerFact }) {
  const { api } = useSession();
  const recovery =
    fact.kind === "listing-cancelled" || fact.kind === "listing-returned";
  const listing = useHistoryListing(
    recovery && fact.listingId ? fact.listingId : undefined,
  );
  if (fact.kind === "user-operation")
    return (
      <>
        {fact.amount === null
          ? "未知"
          : `${formatEther(BigInt(fact.amount))} ETH`}
      </>
    );
  return (
    <Amount
      value={
        fact.kind === "listing-created"
          ? listingTotal(fact.units, fact.extra.unitPrice)
          : recovery
            ? listingTotal(fact.units, listing.data?.unitPrice)
            : fact.amount
      }
      asset={api.environment.asset}
    />
  );
}

function FactFields({ fact }: { fact: LedgerFact }) {
  const { api } = useSession();
  const listing = fact.kind === "listing-created";
  const fill = fact.kind === "listing-filled";
  const cancelled = fact.kind === "listing-cancelled";
  const returned = fact.kind === "listing-returned";
  const recovery = cancelled || returned;
  const listingData = useHistoryListing(
    (fill || recovery) && fact.listingId ? fact.listingId : undefined,
  );
  return (
    <>
      {fact.outcomeId !== null && (
        <>
          <dt>结果选项</dt>
          <dd>
            <HistoryOutcome market={fact.market} outcomeId={fact.outcomeId} />
          </dd>
        </>
      )}
      <dt>
        {listing
          ? "挂单份数"
          : cancelled
            ? "撤单份数（实际取回）"
            : returned
              ? "终局挂单实际取回份数"
              : fill
                ? "实际成交份数"
                : fact.kind === "primary-buy"
                  ? "实际购买份数"
                  : "核销 / 变动份数"}
      </dt>
      <dd>
        <Amount value={fact.units} />
      </dd>
      {(listing || fill || recovery) && (
        <>
          <dt>挂单单价（每份）</dt>
          <dd>
            <Amount
              value={
                typeof fact.extra.unitPrice === "string" &&
                /^\d+$/.test(fact.extra.unitPrice)
                  ? fact.extra.unitPrice
                  : (listingData.data?.unitPrice ?? null)
              }
              asset={api.environment.asset}
            />
          </dd>
        </>
      )}
      <dt>
        {listing
          ? "挂单总额（未扣成交手续费）"
          : cancelled
            ? "撤销挂单总额（未扣成交手续费）"
            : returned
              ? "取回挂单总额（未扣成交手续费）"
              : fill
                ? "本次成交总额（未扣成交手续费）"
                : fact.kind === "primary-buy"
                  ? "实际购买金额"
                  : [
                        "winner-claimed",
                        "early-bird-claimed",
                        "refunded",
                        "timeout-claimed",
                      ].includes(fact.kind)
                    ? "实际领取金额"
                    : "金额"}
      </dt>
      <dd>
        <FactAmount fact={fact} />
      </dd>
      {recovery && (
        <>
          <dt>{cancelled ? "本次撤单成交手续费" : "本次取回成交手续费"}</dt>
          <dd>
            <Amount value="0" asset={api.environment.asset} />（
            {cancelled ? "撤单" : "取回托管份额"}不收取成交手续费）
          </dd>
          <dt>挂单编号</dt>
          <dd className="break-all">{fact.listingId}</dd>
          <dt>金额说明</dt>
          <dd>
            总额按本次实际取回份数 ×
            挂单单价计算，不是到账资金。已成交部分及其手续费不计入本次
            {cancelled ? "撤单" : "取回"}；网络 Gas 单独核算。
            {returned && "取回份额后，符合条件的收益、退款或补偿需另行领取。"}
          </dd>
        </>
      )}
      {fill && (
        <>
          {(
            [
              ["平台成交手续费", "platformFee"],
              ["创作者成交手续费", "creatorFee"],
              ["卖方实际到账", "sellerProceeds"],
            ] as const
          ).map(([label, key]) => (
            <Fragment key={key}>
              <dt>{label}</dt>
              <dd>
                <Amount
                  value={
                    typeof fact.extra[key] === "string" &&
                    /^\d+$/.test(fact.extra[key] as string)
                      ? (fact.extra[key] as string)
                      : null
                  }
                  asset={api.environment.asset}
                />
              </dd>
            </Fragment>
          ))}
        </>
      )}
    </>
  );
}

function OperationBusinessDetails({ operation: o }: { operation: Operation }) {
  const { api } = useSession();
  const supported = !!businessFactKinds[o.kind];
  const facts = useQuery({
    queryKey: [
      api.key,
      "operation-business-facts",
      o.accountId,
      o.id,
      o.transactionHash,
      o.userOperationHash,
    ],
    enabled:
      supported &&
      o.state === "confirmed" &&
      !!o.transactionHash &&
      !!o.userOperationHash,
    queryFn: async ({ signal }) => {
      const result: LedgerFact[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const q = new URLSearchParams({
          transactionHash: o.transactionHash!,
          limit: "100",
        });
        if (cursor) q.set("cursor", cursor);
        const page = await api.request(
          `/v2/activity/${o.account}?${q}`,
          factsPageSchema,
          { service: "indexer", signal },
        );
        if (
          page.items.some(
            (f) =>
              f.transactionHash.toLowerCase() !==
              o.transactionHash!.toLowerCase(),
          )
        )
          throw new AppError("history_transaction_filter_unavailable", 503);
        result.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new AppError("invalid_cursor", 409);
        if (cursor) seen.add(cursor);
      } while (cursor);
      return operationBusinessFacts(o, result);
    },
    refetchInterval: (q) => (q.state.data?.length ? false : 5000),
    retry: 1,
  });
  if (!supported) return null;
  return (
    <section className="surface stack" aria-label="业务明细">
      <h3>业务明细</h3>
      {"market" in o.intent && (
        <div>
          <HistoryMarket market={o.intent.market} />
        </div>
      )}
      {facts.data?.length ? (
        facts.data.map((f) => (
          <dl className="data-list" key={f.id}>
            {!("market" in o.intent) && f.market && (
              <>
                <dt>市场</dt>
                <dd>
                  <HistoryMarket market={f.market} />
                </dd>
              </>
            )}
            <FactFields fact={f} />
          </dl>
        ))
      ) : (
        <>
          {!("market" in o.intent) && <ListingOperationMarket operation={o} />}
          <IntentSummary operation={o} />
          <Notice>
            {o.state === "confirmed"
              ? "交易已确认，实际份数与金额等待链上明细同步。"
              : "以上为申请参数，实际份数与到账金额以确认后的链上记录为准。"}
          </Notice>
        </>
      )}
      {facts.error && (
        <ErrorNotice error={facts.error} retry={() => void facts.refetch()} />
      )}
      {o.kind === "create-listing" && (
        <p className="small muted">
          挂单总额按份数 ×
          单价计算，尚非成交收入；实际成交后还需扣除相应手续费。
        </p>
      )}
      {["claim-winner", "claim-early-bird"].includes(o.kind) && (
        <p className="small muted">
          领取金额是本次到账金额，不等同于扣除持仓成本后的净收益。
        </p>
      )}
    </section>
  );
}
