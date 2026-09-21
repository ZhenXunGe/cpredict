import { useState, type FormEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { formatUnits, type Address } from "viem";
import { useSession } from "./wallets.js";
import { useOperation } from "./operations.js";
import { useMarketLive } from "./data.js";
import { parseAssetAmount } from "./amounts.js";
import { bidReserve } from "../../../offchain/sdk/src/orderbook.js";
import { Amount, Button, Field, ErrorNotice, Notice } from "./ui.js";
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
    refetchInterval: 5000,
  });
}
export function FrozenOrderAssets() {
  const { api } = useSession();
  const q = useOrders();
  if (api.environment.deployment.marketplaceVersion !== "orderbook-v2")
    return null;
  const locked = q.data?.pages[0]?.totalLockedPayment;
  return (
    <section className="surface">
      <h3>求购冻结资产</h3>
      {locked === undefined ? (
        <p>正在核对冻结金额…</p>
      ) : (
        <Amount value={locked} asset={api.environment.asset} />
      )}
      <p className="small">
        包含全部求购订单。冻结资产不计入可用余额；撤销、到期释放或终局后退回。
      </p>
      <ErrorNotice error={q.error} />
    </section>
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
    q = useOrders(market);
  const [side, setSide] = useState<"bid" | "ask">("bid"),
    [outcome, setOutcome] = useState(0),
    [amount, setAmount] = useState(""),
    [price, setPrice] = useState("1"),
    [autoMatch, setAuto] = useState(true),
    [expiry, setExpiry] = useState("24"),
    [error, setError] = useState<unknown>(null),
    [take, setTake] = useState<Record<string, string>>({});
  const asset = api.environment.asset;
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
  function create(e: FormEvent) {
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
        ],
        feeNote:
          "按先挂订单的价格撮合。成交手续费由卖家承担；未成交部分可以撤销。",
      });
    } catch (e) {
      setError(e);
    }
  }
  function accept(o: z.infer<typeof orderSchema>) {
    setError(null);
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
    }
  }
  const items =
    q.data?.pages.flatMap((p) => p.items).filter((o) => o.active) ?? [];
  return (
    <section className="surface stack">
      <h2>求购 / 挂卖</h2>
      {!terminal && (
        <form className="stack" onSubmit={create}>
          <Field label="订单类型">
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as "bid" | "ask")}
            >
              <option value="bid">求购：冻结资金等待买入</option>
              <option value="ask">挂卖：托管份额等待卖出</option>
            </select>
          </Field>
          <Field label="结果选项">
            <select
              value={outcome}
              onChange={(e) => setOutcome(Number(e.target.value))}
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
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              required
            />
          </Field>
          <Field label={`每份价格（${asset}）`}>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              required
            />
          </Field>
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
          <Button type="submit" disabled={!verified || !live.data}>
            核对{side === "bid" ? "求购" : "挂卖"}
          </Button>
        </form>
      )}
      <ErrorNotice error={error ?? q.error} />
      {items.length === 0 && <p>暂无未完成订单</p>}
      {items.map((o) => (
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
                    onChange={(e) =>
                      setTake({ ...take, [o.id]: e.target.value })
                    }
                    inputMode="decimal"
                  />
                </Field>
                <Button
                  disabled={!verified || !live.data}
                  onClick={() => accept(o)}
                >
                  {o.side === "bid" ? "卖给此求购单" : "购买此挂卖单"}
                </Button>
              </>
            )
          )}
        </article>
      ))}
      {q.hasNextPage && (
        <Button onClick={() => void q.fetchNextPage()}>加载更多订单</Button>
      )}
      <Notice>
        自动撮合优先价格更优的订单，同价按挂单先后成交；关闭自动撮合的订单仍可主动接单。
      </Notice>
    </section>
  );
}
