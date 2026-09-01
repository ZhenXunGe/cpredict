import { useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import type { MarketRules } from "../../../offchain/sdk/src/index.js";
import {
  fetchMarketCatalog,
  fetchMarketRules,
  type CatalogStatus,
  type MarketCatalogItem,
} from "./indexer-client.js";

export interface CatalogEntry {
  market: MarketCatalogItem;
  rules: MarketRules | null;
}

export function MarketCatalog(props: {
  enabled: boolean;
  indexerBasePath: string;
  metadataBasePath: string | null;
  chainId: number;
  wallet: Address | null;
  paymentTokenSymbol: string;
  selectedMarket: Address | null;
  onOpen: (market: Address, rules: MarketRules | null) => void;
}) {
  const [mineOnly, setMineOnly] = useState(false);
  const [status, setStatus] = useState<"all" | CatalogStatus>("all");
  const [entries, setEntries] = useState<readonly CatalogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!props.enabled) {
      setEntries([]);
      setNextCursor(undefined);
      setError("");
      return;
    }
    if (mineOnly && props.wallet === null) {
      setEntries([]);
      setNextCursor(undefined);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void loadEntries({
      indexerBasePath: props.indexerBasePath,
      metadataBasePath: props.metadataBasePath,
      chainId: props.chainId,
      ...(mineOnly && props.wallet !== null ? { owner: props.wallet } : {}),
      ...(status === "all" ? {} : { status }),
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return;
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEntries([]);
      setNextCursor(undefined);
      setError(messageOf(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [
    props.enabled,
    props.indexerBasePath,
    props.metadataBasePath,
    props.chainId,
    props.wallet,
    mineOnly,
    status,
    refreshKey,
  ]);

  async function loadMore() {
    if (loading || nextCursor === undefined) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadEntries({
        indexerBasePath: props.indexerBasePath,
        metadataBasePath: props.metadataBasePath,
        chainId: props.chainId,
        ...(mineOnly && props.wallet !== null ? { owner: props.wallet } : {}),
        ...(status === "all" ? {} : { status }),
        cursor: nextCursor,
      });
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  if (!props.enabled) {
    return <CatalogEmpty title="市场目录尚未启用" detail="Indexer 未在当前 runtime 中开放；仍可在下方粘贴 Vault 地址读取链上状态。" />;
  }

  return (
    <>
      <div className="catalog-toolbar">
        <div className="tabs" aria-label="市场状态筛选">
          {(["all", "open", "resolved"] as const).map((value) => (
            <button key={value} type="button" className={status === value ? "active" : ""} onClick={() => setStatus(value)}>
              {value === "all" ? "全部" : value === "open" ? "进行中" : "已终局"}
            </button>
          ))}
        </div>
        <label className="mine-filter">
          <input type="checkbox" checked={mineOnly} disabled={props.wallet === null} onChange={(event) => setMineOnly(event.currentTarget.checked)} />
          我创建的
        </label>
        <button type="button" className="text-button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>刷新</button>
      </div>
      {error ? <p className="form-error" role="alert">市场目录读取失败：{error}</p> : null}
      {entries.length === 0 ? (
        <CatalogEmpty
          title={loading ? "正在读取市场…" : "暂无匹配市场"}
          detail={mineOnly && props.wallet === null ? "连接钱包后查看自己创建的市场。" : "新市场被 Indexer 确认后会自动出现在这里。"}
        />
      ) : (
        <MarketCatalogCards
          entries={entries}
          paymentTokenSymbol={props.paymentTokenSymbol}
          selectedMarket={props.selectedMarket}
          onOpen={props.onOpen}
        />
      )}
      {nextCursor === undefined ? null : <button type="button" className="button wide" disabled={loading} onClick={() => void loadMore()}>{loading ? "读取中…" : "加载更多市场"}</button>}
    </>
  );
}

export function MarketCatalogCards(props: {
  entries: readonly CatalogEntry[];
  paymentTokenSymbol: string;
  selectedMarket: Address | null;
  onOpen: (market: Address, rules: MarketRules | null) => void;
}) {
  return <div className="market-catalog">{props.entries.map(({ market, rules }) => {
    const progress = market.marketPrimaryCap === null || market.marketPrimaryCap === 0n
      ? null
      : Number(market.primaryFilledUnits * 10_000n / market.marketPrimaryCap) / 100;
    return (
      <article className={props.selectedMarket?.toLowerCase() === market.market.toLowerCase() ? "market-card selected" : "market-card"} key={market.market}>
        <div className="market-card-heading">
          <Status status={market.status} confirmation={market.confirmationStatus} />
          <span className="mono">{short(market.market)}</span>
        </div>
        <h3>{rules?.question ?? "规则元数据尚未同步"}</h3>
        <div className="outcome-list">
          {(rules?.outcomes ?? Array.from({ length: market.outcomeCount ?? 0 }, (_, index) => `结果 ${index + 1}`)).slice(0, 4).map((outcome) => <span key={outcome}>{outcome}</span>)}
          {(rules?.outcomes.length ?? market.outcomeCount ?? 0) > 4 ? <span>+{(rules?.outcomes.length ?? market.outcomeCount ?? 0) - 4}</span> : null}
        </div>
        <dl className="market-card-stats">
          <div><dt>截止</dt><dd>{market.closeAt === null ? "待同步" : formatTimestamp(market.closeAt)}</dd></div>
          <div><dt>市场上限</dt><dd>{market.marketPrimaryCap === null ? "待同步" : formatUnits(market.marketPrimaryCap, props.paymentTokenSymbol)}</dd></div>
          <div><dt>已填充</dt><dd>{progress === null ? "—" : `${Math.min(progress, 100).toFixed(1)}%`}</dd></div>
        </dl>
        <button type="button" className="button primary wide" onClick={() => props.onOpen(market.market, rules)}>查看并交易</button>
      </article>
    );
  })}</div>;
}

async function loadEntries(input: {
  indexerBasePath: string;
  metadataBasePath: string | null;
  chainId: number;
  owner?: Address;
  status?: CatalogStatus;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<{ entries: readonly CatalogEntry[]; nextCursor?: string }> {
  const page = await fetchMarketCatalog({
    basePath: input.indexerBasePath,
    chainId: input.chainId,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const entries = await Promise.all(page.items.map(async (market): Promise<CatalogEntry> => {
    if (input.metadataBasePath === null || market.rulesHash === null)
      return { market, rules: null };
    try {
      const rules = await fetchMarketRules({
        metadataBasePath: input.metadataBasePath,
        rulesHash: market.rulesHash,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (market.closeAt !== null && BigInt(rules.closesAt) !== market.closeAt)
        return { market, rules: null };
      return {
        market,
        rules,
      };
    } catch {
      return { market, rules: null };
    }
  }));
  return {
    entries,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

function Status(props: { status: CatalogStatus; confirmation: "provisional" | "confirmed" }): ReactNode {
  const labels: Record<CatalogStatus, string> = {
    open: "进行中",
    resolved: "已结算",
    "voided-creator": "创建者作废",
    "voided-timeout": "超时作废",
  };
  return <span className={`status-pill ${props.status === "open" ? "" : "terminal"}`}>{labels[props.status]}{props.confirmation === "provisional" ? " · 待确认" : ""}</span>;
}

function CatalogEmpty(props: { title: string; detail: string }) {
  return <div className="catalog-empty"><strong>{props.title}</strong><p>{props.detail}</p></div>;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatTimestamp(value: bigint): string {
  return new Date(Number(value) * 1_000).toLocaleDateString("zh-CN");
}

function formatUnits(value: bigint, symbol: string): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`} ${symbol}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "未知错误";
}
