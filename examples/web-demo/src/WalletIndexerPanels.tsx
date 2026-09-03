import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { shouldFoldListingBeforeClose } from "../../react/src/marketplacePresentation.js";
import {
  fetchIndexerSyncStatus,
  fetchListings,
  fetchWalletActivity,
  fetchWalletPositions,
  type IndexerSyncStatus,
  type IndexedListing,
  type IndexedPosition,
  type WalletActivityItem,
} from "./indexer-client.js";

const POSITION_SYNC_POLL_MS = 1_500;

export interface LiveWalletPosition {
  vault: Address;
  outcomeId: bigint;
  balance: bigint;
  marketState: number | null;
  winningOutcome: bigint | null;
}

export interface WalletPositionsState {
  identity: string | null;
  items: readonly IndexedPosition[];
  syncStatus: IndexerSyncStatus | null;
  error: string;
}

interface DisplayPosition {
  vault: Address;
  outcomeId: bigint;
  balance: bigint;
  confirmationStatus: IndexedPosition["confirmationStatus"];
  source: "indexer" | "live";
  marketState: number | null;
  winningOutcome: bigint | null;
}

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
    (signal) =>
      fetchWalletActivity({
        basePath: props.indexerBasePath,
        chainId: props.chainId,
        owner: props.wallet!,
        signal,
      }).then((page) => page.items),
  );
  if (!props.enabled)
    return (
      <Notice title="链上活动未启用" detail="当前运行配置未开放索引服务。" />
    );
  if (props.wallet === null)
    return (
      <Notice
        title="连接钱包查看链上活动"
        detail="这里只展示与当前钱包有关的已索引事件。"
      />
    );
  if (state.error !== "")
    return <Notice title="链上活动读取失败" detail={state.error} error />;
  if (state.loading)
    return (
      <Notice
        title="正在读取链上活动…"
        detail="索引服务正在返回确认与未确认事件。"
      />
    );
  if (state.items.length === 0)
    return (
      <Notice
        title="暂无链上活动"
        detail="创建、购买、C2C、终局或领取后会显示在这里。"
      />
    );
  return (
    <div className="indexed-list">
      {state.items.map((item) => (
        <ActivityRow
          key={`${item.transactionHash}:${item.logIndex}`}
          item={item}
          explorerOrigin={props.explorerOrigin}
          paymentTokenSymbol={props.paymentTokenSymbol}
          onOpenMarket={props.onOpenMarket}
        />
      ))}
    </div>
  );
}

export function WalletPositionsPanel(props: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  wallet: Address | null;
  livePositions?: readonly LiveWalletPosition[];
  targetBlock?: bigint | null;
  onOpenMarket: (market: Address) => void;
}) {
  const state = useWalletPositions({
    enabled: props.enabled,
    indexerBasePath: props.indexerBasePath,
    chainId: props.chainId,
    wallet: props.wallet,
    targetBlock: props.targetBlock ?? null,
  });
  return (
    <WalletPositionsView
      enabled={props.enabled}
      wallet={props.wallet}
      livePositions={props.livePositions ?? []}
      targetBlock={props.targetBlock ?? null}
      state={state}
      onOpenMarket={props.onOpenMarket}
    />
  );
}

