import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatEther } from "viem";
import { depositPageSchema } from "../../../offchain/app-core/src/contracts.js";
import { useSession } from "./wallets.js";
import { operationStateCopy } from "./operations.js";
import {
  AddressText,
  Amount,
  Button,
  Empty,
  ErrorNotice,
  Loading,
} from "./ui.js";

/** Uses signature-free deposit records; balance and PnL remain owned by the transfer ledger. */
export function DepositHistory({
  range,
}: {
  range?: { start: string; end: string };
}) {
  const { api, account, identityKey, opsRead, authenticated } = useSession();
  const query = useInfiniteQuery({
    queryKey: [api.key, "deposit-history", identityKey, range ?? account?.id],
    enabled: authenticated && (range ? opsRead : !!account),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams(range ?? { accountId: account!.id });
      q.set("limit", "20");
      if (pageParam) q.set("cursor", pageParam);
      return api.request(
        `/v1/${range ? "ops/" : ""}deposits?${q}`,
        depositPageSchema,
        { auth: true, signal },
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15000,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="surface stack">
      <h2>{range ? "USDC 入金对账" : "USDC 入金记录"}</h2>
      <p className="small">
        金额按 USDC
        转账事件入账。此处展示授权流程与对应操作，不重复计入余额或交易收益。实际
        Gas 来自单个 UserOperation，供应商账单另行核对。
      </p>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <Loading />}
      {query.data && !items.length && <Empty title="暂无入金记录" />}
      {items.map((d) => (
        <article
          className="stack"
          key={d.id}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}
        >
          <strong>
            <Amount value={d.authorization.value} asset="USDC" /> ·{" "}
            {d.state === "awaiting-authorization"
              ? "等待资金钱包授权"
              : d.state === "expired"
                ? "授权已过期"
                : operationStateCopy[d.state]}
          </strong>
          <p className="small">
            <AddressText value={d.authorization.from} /> →{" "}
            <AddressText value={d.account} /> ·{" "}
            {new Date(d.createdAt).toLocaleString()}
          </p>
          <p className="small">
            实际网络 Gas：
            {d.actualGasCost === null
              ? "等待回执"
              : `${formatEther(BigInt(d.actualGasCost))} ETH`}{" "}
            ·{" "}
            {d.finality === "finalized"
              ? "已最终确认"
              : d.finality === "application-confirmed"
                ? "已达应用确认数"
                : "等待链上确认"}
          </p>
          {d.reason && <p className="small">状态原因：{d.reason}</p>}
          {!range && d.operationId && (
            <Link
              to={`/${api.environment.id}/history?operation=${d.operationId}`}
            >
              查询原入金操作
            </Link>
          )}
          <details>
            <summary>入金与链上标识</summary>
            <dl className="data-list">
              <dt>入金 ID</dt>
              <dd>
                <code>{d.id}</code>
              </dd>
              <dt>授权 nonce</dt>
              <dd>
                <code>{d.authorization.nonce}</code>
              </dd>
              <dt>操作 ID</dt>
              <dd>{d.operationId ?? "尚未登记"}</dd>
              <dt>UserOperation</dt>
              <dd>
                <code>{d.userOperationHash ?? "尚未提交"}</code>
              </dd>
              <dt>交易</dt>
              <dd>
                {d.transactionHash ? (
                  <a
                    href={`${api.environment.explorerUrl}/tx/${d.transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <code>{d.transactionHash}</code>
                  </a>
                ) : (
                  "尚无回执"
                )}
              </dd>
              <dt>确认区块</dt>
              <dd>{d.blockNumber ?? "尚无回执"}</dd>
            </dl>
          </details>
        </article>
      ))}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          更多入金记录
        </Button>
      )}
    </section>
  );
}
