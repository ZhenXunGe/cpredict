import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  fetchListings,
  fetchWalletActivity,
  fetchWalletPositions,
  type IndexedListing,
  type IndexedPosition,
  type WalletActivityItem,
} from "./indexer-client.js";

export function WalletActivityPanel(props: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  wallet: Address | null;
  explorerOrigin: string;
  paymentTokenSymbol: string;
  onOpenMarket: (market: Address) => void;
}) {
  const state = useIndexerList(
    props.enabled && props.wallet !== null,
    [props.indexerBasePath, props.chainId, props.wallet],
    (signal) => fetchWalletActivity({
      basePath: props.indexerBasePath,
      chainId: props.chainId,
      owner: props.wallet!,
      signal,
    }).then((page) => page.items),
  );
  if (!props.enabled) return <Notice title="链上活动未启用" detail="当前 runtime 未开放 Indexer。" />;
  if (props.wallet === null) return <Notice title="连接钱包查看链上活动" detail="这里只展示与当前钱包有关的已索引事件。" />;
  if (state.error !== "") return <Notice title="链上活动读取失败" detail={state.error} error />;
  if (state.loading) return <Notice title="正在读取链上活动…" detail="Indexer 正在返回确认与未确认事件。" />;
  if (state.items.length === 0) return <Notice title="暂无链上活动" detail="创建、购买、C2C、终局或领取后会显示在这里。" />;
  return <div className="indexed-list">{state.items.map((item) => <ActivityRow key={`${item.transactionHash}:${item.logIndex}`} item={item} explorerOrigin={props.explorerOrigin} paymentTokenSymbol={props.paymentTokenSymbol} onOpenMarket={props.onOpenMarket} />)}</div>;
}

export function WalletPositionsPanel(props: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  wallet: Address | null;
  onOpenMarket: (market: Address) => void;
}) {
  const state = useIndexerList(
    props.enabled && props.wallet !== null,
    [props.indexerBasePath, props.chainId, props.wallet],
    (signal) => fetchWalletPositions({
      basePath: props.indexerBasePath,
      chainId: props.chainId,
      owner: props.wallet!,
      signal,
    }).then((page) => page.items.filter((item) => item.balance > 0n)),
  );
  if (!props.enabled) return <Notice title="跨市场持仓未启用" detail="当前 runtime 未开放 Indexer；已选择市场的链上余额仍可读取。" />;
  if (props.wallet === null) return <Notice title="连接钱包查看持仓" detail="连接后会汇总所有已索引市场的非零 ERC-1155 余额。" />;
  if (state.error !== "") return <Notice title="持仓目录读取失败" detail={state.error} error />;
  if (state.loading) return <Notice title="正在读取持仓…" detail="请稍候。" />;
  if (state.items.length === 0) return <Notice title="暂无非零持仓" detail="购买一级份额或成交 C2C 挂单后会显示。" />;
  return <div className="position-catalog">{state.items.map((item) => <PositionCard key={`${item.vault}:${item.outcomeId}`} item={item} onOpenMarket={props.onOpenMarket} />)}</div>;
}

export function ListingsPanel(props: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  paymentTokenSymbol: string;
  onOpenMarket: (market: Address) => void;
}) {
  const state = useIndexerList(
    props.enabled,
    [props.indexerBasePath, props.chainId],
    (signal) => fetchListings({
      basePath: props.indexerBasePath,
      chainId: props.chainId,
      active: true,
      signal,
    }).then((page) => page.items),
  );
  if (!props.enabled) return <Notice title="C2C 挂单目录未启用" detail="当前 runtime 未开放 Indexer。" />;
  if (state.error !== "") return <Notice title="C2C 挂单读取失败" detail={state.error} error />;
  if (state.loading) return <Notice title="正在读取活跃挂单…" detail="请稍候。" />;
  if (state.items.length === 0) return <Notice title="暂无活跃挂单" detail="创建挂单后会直接显示在这里。" />;
  return <div className="listing-catalog">{state.items.map((item) => <ListingCard key={item.listingId} item={item} paymentTokenSymbol={props.paymentTokenSymbol} onOpenMarket={props.onOpenMarket} />)}</div>;
}