export function WalletPositionsView(props: {
  enabled: boolean;
  wallet: Address | null;
  livePositions: readonly LiveWalletPosition[];
  targetBlock: bigint | null;
  state: WalletPositionsState;
  onOpenMarket: (market: Address) => void;
}) {
  if (!props.enabled)
    return (
      <Notice
        title="跨市场持仓未启用"
        detail="当前运行配置未开放索引服务；已选择市场的链上余额仍可读取。"
      />
    );
  if (props.wallet === null)
    return (
      <Notice
        title="连接钱包查看持仓"
        detail="连接后会汇总所有已索引市场的非零 ERC-1155 余额。"
      />
    );
  const items = mergeWalletPositions(props.state.items, props.livePositions);
  const caughtUp = indexerCaughtUp(props.state.syncStatus, props.targetBlock);
  const statusNotice =
    props.state.error !== "" ? (
      <Notice
        title="持仓目录暂不可用"
        detail={`${props.state.error}；正在自动重试，链上已确认的当前市场持仓仍会保留。`}
        error
      />
    ) : !caughtUp ? (
      <Notice
        title="持仓目录同步中"
        detail={syncDetail(props.state.syncStatus, props.targetBlock)}
      />
    ) : null;
  if (items.length > 0) {
    return (
      <>
        {statusNotice}
        <div className="position-catalog">
          {items.map((item) => (
            <PositionCard
              key={`${item.vault}:${item.outcomeId}`}
              item={item}
              syncing={!caughtUp}
              onOpenMarket={props.onOpenMarket}
            />
          ))}
        </div>
      </>
    );
  }
  if (props.state.error !== "") return statusNotice;
  if (props.state.syncStatus === null)
    return (
      <Notice
        title="正在读取持仓…"
        detail="正在检查索引服务健康状态与同步高度。"
      />
    );
  if (!caughtUp) return statusNotice;
  return (
    <Notice
      title="暂无非零持仓"
      detail="索引服务已同步到当前安全区块；购买一级份额或成交 C2C 挂单后会显示。"
    />
  );
}

export function ListingsPanel(props: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  paymentTokenSymbol: string;
  selectedListingId: Hex | null;
  refreshVersion: number;
  vault?: Address | null;
  targetBlock?: bigint | null;
  marketObservedAt?: bigint | null;
  marketCloseAt?: bigint | null;
  onSelectListing: (listing: IndexedListing) => void;
}) {
  const vault = props.vault ?? null;
  const state = useActiveListings({
    enabled: props.enabled && vault !== null,
    indexerBasePath: props.indexerBasePath,
    chainId: props.chainId,
    refreshVersion: props.refreshVersion,
    vault,
    targetBlock: props.targetBlock ?? null,
  });
  if (!props.enabled)
    return (
      <Notice
        title="C2C 挂单目录未启用"
        detail="当前运行配置未开放索引服务。"
      />
    );
  if (vault === null)
    return (
      <Notice
        title="先选择 C2C 市场"
        detail="选择 Vault 后只显示该市场的活跃挂单。"
      />
    );
  if (state.error !== "")
    return <Notice title="C2C 挂单读取失败" detail={state.error} error />;
  const caughtUp = indexerCaughtUp(state.syncStatus, props.targetBlock ?? null);
  if (state.loading && state.items.length === 0)
    return <Notice title="正在读取活跃挂单…" detail="请稍候。" />;
  if (props.marketObservedAt == null || props.marketCloseAt == null)
    return (
      <Notice
        title="正在确认市场阶段"
        detail="读取封盘时间后再展示可成交挂单。"
      />
    );
  if (!caughtUp) {
    return (
      <>
        <Notice
          title="挂单目录同步中"
          detail={listingSyncDetail(
            state.syncStatus,
            props.targetBlock ?? null,
          )}
        />
        {state.items.length === 0 ? null : (
          <ActiveListingsCatalog
            items={state.items}
            paymentTokenSymbol={props.paymentTokenSymbol}
            selectedListingId={props.selectedListingId}
            observedAt={props.marketObservedAt}
            closeAt={props.marketCloseAt}
            onSelectListing={props.onSelectListing}
          />
        )}
      </>
    );
  }
  return (
    <ActiveListingsCatalog
      items={state.items}
      paymentTokenSymbol={props.paymentTokenSymbol}
      selectedListingId={props.selectedListingId}
      observedAt={props.marketObservedAt}
      closeAt={props.marketCloseAt}
      onSelectListing={props.onSelectListing}
    />
  );
}

