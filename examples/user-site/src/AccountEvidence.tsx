import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatUnits } from "viem";
import {
  claimReceiptsSchema,
  sponsoredGasSchema,
} from "../../../offchain/app-core/src/orderbook-contracts.js";
import { useSession } from "./wallets.js";
import { usePaginatedList } from "./pagination.js";
import {
  Amount,
  DataTable,
  ErrorNotice,
  Loading,
  Notice,
  PaginationControls,
  shortAddress,
} from "./ui.js";
import { dateText } from "./data.js";

const labels: Record<string, string> = {
  "winner-claimed": "赢家收益",
  "early-bird-claimed": "早鸟奖励",
  refunded: "本金退款",
  "timeout-claimed": "超时补偿",
  "fee-claimed": "费用收入",
  "bond-claimed": "可退押金",
};
Object.assign(labels, {
  "claim-winner": "赢家收益领取",
  "claim-early-bird": "早鸟奖励领取",
  "claim-refund": "本金退款领取",
  "claim-timeout": "超时补偿领取",
  "claim-fees": "费用领取",
  "claim-bond": "押金领取",
  "release-order": "订单资产返还",
  "create-order": "创建订单",
  "fill-order": "接单",
  "cancel-order": "撤单",
  buy: "购买份额",
  faucet: "领取测试币",
  "create-market": "创建市场",
});
const sources = {
  automatic: "自动领取",
  manual: "手动领取",
  direct: "链上直接领取",
  unknown: "来源待核验",
};
export function AccountEvidencePanel({ active = false }: { active?: boolean }) {
  const { api, account } = useSession();
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const scope = `${api.key}:${account?.id ?? "signed-out"}`;
  const receipts = useInfiniteQuery({
    queryKey: [api.key, "claim-receipts", account?.id],
    enabled: !!account,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v1/claim-receipts?accountId=${account!.id}&limit=10${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        claimReceiptsSchema,
        { auth: true, signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: visible ? (active ? 2000 : 5000) : false,
    refetchIntervalInBackground: false,
  });
  const gas = useInfiniteQuery({
    queryKey: [api.key, "sponsored-gas", account?.id],
    enabled: !!account,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v1/sponsored-gas?accountId=${account!.id}&limit=10${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        sponsoredGasSchema,
        { auth: true, signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: (q) =>
      visible
        ? active || q.state.data?.pages[0]?.pendingCount
          ? 2000
          : 5000
        : false,
    refetchIntervalInBackground: false,
  });
  const received = usePaginatedList({
    pages: receipts.data?.pages.map((p) => p.items) ?? [],
    pageSize: 10,
    scope,
    hasMore: !!receipts.hasNextPage,
    isLoadingMore: receipts.isFetchingNextPage,
    loadMore: receipts.fetchNextPage,
  });
  const fees = usePaginatedList({
    pages: gas.data?.pages.map((p) => p.items) ?? [],
    pageSize: 10,
    scope,
    hasMore: !!gas.hasNextPage,
    isLoadingMore: gas.isFetchingNextPage,
    loadMore: gas.fetchNextPage,
  });
  const total = gas.data?.pages[0];
  const chainLink = (hash: string) => (
    <a
      href={`${api.environment.explorerUrl}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      查看
    </a>
  );
  if (!account) return null;
  return (
    <>
      <section className="card" aria-label="平台代付 Gas">
        <h2>平台代付 Gas</h2>
        {gas.isPending && <Loading label="正在核验代付费用" />}
        {total && (
          <>
            <p>
              本环境已核实代付：
              <strong style={{ overflowWrap: "anywhere" }}>
                {formatUnits(BigInt(total.knownActualWei), 18)} ETH
              </strong>
            </p>
            {total.totalActualWei === null && (
              <Notice>
                部分费用待核验（{total.missingCount}{" "}
                项）；当前显示已核实费用，不代表完整累计。
              </Notice>
            )}
            {total.pendingCount > 0 && (
              <p>有 {total.pendingCount} 笔操作等待费用确认。</p>
            )}
            <p className="small muted">
              本环境公共撮合／维护代付：
              {formatUnits(BigInt(total.shared.knownActualWei), 18)}{" "}
              ETH，单独统计，不分摊到个人。
              {total.shared.totalActualWei === null
                ? "公共费用仍有待核验项目。"
                : ""}
            </p>
            <details>
              <summary>查看个人代付明细</summary>
              <DataTable
                headers={["操作", "时间（上海）", "实际代付", "链上记录"]}
              >
                {fees.items.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {labels[f.kind] ?? f.kind}
                      {f.state === "reverted" && <div>交易执行失败</div>}
                    </td>
                    <td>
                      {dateText(
                        String(Math.floor(Date.parse(f.timestamp) / 1000)),
                      )}
                    </td>
                    <td style={{ overflowWrap: "anywhere" }}>
                      {f.actualGasCostWei === null
                        ? "待核验"
                        : `${formatUnits(BigInt(f.actualGasCostWei), 18)} ETH`}
                    </td>
                    <td>{chainLink(f.transactionHash)}</td>
                  </tr>
                ))}
              </DataTable>
              <PaginationControls
                ariaLabel="代付费用分页"
                page={fees.page}
                hasPrevious={fees.hasPrevious}
                hasNext={fees.hasNext}
                busy={fees.isLoading}
                onPrevious={fees.previous}
                onNext={() => void fees.next()}
              />
            </details>
          </>
        )}
        <ErrorNotice error={gas.error} retry={() => void gas.refetch()} />
      </section>
      <section className="card" aria-label="已到账记录">
        <h2>已到账记录</h2>
        <p className="small muted">
          包含手动、自动及链上直接领取；金额以已索引的链上到账事实为准。同一操作的
          Gas 仅累计一次。
        </p>
        {receipts.isPending && <Loading label="正在读取到账记录" />}
        {received.items.length ? (
          <DataTable
            headers={[
              "类型",
              "市场",
              "来源",
              "实际到账",
              "到账时间（上海）",
              "本次操作代付 Gas",
              "链上记录",
            ]}
          >
            {received.items.map((r) => (
              <tr key={r.fact.id}>
                <td>{labels[r.fact.kind] ?? r.fact.kind}</td>
                <td>
                  {r.fact.market ? (
                    <Link
                      to={`/${api.environment.id}/markets/${r.fact.market}`}
                    >
                      {r.marketQuestion ?? shortAddress(r.fact.market)}
                    </Link>
                  ) : (
                    "账户汇总"
                  )}
                </td>
                <td>{sources[r.source]}</td>
                <td>
                  <Amount value={r.fact.amount} asset={api.environment.asset} />
                </td>
                <td>{dateText(r.fact.timestamp)}</td>
                <td style={{ overflowWrap: "anywhere" }}>
                  {r.actualGasCostWei === null
                    ? r.gasPayment === "sponsored"
                      ? "费用待核验"
                      : "—"
                    : `${formatUnits(BigInt(r.actualGasCostWei), 18)} ETH`}
                </td>
                <td>{chainLink(r.fact.transactionHash)}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          !receipts.isPending && !receipts.error && <p>暂无已到账记录。</p>
        )}
        <PaginationControls
          ariaLabel="已到账记录分页"
          page={received.page}
          hasPrevious={received.hasPrevious}
          hasNext={received.hasNext}
          busy={received.isLoading}
          onPrevious={received.previous}
          onNext={() => void received.next()}
        />
        <ErrorNotice
          error={receipts.error}
          retry={() => void receipts.refetch()}
        />
      </section>
    </>
  );
}
