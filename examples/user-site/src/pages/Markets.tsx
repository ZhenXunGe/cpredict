import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Search, ArrowRight, Clock3 } from "lucide-react";
import { useSession } from "../wallets.js";
import {
  useMarkets,
  useRules,
  dateText,
  marketStatusCopy,
  type Market,
} from "../data.js";
import {
  Amount,
  Button,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageTitle,
  shortAddress,
} from "../ui.js";
export function MarketsPage() {
  const { api } = useSession(),
    [params, setParams] = useSearchParams(),
    [search, setSearch] = useState(params.get("q") ?? "");
  const status = params.get("status") ?? "",
    query = useMarkets(status, params.get("q") ?? "");
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams(params);
    search.trim() ? next.set("q", search.trim()) : next.delete("q");
    setParams(next);
  };
  return (
    <>
      <PageTitle
        title="探索市场"
        description="选择你关注的问题，阅读规则后开始测试。"
        action={
          <Link
            className="button button-primary"
            to={`/${api.environment.id}/creator/new`}
          >
            <Plus size={17} />
            创建市场
          </Link>
        }
      />
      <Notice tone="warning">
        {api.environment.asset}{" "}
        是测试资产，不具有真实货币价值。市场由创建者决定结果，请先阅读结算规则。
      </Notice>
      <form className="toolbar" onSubmit={submit}>
        <div className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="搜索市场标题或地址"
            placeholder="搜索市场标题或地址"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={120}
          />
        </div>
        <Button variant="secondary" type="submit">
          搜索
        </Button>
        <select
          aria-label="筛选市场状态"
          value={status}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            e.target.value
              ? next.set("status", e.target.value)
              : next.delete("status");
            setParams(next);
          }}
        >
          <option value="">全部状态</option>
          <option value="open">尚未结算</option>
          <option value="resolved">已结算</option>
          <option value="voided">已作废</option>
        </select>
      </form>
      {(query.data?.pages[0]?.metadataPending ?? 0) > 0 && (
        <Notice>
          有 {query.data?.pages[0]?.metadataPending}{" "}
          个市场的规则标题尚未验证。标题搜索暂未覆盖这些市场，可按地址查询。
        </Notice>
      )}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : items.length ? (
        <div className="market-list">
          {items.map((m) => (
            <MarketRow market={m} key={m.market} />
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty
            title={
              params.get("q") || status
                ? "没有找到符合条件的市场"
                : "还没有公开测试市场"
            }
          >
            新市场发布后会显示在这里，你也可以创建自己的测试市场。
          </Empty>
        )
      )}
      {query.hasNextPage && (
        <div className="pagination">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "正在加载" : "加载更多市场"}
          </Button>
        </div>
      )}
    </>
  );
}
export function MarketRow({ market: m }: { market: Market }) {
  const { api } = useSession(),
    rules = useRules(m);
  return (
    <article className="market-row">
      <div className="market-row-main">
        <Link
          className="market-title"
          to={`/${api.environment.id}/markets/${m.market}`}
        >
          {rules.data?.question ??
            m.question ??
            `市场 ${shortAddress(m.market)}`}
        </Link>
        <div className="market-meta">
          <span>创建者 {shortAddress(m.creator)}</span>
          <span>
            {rules.data
              ? "规则哈希已核对"
              : rules.isPending
                ? "正在读取规则"
                : "规则暂不可验证"}
          </span>
        </div>
        <div className="outcomes">
          {rules.data?.outcomes.map((name, i) => (
            <span className="outcome" key={i}>
              {name}
            </span>
          )) ?? (
            <span className="muted small">
              {m.outcomeCount === null
                ? "结果选项待同步"
                : `${m.outcomeCount} 个结果选项`}
            </span>
          )}
        </div>
      </div>
      <div className="market-row-details">
        <span
          className={`status status-${m.state === 1 ? "resolved" : m.state === 2 ? "voided" : "open"}`}
        >
          {marketStatusCopy(m)}
        </span>
        <div className="market-meta">
          <Clock3 size={13} aria-hidden="true" />
          <span>{dateText(m.closeAt)}</span>
        </div>
        <div className="market-meta">
          <span>
            一级投入{" "}
            <Amount value={m.primaryPayment} asset={api.environment.asset} />
          </span>
        </div>
      </div>
      <Link
        className="button button-secondary row-action"
        to={`/${api.environment.id}/markets/${m.market}`}
      >
        查看 <ArrowRight size={15} />
      </Link>
    </article>
  );
}