export function ActiveListingsCatalog(props: {
  items: readonly IndexedListing[];
  paymentTokenSymbol: string;
  selectedListingId: Hex | null;
  observedAt: bigint;
  closeAt: bigint;
  onSelectListing: (listing: IndexedListing) => void;
}) {
  const visibleItems: IndexedListing[] = [];
  let foldedCount = 0;
  for (const item of props.items) {
    if (
      shouldFoldListingBeforeClose(
        item.unitPrice,
        props.observedAt,
        props.closeAt,
      )
    ) {
      foldedCount += 1;
    } else {
      visibleItems.push(item);
    }
  }

  if (visibleItems.length === 0) {
    return foldedCount === 0 ? (
      <Notice title="暂无活跃挂单" detail="创建挂单后会直接显示在这里。" />
    ) : (
      <Notice
        title={`${foldedCount} 笔高价挂单已折叠`}
        detail={`封盘前一级池按 1 ${props.paymentTokenSymbol}/份供应，池子直买更便宜；封盘后这些挂单会恢复显示。`}
      />
    );
  }

  return (
    <>
      {foldedCount === 0 ? null : (
        <Notice
          title={`${foldedCount} 笔高价挂单已折叠`}
          detail={`封盘前一级池按 1 ${props.paymentTokenSymbol}/份供应，池子直买更便宜；封盘后这些挂单会恢复显示。`}
        />
      )}
      <div className="listing-catalog">
        {visibleItems.map((item) => (
          <ListingCard
            key={item.listingId}
            item={item}
            paymentTokenSymbol={props.paymentTokenSymbol}
            selected={item.listingId === props.selectedListingId}
            onSelect={props.onSelectListing}
          />
        ))}
      </div>
    </>
  );
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
  return (
    <div className="indexed-row">
      <span
        className={`status-dot ${props.item.confirmationStatus === "confirmed" ? "success" : "warning"}`}
      />
      <div>
        <strong>{labels[props.item.kind]}</strong>
        <small>
          {short(props.item.vault)} · 区块 {props.item.blockNumber.toString()}
        </small>
      </div>
      <span>{formatActivityValue(props.item, props.paymentTokenSymbol)}</span>
      <button
        type="button"
        className="text-button"
        onClick={() => props.onOpenMarket(props.item.vault)}
      >
        打开市场
      </button>
      <a
        href={`${props.explorerOrigin}/tx/${props.item.transactionHash}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="在区块浏览器查看交易"
      >
        ↗
      </a>
    </div>
  );
}

function PositionCard(props: {
  item: DisplayPosition;
  syncing: boolean;
  onOpenMarket: (market: Address) => void;
}) {
  const claimableWinner = isClaimableWinningPosition(props.item);
  const status =
    props.item.source === "live"
      ? `链上已确认${props.syncing ? " · 目录同步中" : ""}`
      : props.item.confirmationStatus === "confirmed"
        ? "已确认"
        : "待确认";
  return (
    <article>
      <small>
        {claimableWinner ? "获胜结果" : "结果"}{" "}
        {(props.item.outcomeId + 1n).toString()} · {status}
      </small>
      <strong>{formatShares(props.item.balance)} 份</strong>
      {claimableWinner ? (
        <span className="position-claim-note">胜出款待领取</span>
      ) : null}
      <span className="mono">{short(props.item.vault)}</span>
      {claimableWinner ? (
        <a
          className="button primary wide button-link"
          href={`#/settlement/${props.item.vault}`}
        >
          去领取胜出款
        </a>
      ) : (
        <button
          type="button"
          className="text-button"
          onClick={() => props.onOpenMarket(props.item.vault)}
        >
          查看市场
        </button>
      )}
    </article>
  );
}

