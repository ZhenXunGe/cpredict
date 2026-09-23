import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { z } from "zod";
import { formatUnits, type Address } from "viem";
import { AppError } from "../../../offchain/app-core/src/contracts.js";
import { useSession } from "./wallets.js";
import { useOperation } from "./operations.js";
import {
  dateText,
  marketReadAbi,
  useMarket,
  useMarketClock,
  useMarketLive,
  useBalance,
  useRules,
} from "./data.js";
import { parseAssetAmount } from "./amounts.js";
import { bidReserve } from "../../../offchain/sdk/src/orderbook.js";
import { SHARE_SCALE } from "../../../offchain/sdk/src/units.js";
import {
  Amount,
  Button,
  DataTable,
  Field,
  ErrorNotice,
  Notice,
  PaginationControls,
  shortAddress,
} from "./ui.js";
import { usePaginatedList } from "./pagination.js";
import {
  orderSchema,
  orderPageSchema as page,
} from "../../../offchain/app-core/src/orderbook-contracts.js";
function useOrders(market?: Address) {
  const { api, account } = useSession();
  return useInfiniteQuery({
    queryKey: [api.key, "orders-v2", market, market ? null : account?.address],
    enabled:
      api.environment.deployment.marketplaceVersion === "orderbook-v2" &&
      (!!market || !!account),
    initialPageParam: "0",
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v2/orders?${market ? `market=${market}` : `owner=${account!.address}`}&cursor=${pageParam}`,
        page,
        { service: "indexer", signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 2000,
  });
}
export function FrozenOrderAssets() {
  const { api } = useSession();
  const q = useOrders();
  const locked = q.data?.pages[0]?.totalLockedPayment;
  const pages =
    q.data?.pages.map((orderPage) =>
      orderPage.items.filter(
        (order) =>
          order.active &&
          order.side === "bid" &&
          BigInt(order.lockedPayment) > 0n,
      ),
    ) ?? [];
  const bids = pages.flat();
  const pagination = usePaginatedList({
    pages,
    pageSize: 5,
    scope: `${api.key}:frozen-bids`,
    hasMore: !!q.hasNextPage,
    isLoadingMore: q.isFetchingNextPage,
    loadMore: q.fetchNextPage,
  });
  if (api.environment.deployment.marketplaceVersion !== "orderbook-v2")
    return null;
  return (
    <section className="surface stack" aria-labelledby="frozen-bids-title">
      <h3 id="frozen-bids-title">求购冻结资产</h3>
      {locked === undefined ? (
        <p>正在核对冻结金额…</p>
      ) : (
        <Amount value={locked} asset={api.environment.asset} />
      )}
      <p className="small">
        包含全部求购订单。冻结资产不计入可用余额；撤销、到期释放或终局后退回。
      </p>
      <ErrorNotice error={q.error} />
      {!q.isPending && bids.length === 0 && (
        <p className="small">当前没有未完成的求购单。</p>
      )}
      {bids.length > 0 && (
        <>
          <h4>求购单明细</h4>
          <DataTable
            headers={[
              "市场",
              "求购结果",
              "剩余份额",
              "每份价格",
              "冻结金额",
              "到期时间",
              "操作",
            ]}
          >
            {pagination.items.map((order) => (
              <FrozenBidRow key={order.id} order={order} />
            ))}
          </DataTable>
          <PaginationControls
            ariaLabel="求购单明细分页"
            page={pagination.page}
            hasPrevious={pagination.hasPrevious}
            hasNext={pagination.hasNext}
            busy={pagination.isLoading}
            onPrevious={pagination.previous}
            onNext={() => void pagination.next()}
          />
        </>
      )}
    </section>
  );
}

function FrozenBidRow({ order }: { order: z.infer<typeof orderSchema> }) {
  const { api } = useSession(),
    begin = useOperation(),
    market = useMarket(order.market),
    rules = useRules(market.data);
  const question =
      market.data?.question?.trim() ||
      rules.data?.question?.trim() ||
      `市场 ${shortAddress(order.market)}`,
    outcome =
      rules.data?.outcomes[Number(order.outcomeId)] ??
      `结果 #${order.outcomeId}`,
    remaining = formatUnits(BigInt(order.remainingUnits), 6),
    unitPrice = formatUnits(BigInt(order.unitPrice), 6),
    locked = formatUnits(BigInt(order.lockedPayment), 6),
    asset = api.environment.asset;
  return (
    <tr>
      <td>
        <Link to={`/${api.environment.id}/markets/${order.market}`}>
          {question}
        </Link>
      </td>
      <td>{outcome}</td>
      <td>{remaining}</td>
      <td>
        {unitPrice} {asset}
      </td>
      <td>
        {locked} {asset}
      </td>
      <td>{dateText(order.expiresAt)}</td>
      <td>
        <Button
          onClick={() =>
            begin({
              intent: { kind: "cancel-order", orderId: order.id },
              summary: [
                { label: "市场", value: question },
                { label: "结果选项", value: outcome },
                { label: "剩余份数", value: remaining },
                { label: "每份价格", value: `${unitPrice} ${asset}` },
                { label: "解冻金额", value: `${locked} ${asset}` },
              ],
              feeNote: "撤销后，本求购单剩余的冻结资金将退回当前应用账户。",
            })
          }
        >
          撤销求购单
        </Button>
      </td>
    </tr>
  );
}
export function OrderbookPanel({
  market,
  labels,
  verified,
  terminal,
  question,
}: {
  market: Address;
  labels: string[];
  verified: boolean;
  terminal: boolean;
  question: string;
}) {
  const { api, account, login } = useSession(),
    begin = useOperation(),
    live = useMarketLive(market),
    paymentBalance = useBalance(),
    now = useMarketClock(),
    q = useOrders(market);
  const [side, setSide] = useState<"bid" | "ask">("bid"),
    [outcome, setOutcome] = useState(0),
    [amount, setAmount] = useState(""),
    [price, setPrice] = useState("1"),
    [autoMatch, setAuto] = useState(true),
    [expiry, setExpiry] = useState("24"),
    [error, setError] = useState<unknown>(null),
    [take, setTake] = useState<Record<string, string>>({}),
    [acceptWarning, setAcceptWarning] = useState<{
      orderId: string;
      message: string;
    } | null>(null),
    [checkingOrderId, setCheckingOrderId] = useState<string | null>(null);
  const shareBalance = useQuery({
    queryKey: [api.key, "share-balance", account?.address, market, outcome],
    enabled: side === "ask" && !!account,
    queryFn: () =>
      api.publicClient().readContract({
        address: market,
        abi: marketReadAbi,
        functionName: "balanceOf",
        args: [account!.address, BigInt(outcome)],
      }),
    refetchInterval: 15000,
    staleTime: 5000,
  });
  const asset = api.environment.asset;
  let requestedUnits: bigint | null = null;
  try {
    requestedUnits = amount ? parseAssetAmount(amount) : null;
  } catch {
    // The existing amount validation owns malformed values on submit.
  }
  const insufficientShares =
    side === "ask" &&
    requestedUnits !== null &&
    shareBalance.data !== undefined &&
    requestedUnits > shareBalance.data;
  let requestedPrice: bigint | null = null;
  try {
    requestedPrice = price ? parseAssetAmount(price) : null;
  } catch {
    // The existing price validation owns malformed values on submit.
  }
  const requestedReserve =
      requestedUnits !== null && requestedPrice !== null
        ? bidReserve(requestedUnits, requestedPrice)
        : null,
    insufficientPayment =
      side === "bid" &&
      requestedReserve !== null &&
      paymentBalance.data !== undefined &&
      requestedReserve > paymentBalance.data,
    unmatchablePrice =
      autoMatch &&
      requestedPrice !== null &&
      live.data !== undefined &&
      (live.data.minimumC2C * requestedPrice) / SHARE_SCALE === 0n;
  const primaryOpen =
      !terminal &&
      !!live.data &&
      live.data.state === 0 &&
      live.data.now < live.data.closeAt &&
      now < live.data.closeAt,
    premiumAsk =
      side === "ask" &&
      primaryOpen &&
      requestedPrice !== null &&
      requestedPrice > SHARE_SCALE;
  const summary = (choice: number, units: bigint, unitPrice: bigint) => [
    { label: "市场", value: question },
    { label: "结果选项", value: labels[choice] ?? `结果 #${choice}` },
    { label: "份数", value: formatUnits(units, 6) },
    { label: "每份价格", value: `${formatUnits(unitPrice, 6)} ${asset}` },
    {
      label: "成交总额（未扣手续费）",
      value: `${formatUnits((units * unitPrice) / 1_000_000n, 6)} ${asset}`,
    },
  ];
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!account) {
      login();
      return;
    }
    try {
      const units = parseAssetAmount(amount),
        unitPrice = parseAssetAmount(price);
      if (!live.data || !verified || terminal)
        throw new Error("当前市场暂不能挂单");
      if (units < live.data.minimumC2C) throw new Error("低于市场最小挂单份额");
      if (autoMatch && (live.data.minimumC2C * unitPrice) / SHARE_SCALE === 0n)
        throw new Error("每份价格过低，最小份额的成交金额为零，无法自动撮合");
      if (side === "bid") {
        const currentBalance = await paymentBalance.refetch(),
          reserve = bidReserve(units, unitPrice);
        if (currentBalance.error || currentBalance.data === undefined)
          throw new AppError("chain_query_unavailable", 503);
        if (reserve > currentBalance.data)
          throw new AppError("insufficient_balance", 400);
      } else {
        const currentBalance = await shareBalance.refetch();
        if (currentBalance.error || currentBalance.data === undefined)
          throw new AppError("chain_query_unavailable", 503);
        if (units > currentBalance.data)
          throw new AppError("insufficient_shares", 400);
      }
      begin({
        intent: {
          kind: "create-order",
          market,
          side,
          outcomeId: String(outcome),
          units: units.toString(),
          unitPrice: unitPrice.toString(),
          expiresAt: (live.data.now + BigInt(expiry) * 3600n).toString(),
          autoMatch,
        },
        summary: [
          ...summary(outcome, units, unitPrice),
          { label: "订单类型", value: side === "bid" ? "求购" : "挂卖" },
          { label: "有效期", value: `${expiry}小时` },
          {
            label: "自动撮合",
            value: autoMatch
              ? "开启，满足价格时自动成交"
              : "关闭，仅接受主动接单",
          },
          ...(side === "bid"
            ? [
                {
                  label: "冻结金额",
                  value: `${formatUnits(bidReserve(units, unitPrice), 6)} ${asset}`,
                },
              ]
            : []),
          ...(side === "ask" && primaryOpen && unitPrice > SHARE_SCALE
            ? [
                {
                  label: "价格提示",
                  value: `高于一级购买每份 1 ${asset}`,
                },
              ]
            : []),
        ],
        feeNote:
          "按先挂订单的价格撮合。成交手续费由卖家承担；未成交部分可以撤销。",
      });
    } catch (e) {
      setError(e);
    }
  }
  async function accept(o: z.infer<typeof orderSchema>) {
    setError(null);
    setAcceptWarning(null);
    if (!account) {
      login();
      return;
    }
    try {
      if (!live.data) throw new Error("正在核验市场");
      const units = parseAssetAmount(
          take[o.id] ?? formatUnits(BigInt(o.remainingUnits), 6),
        ),
        gross = (units * BigInt(o.unitPrice)) / 1_000_000n;
      if (units > BigInt(o.remainingUnits)) throw new Error("超过订单剩余份额");
      if (gross === 0n) throw new Error("本次成交金额为零，请增加接单份数");
      setCheckingOrderId(o.id);
      if (o.side === "bid") {
        const available = await api.publicClient().readContract({
          address: market,
          abi: marketReadAbi,
          functionName: "balanceOf",
          args: [account.address, BigInt(o.outcomeId)],
        });
        if (units > available) {
          setAcceptWarning({
            orderId: o.id,
            message: `余额不足：当前结果可用 ${formatUnits(available, 6)} 份，请调整接单数量。`,
          });
          return;
        }
      } else {
        const currentBalance = await paymentBalance.refetch();
        if (currentBalance.error || currentBalance.data === undefined)
          throw new AppError("chain_query_unavailable", 503);
        if (gross > currentBalance.data) {
          setAcceptWarning({
            orderId: o.id,
            message: `余额不足：当前可用 ${formatUnits(currentBalance.data, 6)} ${asset}，本次需支付 ${formatUnits(gross, 6)} ${asset}，请调整接单数量。`,
          });
          return;
        }
      }
      const fees =
        (gross * BigInt(live.data.economics.platformC2CFeeBps)) / 10000n +
        (gross * BigInt(live.data.economics.creatorC2CFeeBps)) / 10000n;
      begin({
        intent: {
          kind: "fill-order",
          orderId: o.id,
          side: o.side,
          units: units.toString(),
          minUnits: units.toString(),
          paymentLimit: (o.side === "ask" ? gross : gross - fees).toString(),
          deadline: (live.data.now + 300n).toString(),
        },
        summary: [
          ...summary(Number(o.outcomeId), units, BigInt(o.unitPrice)),
          ...(o.side === "ask" &&
          primaryOpen &&
          BigInt(o.unitPrice) > SHARE_SCALE
            ? [
                {
                  label: "价格提示",
                  value: `高于一级购买每份 1 ${asset}`,
                },
              ]
            : []),
          {
            label: "卖家净收款",
            value: `${formatUnits(gross - fees, 6)} ${asset}`,
          },
        ],
        feeNote:
          "本次按选择的订单价格成交，买卖资产原子交换；数量变化须重新确认。",
      });
    } catch (e) {
      setError(e);
    } finally {
      setCheckingOrderId(null);
    }
  }
  const allItems =
    q.data?.pages.flatMap((p) => p.items).filter((o) => o.active) ?? [];
  const pagination = usePaginatedList({
    pages:
      q.data?.pages.map((page) => page.items.filter((order) => order.active)) ??
      [],
    pageSize: 5,
    scope: `${api.key}:${market}`,
    hasMore: !!q.hasNextPage,
    isLoadingMore: q.isFetchingNextPage,
    loadMore: q.fetchNextPage,
  });
  return (
    <section className="surface stack">
      <h2>求购 / 挂卖</h2>
      {!terminal && (
        <form className="stack" onSubmit={create}>
          <Field label="订单类型">
            <select
              value={side}
              onChange={(e) => {
                setSide(e.target.value as "bid" | "ask");
                setError(null);
              }}
            >
              <option value="bid">求购：冻结资金等待买入</option>
              <option value="ask">挂卖：托管份额等待卖出</option>
            </select>
          </Field>
          <Field label="结果选项">
            <select
              value={outcome}
              onChange={(e) => {
                setOutcome(Number(e.target.value));
                setError(null);
              }}
            >
              {labels.map((v, i) => (
                <option key={i} value={i}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="份数">
            <input
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
              }}
              inputMode="decimal"
              required
            />
          </Field>
          {side === "ask" && (
            <p className="small">
              可用份额：
              {!account
                ? "登录后核对"
                : shareBalance.isPending
                  ? "正在核对…"
                  : shareBalance.data === undefined
                    ? "暂时无法读取"
                    : `${formatUnits(shareBalance.data, 6)} 份`}
            </p>
          )}
          {insufficientShares && (
            <Notice tone="warning">
              {`余额不足：当前结果可用 ${formatUnits(shareBalance.data!, 6)} 份，请调整挂卖数量。`}
            </Notice>
          )}
          <Field label={`每份价格（${asset}）`}>
            <input
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setError(null);
              }}
              inputMode="decimal"
              required
            />
          </Field>
          {side === "bid" && (
            <p className="small">
              可用余额：
              {!account
                ? "登录后核对"
                : paymentBalance.isPending
                  ? "正在核对…"
                  : paymentBalance.data === undefined
                    ? "暂时无法读取"
                    : `${formatUnits(paymentBalance.data, 6)} ${asset}`}
            </p>
          )}
          {insufficientPayment && (
            <Notice tone="warning">
              {`余额不足：当前可用 ${formatUnits(paymentBalance.data!, 6)} ${asset}，本求购单需冻结 ${formatUnits(requestedReserve!, 6)} ${asset}，请调整份数或价格。`}
            </Notice>
          )}
          {unmatchablePrice && (
            <Notice tone="warning">
              每份价格过低，最小份额的成交金额为零，无法自动撮合。请提高价格或关闭自动撮合。
            </Notice>
          )}
          {premiumAsk && (
            <Notice tone="warning">
              当前挂卖价格高于一级购买每份 1 {asset}
              。封盘前买家可以通过一级购买获得更低价格，请确认定价。
            </Notice>
          )}
          <Field label="有效期">
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="1">1小时</option>
              <option value="24">24小时</option>
              <option value="168">7天</option>
            </select>
          </Field>
          <label>
            <input
              type="checkbox"
              checked={autoMatch}
              onChange={(e) => setAuto(e.target.checked)}
            />
            自动撮合（默认开启）
          </label>
          <Button
            type="submit"
            disabled={
              !verified ||
              !live.data ||
              (side === "bid" &&
                !!account &&
                (paymentBalance.isPending ||
                  !!paymentBalance.error ||
                  insufficientPayment)) ||
              unmatchablePrice ||
              (side === "ask" &&
                !!account &&
                (shareBalance.isPending ||
                  !!shareBalance.error ||
                  insufficientShares))
            }
          >
            核对{side === "bid" ? "求购" : "挂卖"}
          </Button>
        </form>
      )}
      <ErrorNotice
        error={
          error ??
          (side === "ask" ? shareBalance.error : paymentBalance.error) ??
          q.error
        }
      />
      {allItems.length === 0 && <p>暂无未完成订单</p>}
      {pagination.items.map((o) => (
        <article className="card stack" key={o.id}>
          <strong>
            {o.side === "bid" ? "求购" : "挂卖"} ·{" "}
            {labels[Number(o.outcomeId)] ?? `结果 #${o.outcomeId}`}
          </strong>
          <p>
            剩余 {formatUnits(BigInt(o.remainingUnits), 6)} 份 · 每份{" "}
            {formatUnits(BigInt(o.unitPrice), 6)} {asset} ·{" "}
            {o.autoMatch ? "自动撮合" : "等待接单"}
          </p>
          {o.side === "ask" &&
            primaryOpen &&
            BigInt(o.unitPrice) > SHARE_SCALE && (
              <Notice tone="warning">
                此挂卖单高于一级购买每份 1 {asset}。封盘前可先比较一级购买价格。
              </Notice>
            )}
          {o.owner.toLowerCase() === account?.address.toLowerCase() ? (
            <Button
              onClick={() =>
                begin({
                  intent: {
                    kind:
                      terminal || BigInt(o.expiresAt) <= (live.data?.now ?? 0n)
                        ? "release-order"
                        : "cancel-order",
                    orderId: o.id,
                  },
                  summary: summary(
                    Number(o.outcomeId),
                    BigInt(o.remainingUnits),
                    BigInt(o.unitPrice),
                  ),
                  feeNote: "取回本订单剩余的冻结资金或托管份额。",
                })
              }
            >
              撤销 / 取回剩余资产
            </Button>
          ) : (
            !terminal &&
            BigInt(o.expiresAt) > (live.data?.now ?? 0n) && (
              <>
                <Field label="接单份数">
                  <input
                    value={
                      take[o.id] ?? formatUnits(BigInt(o.remainingUnits), 6)
                    }
                    onChange={(e) => {
                      setTake({ ...take, [o.id]: e.target.value });
                      if (acceptWarning?.orderId === o.id)
                        setAcceptWarning(null);
                    }}
                    inputMode="decimal"
                  />
                </Field>
                {acceptWarning?.orderId === o.id && (
                  <Notice tone="warning">{acceptWarning.message}</Notice>
                )}
                <Button
                  disabled={!verified || !live.data || checkingOrderId === o.id}
                  onClick={() => void accept(o)}
                >
                  {checkingOrderId === o.id
                    ? o.side === "bid"
                      ? "正在核对份额…"
                      : "正在核对余额…"
                    : o.side === "bid"
                      ? "卖给此求购单"
                      : "购买此挂卖单"}
                </Button>
              </>
            )
          )}
        </article>
      ))}
      <PaginationControls
        ariaLabel="订单分页"
        page={pagination.page}
        hasPrevious={pagination.hasPrevious}
        hasNext={pagination.hasNext}
        busy={pagination.isLoading}
        onPrevious={pagination.previous}
        onNext={() => void pagination.next()}
      />
      <Notice>
        自动撮合优先价格更优的订单，同价按挂单先后成交；关闭自动撮合的订单仍可主动接单。
      </Notice>
    </section>
  );
}