function ActivityRow(props: {
  item: WalletActivityItem;
  explorerOrigin: string;
  paymentTokenSymbol: string;
  onOpenMarket: (market: Address) => void;
}) {
  const labels: Record<WalletActivityItem["kind"], string> = {
    "market-created": "创建市场",
    "primary-purchased": "一级购买",
    "listing-created": "创建 C2C 挂单",
    "listing-filled": "C2C 成交",
    "listing-cancelled": "取消 C2C 挂单",
    "terminal-listing-returned": "终局退回挂单",
    "market-resolved": "市场已结算",
    "market-voided-creator": "创建者作废",
    "market-voided-timeout": "超时作废",
    "winner-claimed": "领取胜出款",
    "early-bird-claimed": "领取早鸟奖励",
    "principal-refunded": "退还本金",
    "timeout-bonus-claimed": "领取超时奖励",
  };
  return <div className="indexed-row">
    <span className={`status-dot ${props.item.confirmationStatus === "confirmed" ? "success" : "warning"}`} />
    <div><strong>{labels[props.item.kind]}</strong><small>{short(props.item.vault)} · block {props.item.blockNumber.toString()}</small></div>
    <span>{formatActivityValue(props.item, props.paymentTokenSymbol)}</span>
    <button type="button" className="text-button" onClick={() => props.onOpenMarket(props.item.vault)}>打开市场</button>
    <a href={`${props.explorerOrigin}/tx/${props.item.transactionHash}`} target="_blank" rel="noopener noreferrer" aria-label="在区块浏览器查看交易">↗</a>
  </div>;
}

function PositionCard(props: { item: IndexedPosition; onOpenMarket: (market: Address) => void }) {
  return <article>
    <small>结果 {(props.item.outcomeId + 1n).toString()} · {props.item.confirmationStatus === "confirmed" ? "已确认" : "待确认"}</small>
    <strong>{formatShares(props.item.balance)} 份</strong>
    <span className="mono">{short(props.item.vault)}</span>
    <button type="button" className="text-button" onClick={() => props.onOpenMarket(props.item.vault)}>查看市场</button>
  </article>;
}

function ListingCard(props: { item: IndexedListing; paymentTokenSymbol: string; onOpenMarket: (market: Address) => void }) {
  return <article>
    <div><span className="status-pill">出售结果 {(props.item.outcomeId + 1n).toString()}</span><small>{props.item.confirmationStatus === "confirmed" ? "已确认" : "待确认"}</small></div>
    <strong>{formatShares(props.item.remainingUnits)} 份 × {formatPayment(props.item.unitPrice, props.paymentTokenSymbol)}</strong>
    <span className="mono">Vault {short(props.item.vault)}</span>
    <small>到期 {new Date(Number(props.item.expiresAt) * 1_000).toLocaleString("zh-CN", { hour12: false })}</small>
    <button type="button" className="button" onClick={() => props.onOpenMarket(props.item.vault)}>选择此市场</button>
  </article>;
}

function Notice(props: { title: string; detail: string; error?: boolean }) {
  return <div className={props.error === true ? "catalog-empty error" : "catalog-empty"}><strong>{props.title}</strong><p>{props.detail}</p></div>;
}

function useIndexerList<T>(enabled: boolean, dependencies: readonly unknown[], load: (signal: AbortSignal) => Promise<readonly T[]>) {
  const [items, setItems] = useState<readonly T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void load(controller.signal).then((next) => {
      if (!controller.signal.aborted) setItems(next);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : "未知错误");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
    // The caller provides primitive request identity values as dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...dependencies]);
  return { items, loading, error };
}

function formatActivityValue(item: WalletActivityItem, symbol: string): string {
  if (item.amount !== null) return formatPayment(item.amount, symbol);
  if (item.units !== null) return `${formatShares(item.units)} 份`;
  return "—";
}

function formatShares(value: bigint): string {
  return decimal(value, 6);
}

function formatPayment(value: bigint, symbol: string): string {
  return `${decimal(value, 6)} ${symbol}`;
}

function decimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / base}${fraction === "" ? "" : `.${fraction}`}`;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