function useWalletPositions(input: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  wallet: Address | null;
  targetBlock: bigint | null;
}): WalletPositionsState {
  const identity =
    input.enabled && input.wallet !== null
      ? `${input.indexerBasePath}:${input.chainId}:${input.wallet.toLowerCase()}`
      : null;
  const [state, setState] = useState<WalletPositionsState>(() =>
    emptyPositionsState(identity),
  );
  useEffect(() => {
    if (identity === null || input.wallet === null) {
      setState(emptyPositionsState(null));
      return;
    }
    const wallet = input.wallet;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        // Read sync status first: if it is caught up, the subsequent position read cannot
        // predate the checkpoint that made an empty result authoritative.
        const syncStatus = await fetchIndexerSyncStatus({
          basePath: input.indexerBasePath,
          chainId: input.chainId,
          signal: controller.signal,
        });
        const page = await fetchWalletPositions({
          basePath: input.indexerBasePath,
          chainId: input.chainId,
          owner: wallet,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState({
          identity,
          items: page.items.filter((item) => item.balance > 0n),
          syncStatus,
          error: "",
        });
        if (!indexerCaughtUp(syncStatus, input.targetBlock))
          timer = window.setTimeout(() => void poll(), POSITION_SYNC_POLL_MS);
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause.message : "未知错误";
        setState((current) =>
          current.identity === identity
            ? { ...current, error }
            : { ...emptyPositionsState(identity), error },
        );
        timer = window.setTimeout(() => void poll(), POSITION_SYNC_POLL_MS);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    identity,
    input.chainId,
    input.indexerBasePath,
    input.targetBlock,
    input.wallet,
  ]);
  return state.identity === identity ? state : emptyPositionsState(identity);
}

export function indexerCaughtUp(
  status: IndexerSyncStatus | null,
  targetBlock: bigint | null,
): boolean {
  if (status?.indexedBlock === null || status === null) return false;
  const requiredBlock =
    targetBlock !== null && targetBlock > status.safeBlock
      ? targetBlock
      : status.safeBlock;
  return status.indexedBlock >= requiredBlock;
}

interface ActiveListingsState {
  identity: string | null;
  items: readonly IndexedListing[];
  syncStatus: IndexerSyncStatus | null;
  loading: boolean;
  error: string;
}

function emptyListingsState(identity: string | null): ActiveListingsState {
  return {
    identity,
    items: [],
    syncStatus: null,
    loading: identity !== null,
    error: "",
  };
}

function useActiveListings(input: {
  enabled: boolean;
  indexerBasePath: string;
  chainId: number;
  refreshVersion: number;
  vault: Address | null;
  targetBlock: bigint | null;
}): ActiveListingsState {
  const identity =
    input.enabled && input.vault !== null
      ? `${input.indexerBasePath}:${input.chainId}:${input.vault.toLowerCase()}:${input.refreshVersion}`
      : null;
  const [state, setState] = useState<ActiveListingsState>(() =>
    emptyListingsState(identity),
  );
  useEffect(() => {
    if (identity === null || input.vault === null) {
      setState(emptyListingsState(null));
      return;
    }
    const vault = input.vault;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const syncStatus = await fetchIndexerSyncStatus({
          basePath: input.indexerBasePath,
          chainId: input.chainId,
          signal: controller.signal,
        });
        const page = await fetchListings({
          basePath: input.indexerBasePath,
          chainId: input.chainId,
          vault,
          active: true,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState({
          identity,
          items: page.items,
          syncStatus,
          loading: false,
          error: "",
        });
        if (!indexerCaughtUp(syncStatus, input.targetBlock))
          timer = window.setTimeout(() => void poll(), POSITION_SYNC_POLL_MS);
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause.message : "未知错误";
        setState((current) =>
          current.identity === identity
            ? { ...current, loading: false, error }
            : { ...emptyListingsState(identity), loading: false, error },
        );
        timer = window.setTimeout(() => void poll(), POSITION_SYNC_POLL_MS);
      }
    };
    setState(emptyListingsState(identity));
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    identity,
    input.chainId,
    input.indexerBasePath,
    input.refreshVersion,
    input.targetBlock,
    input.vault,
  ]);
  return state.identity === identity ? state : emptyListingsState(identity);
}

function listingSyncDetail(
  status: IndexerSyncStatus | null,
  targetBlock: bigint | null,
): string {
  if (status === null)
    return "正在确认索引服务健康状态与同步高度；链上成交结果以选中挂单卡片为准。";
  const requiredBlock =
    targetBlock !== null && targetBlock > status.safeBlock
      ? targetBlock
      : status.safeBlock;
  const indexed =
    status.indexedBlock === null
      ? "尚未建立 checkpoint"
      : `已处理区块 ${status.indexedBlock.toString()}`;
  return `索引服务 ${indexed}，目标区块 ${requiredBlock.toString()}；追上前可能仍显示已成交挂单。`;
}

export function mergeWalletPositions(
  indexed: readonly IndexedPosition[],
  live: readonly LiveWalletPosition[],
): readonly DisplayPosition[] {
  const liveKeys = new Set(live.map(positionKey));
  return [
    ...indexed
      .filter((item) => !liveKeys.has(positionKey(item)))
      .map((item) => ({ ...item, source: "indexer" as const })),
    ...live
      .filter((item) => item.balance > 0n)
      .map((item) => ({
        ...item,
        confirmationStatus: "confirmed" as const,
        source: "live" as const,
      })),
  ].filter(isActiveHolding);
}

const RESOLVED_MARKET_STATE = 1;

export function isClaimableWinningPosition(position: {
  balance: bigint;
  outcomeId: bigint | number;
  marketState?: number | null;
  winningOutcome?: bigint | number | null;
}): boolean {
  return (
    position.balance > 0n &&
    position.marketState === RESOLVED_MARKET_STATE &&
    position.winningOutcome !== null &&
    position.winningOutcome !== undefined &&
    BigInt(position.outcomeId) === BigInt(position.winningOutcome)
  );
}

/** Holdings keep claimable/tradable shares; resolved losing outcomes stay off the list. */
export function isActiveHolding(position: {
  balance: bigint;
  outcomeId: bigint | number;
  marketState?: number | null;
  winningOutcome?: bigint | number | null;
}): boolean {
  if (position.balance <= 0n) return false;
  if (position.marketState !== RESOLVED_MARKET_STATE) return true;
  if (position.winningOutcome === null || position.winningOutcome === undefined)
    return true;
  return isClaimableWinningPosition(position);
}

function positionKey(item: { vault: Address; outcomeId: bigint }): string {
  return `${item.vault.toLowerCase()}:${item.outcomeId.toString()}`;
}

function emptyPositionsState(identity: string | null): WalletPositionsState {
  return { identity, items: [], syncStatus: null, error: "" };
}

function syncDetail(
  status: IndexerSyncStatus | null,
  targetBlock: bigint | null,
): string {
  if (status === null)
    return "正在确认索引服务健康状态与同步高度；链上已确认的当前市场持仓会先行显示。";
  const requiredBlock =
    targetBlock !== null && targetBlock > status.safeBlock
      ? targetBlock
      : status.safeBlock;
  const indexed =
    status.indexedBlock === null
      ? "尚未建立 checkpoint"
      : `已处理区块 ${status.indexedBlock.toString()}`;
  return `索引服务 ${indexed}，目标区块 ${requiredBlock.toString()}；同步完成前不会显示空状态。`;
}

export function ListingCard(props: {
  item: IndexedListing;
  paymentTokenSymbol: string;
  selected: boolean;
  onSelect: (listing: IndexedListing) => void;
}) {
  return (
    <article className={props.selected ? "selected" : undefined}>
      <div>
        <span className="status-pill">
          出售结果 {(props.item.outcomeId + 1n).toString()}
        </span>
        <small>
          {props.item.confirmationStatus === "confirmed" ? "已确认" : "待确认"}
        </small>
      </div>
      <strong>
        {formatShares(props.item.remainingUnits)} 份 ×{" "}
        {formatPayment(props.item.unitPrice, props.paymentTokenSymbol)}
      </strong>
      <span className="mono">Vault {short(props.item.vault)}</span>
      <small className="mono">挂单 {short(props.item.listingId)}</small>
      <small>
        到期{" "}
        {new Date(Number(props.item.expiresAt) * 1_000).toLocaleString(
          "zh-CN",
          { hour12: false },
        )}
      </small>
      <button
        type="button"
        className="button"
        aria-pressed={props.selected}
        onClick={() => props.onSelect(props.item)}
      >
        {props.selected ? "已选择" : "选择此挂单"}
      </button>
    </article>
  );
}

function Notice(props: { title: string; detail: string; error?: boolean }) {
  return (
    <div
      className={props.error === true ? "catalog-empty error" : "catalog-empty"}
    >
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
    </div>
  );
}

function useIndexerList<T>(
  enabled: boolean,
  dependencies: readonly unknown[],
  load: (signal: AbortSignal) => Promise<readonly T[]>,
) {
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
    void load(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setItems(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setItems([]);
          setError(cause instanceof Error ? cause.message : "未知错误");
        }
      })
      .finally(() => {
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
  const fraction = (value % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${value / base}${fraction === "" ? "" : `.${fraction}`}`;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
