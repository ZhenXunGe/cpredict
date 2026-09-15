import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { formatEther, type Address } from "viem";
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
  PageTitle,
  shortAddress,
} from "../ui.js";
import { dateText, marketSchema } from "../data.js";
import {
  listingTotal,
  operationBusinessFacts,
  businessFactKinds,
} from "../history-details.js";
import { DepositHistory } from "../DepositHistory.js";
const labels: Record<LedgerFact["kind"], string> = {
  "market-created": "创建市场",
  "market-initialized": "市场初始化",
  "market-metadata": "发布规则",
  "economic-snapshot": "费率快照",
  "primary-buy": "一级购买",
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
          <section className="card stack">
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
                {attempts.map((o) => (
                  <tr key={o.id}>
                    <td>{operationLabels[o.kind]}</td>
                    <td>
                      {"market" in o.intent ? (
                        <HistoryMarket market={o.intent.market} />
                      ) : (
                        "跨市场 / 账户"
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
            {operations.hasNextPage && (
              <Button
                variant="secondary"
                disabled={operations.isFetchingNextPage}
                onClick={() => void operations.fetchNextPage()}
              >
                更多操作
              </Button>
            )}
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
                    "份数",
                    "金额 / 挂单总额",
                    "详情",
                  ]}
                >
                  {items.map((f) => (
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
                        <Amount value={f.units} />
                      </td>
                      <td>
                        <FactAmount fact={f} />
                        {f.kind === "listing-created" && (
                          <div className="small muted">
                            挂单总额，尚非成交收入
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
            {rows.hasNextPage && (
              <Button
                variant="secondary"
                disabled={rows.isFetchingNextPage}
                onClick={() => void rows.fetchNextPage()}
              >
                加载更多历史
              </Button>
            )}
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

function HistoryMarket({ market }: { market: Address }) {
  const { api } = useSession();
  const query = useQuery({
    queryKey: [api.key, "market", market],
    queryFn: ({ signal }) =>
      api.request(`/v2/markets/${market}`, marketSchema, {
        service: "indexer",
        signal,
      }),
    staleTime: 60000,
    retry: 1,
  });
  return (
    <Link to={`/${api.environment.id}/markets/${market}`} title={market}>
      {query.data?.question?.trim() ||
        (query.isPending
          ? "正在读取市场名称"
          : `名称暂不可用（${shortAddress(market)}）`)}
    </Link>
  );
}

function IntentSummary({ operation: o }: { operation: Operation }) {
  const { api } = useSession();
  const intent = o.intent;
  if (intent.kind === "buy")
    return (
      <div className="small muted">
        申请购买 <Amount value={intent.units} /> 份
      </div>
    );
  if (intent.kind === "create-listing")
    return (
      <div className="small muted">
        挂单 <Amount value={intent.units} /> 份 · 总额{" "}
        <Amount
          value={listingTotal(intent.units, intent.unitPrice)}
          asset={api.environment.asset}
        />
      </div>
    );
  return null;
}

function FactAmount({ fact }: { fact: LedgerFact }) {
  const { api } = useSession();
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
          : fact.amount
      }
      asset={api.environment.asset}
    />
  );
}

function FactFields({ fact }: { fact: LedgerFact }) {
  const { api } = useSession();
  const listing = fact.kind === "listing-created";
  return (
    <>
      <dt>
        {listing
          ? "挂单份数"
          : fact.kind === "primary-buy"
            ? "实际购买份数"
            : "核销 / 变动份数"}
      </dt>
      <dd>
        <Amount value={fact.units} />
      </dd>
      {listing && (
        <>
          <dt>挂单单价（每份）</dt>
          <dd>
            <Amount
              value={
                typeof fact.extra.unitPrice === "string" &&
                /^\d+$/.test(fact.extra.unitPrice)
                  ? fact.extra.unitPrice
                  : null
              }
              asset={api.environment.asset}
            />
          </dd>
        </>
      )}
      <dt>
        {listing
          ? "挂单总额（未扣成交手续费）"
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
            <FactFields fact={f} />
          </dl>
        ))
      ) : (
        <>
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
