import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Address, PublicClient } from "viem";
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

export type SettlementAvailability =
  | { kind: "creator-ready"; deadline: bigint }
  | { kind: "timeout-ready"; deadline: bigint }
  | { kind: "waiting-creator"; deadline: bigint };

export interface SettlementCatalogEntry extends CatalogEntry {
  availability: SettlementAvailability;
}

export function MarketCatalog(props: {
  enabled: boolean;
  indexerBasePath: string;
  metadataBasePath: string | null;
  chainId: number;
  wallet: Address | null;
  paymentTokenSymbol: string;
  selectedMarket: Address | null;
  variant?: "cards" | "select";
  selectLabel?: string;
  selectionBusy?: boolean;
  disabledDetail?: string;
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
    return <CatalogEmpty title="市场目录尚未启用" detail={props.disabledDetail ?? "Indexer 未在当前 runtime 中开放；仍可在下方粘贴 Vault 地址读取链上状态。"} />;
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
      ) : props.variant === "select" ? (
        <MarketCatalogSelect
          entries={entries}
          selectedMarket={props.selectedMarket}
          {...(props.selectLabel === undefined ? {} : { label: props.selectLabel })}
          disabled={props.selectionBusy === true}
          onOpen={props.onOpen}
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

export function MarketCatalogSelect(props: {
  entries: readonly CatalogEntry[];
  selectedMarket: Address | null;
  label?: string;
  disabled?: boolean;
  onOpen: (market: Address, rules: MarketRules | null) => void;
}) {
  const selectedIsKnown = props.selectedMarket !== null && props.entries.some(
    ({ market }) => market.market.toLowerCase() === props.selectedMarket?.toLowerCase(),
  );
  return (
    <label className="catalog-select">
      <span>{props.label ?? "Market Vault"}</span>
      <select
        aria-label={props.label ?? "选择市场"}
        aria-busy={props.disabled === true}
        disabled={props.disabled === true}
        value={props.selectedMarket ?? ""}
        onChange={(event) => {
          const selected = props.entries.find(
            ({ market }) => market.market.toLowerCase() === event.currentTarget.value.toLowerCase(),
          );
          if (selected !== undefined) props.onOpen(selected.market.market, selected.rules);
        }}
      >
        <option value="">请选择市场</option>
        {!selectedIsKnown && props.selectedMarket !== null ? <option value={props.selectedMarket}>当前 Vault · {short(props.selectedMarket)}</option> : null}
        {props.entries.map(({ market, rules }) => <option key={market.market} value={market.market}>{rules?.question ?? short(market.market)} · {catalogStatusLabel(market.status)} · {short(market.market)}</option>)}
      </select>
    </label>
  );
}

export function SettlementMarketCatalog(props: {
  enabled: boolean;
  indexerBasePath: string;
  metadataBasePath: string | null;
  chainId: number;
  wallet: Address | null;
  selectedMarket: Address | null;
  publicClient: Pick<PublicClient, "getBlock"> | null;
  onOpen: (market: Address, rules: MarketRules | null) => void;
}) {
  const [entries, setEntries] = useState<readonly CatalogEntry[]>([]);
  const [observedAt, setObservedAt] = useState<bigint | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!props.enabled) {
      setEntries([]);
      setObservedAt(null);
      setNextCursor(undefined);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setObservedAt(wallClockSeconds());
    if (props.publicClient !== null) {
      void props.publicClient.getBlock({ blockTag: "latest" }).then((block) => {
        if (!controller.signal.aborted) setObservedAt(block.timestamp);
      }).catch(() => undefined);
    }
    void loadEntries({
      indexerBasePath: props.indexerBasePath,
      metadataBasePath: props.metadataBasePath,
      chainId: props.chainId,
      status: "open",
      limit: 100,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return;
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEntries([]);
      setObservedAt(null);
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
    props.publicClient,
    refreshKey,
  ]);

  const settlementEntries = useMemo(
    () => observedAt === null ? [] : settlementCatalogEntries(entries, observedAt, props.wallet),
    [entries, observedAt, props.wallet],
  );

  async function loadMore() {
    if (loading || nextCursor === undefined) return;
    setLoading(true);
    setError("");
    try {
      setObservedAt(wallClockSeconds());
      if (props.publicClient !== null) {
        void props.publicClient.getBlock({ blockTag: "latest" }).then((block) => {
          setObservedAt(block.timestamp);
        }).catch(() => undefined);
      }
      const page = await loadEntries({
        indexerBasePath: props.indexerBasePath,
        metadataBasePath: props.metadataBasePath,
        chainId: props.chainId,
        status: "open",
        limit: 100,
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
    return <CatalogEmpty title="结算队列尚未启用" detail="Indexer 未在当前 runtime 中开放，无法自动发现待结算市场。" />;
  }
  return (
    <>
      <div className="catalog-toolbar">
        <p className="catalog-summary">{observedAt === null ? "读取中…" : `${settlementEntries.length} 个待终局市场`}</p>
        <button type="button" className="text-button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>刷新</button>
      </div>
      {error ? <p className="form-error" role="alert">结算队列读取失败：{error}</p> : null}
      {settlementEntries.length === 0 ? (
        <CatalogEmpty
          title={loading ? "正在读取待结算市场…" : "暂无待结算市场"}
          detail="这里只列出已到 closeAt、尚未结算或作废的市场。"
        />
      ) : (
        <SettlementMarketCards
          entries={settlementEntries}
          selectedMarket={props.selectedMarket}
          onOpen={props.onOpen}
        />
      )}
      {nextCursor === undefined ? null : <button type="button" className="button wide" disabled={loading} onClick={() => void loadMore()}>{loading ? "读取中…" : "加载更多待结算市场"}</button>}
    </>
  );
}

export function settlementCatalogEntries(
  entries: readonly CatalogEntry[],
  observedAt: bigint,
  wallet: Address | null,
): readonly SettlementCatalogEntry[] {
  const priority: Record<SettlementAvailability["kind"], number> = {
    "creator-ready": 0,
    "timeout-ready": 1,
    "waiting-creator": 2,
  };
  return entries.flatMap((entry): SettlementCatalogEntry[] => {
    const availability = settlementAvailability(entry.market, observedAt, wallet);
    return availability === null ? [] : [{ ...entry, availability }];
  }).toSorted((left, right) => {
    const byPriority = priority[left.availability.kind] - priority[right.availability.kind];
    if (byPriority !== 0) return byPriority;
    const leftClose = left.market.closeAt ?? 0n;
    const rightClose = right.market.closeAt ?? 0n;
    return leftClose < rightClose ? -1 : leftClose > rightClose ? 1 : 0;
  });
}

export function settlementAvailability(
  market: MarketCatalogItem,
  observedAt: bigint,
  wallet: Address | null,
): SettlementAvailability | null {
  if (
    market.status !== "open" ||
    market.closeAt === null ||
    market.resolutionWindow === null ||
    observedAt < market.closeAt
  ) return null;
  const deadline = market.closeAt + market.resolutionWindow;
  if (observedAt >= deadline) return { kind: "timeout-ready", deadline };
  if (wallet !== null && market.creator.toLowerCase() === wallet.toLowerCase())
    return { kind: "creator-ready", deadline };
  return { kind: "waiting-creator", deadline };
}

export function SettlementMarketCards(props: {
  entries: readonly SettlementCatalogEntry[];
  selectedMarket: Address | null;
  onOpen: (market: Address, rules: MarketRules | null) => void;
}) {
  return <div className="market-catalog">{props.entries.map(({ market, rules, availability }) => {
    const copy = settlementAvailabilityCopy(availability.kind);
    return (
      <article className={props.selectedMarket?.toLowerCase() === market.market.toLowerCase() ? "market-card selected" : "market-card"} key={market.market}>
        <div className="market-card-heading">
          <span className={`status-pill settlement-${availability.kind}`}>{copy.label}{market.confirmationStatus === "provisional" ? " · 待确认" : ""}</span>
          <span className="mono">{short(market.market)}</span>
        </div>
        <h3>{rules?.question ?? "规则元数据尚未同步"}</h3>
        <div className="outcome-list">
          {(rules?.outcomes ?? Array.from({ length: market.outcomeCount ?? 0 }, (_, index) => `结果 ${index + 1}`)).slice(0, 4).map((outcome) => <span key={outcome}>{outcome}</span>)}
        </div>
        <dl className="market-card-stats">
          <div><dt>截止</dt><dd>{market.closeAt === null ? "—" : formatTimestamp(market.closeAt, true)}</dd></div>
          <div><dt>结算期限</dt><dd>{formatTimestamp(availability.deadline, true)}</dd></div>
          <div><dt>当前权限</dt><dd>{copy.role}</dd></div>
        </dl>
        <button type="button" className="button primary wide" onClick={() => props.onOpen(market.market, rules)}>{copy.action}</button>
      </article>
    );
  })}</div>;
}

function settlementAvailabilityCopy(kind: SettlementAvailability["kind"]): { label: string; role: string; action: string } {
  if (kind === "creator-ready") return { label: "可结算或作废", role: "创建者", action: "进入结算" };
  if (kind === "timeout-ready") return { label: "可超时作废", role: "任意钱包", action: "进入处理" };
  return { label: "等待创建者", role: "仅创建者", action: "查看市场状态" };
}

function wallClockSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

async function loadEntries(input: {
  indexerBasePath: string;
  metadataBasePath: string | null;
  chainId: number;
  limit?: number;
  owner?: Address;
  status?: CatalogStatus;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<{ entries: readonly CatalogEntry[]; nextCursor?: string }> {
  const page = await fetchMarketCatalog({
    basePath: input.indexerBasePath,
    chainId: input.chainId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
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
  return <span className={`status-pill ${props.status === "open" ? "" : "terminal"}`}>{catalogStatusLabel(props.status)}{props.confirmation === "provisional" ? " · 待确认" : ""}</span>;
}

function catalogStatusLabel(status: CatalogStatus): string {
  const labels: Record<CatalogStatus, string> = {
    open: "进行中",
    resolved: "已结算",
    "voided-creator": "创建者作废",
    "voided-timeout": "超时作废",
  };
  return labels[status];
}

function CatalogEmpty(props: { title: string; detail: string }) {
  return <div className="catalog-empty"><strong>{props.title}</strong><p>{props.detail}</p></div>;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatTimestamp(value: bigint, withTime = false): string {
  const date = new Date(Number(value) * 1_000);
  return withTime ? date.toLocaleString("zh-CN", { hour12: false }) : date.toLocaleDateString("zh-CN");
}

function formatUnits(value: bigint, symbol: string): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`} ${symbol}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "未知错误";
}
