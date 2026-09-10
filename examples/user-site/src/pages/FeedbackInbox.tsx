import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  feedbackPageSchema,
  feedbackQuerySchema,
} from "../../../../offchain/app-core/src/report-contracts.js";
import { useSession } from "../wallets.js";
import { Button, Empty, ErrorNotice, Field, Loading } from "../ui.js";

/** Mounted only inside the administrator view; server authentication is mandatory. */
export function FeedbackInbox() {
  const { api, authenticated, opsRead } = useSession();
  const [id, setId] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: [api.key, "ops-feedback", filter],
    enabled: authenticated && opsRead,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "30" });
      if (filter) params.set("id", filter);
      if (pageParam) params.set("cursor", pageParam);
      return api.request(`/v1/ops/feedback?${params}`, feedbackPageSchema, {
        auth: true,
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: 1,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="surface stack" aria-labelledby="feedback-inbox-heading">
      <h2 id="feedback-inbox-heading">测试反馈</h2>
      <p>由本环境的只读管理员查看与追溯。这里保留用户原始提交内容。</p>
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const value = id.trim();
          if (
            !feedbackQuerySchema.safeParse(value ? { id: value } : {}).success
          ) {
            setError("请输入有效的反馈编号。");
            return;
          }
          setError(null);
          setFilter(value);
        }}
      >
        <Field label="反馈编号（留空查看全部）">
          <input value={id} onChange={(event) => setId(event.target.value)} />
        </Field>
        <Button type="submit">查询反馈</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {query.isPending ? <Loading /> : <ErrorNotice error={query.error} />}
      {!query.isPending && !query.error && !items.length ? (
        <Empty title="没有符合条件的反馈" />
      ) : null}
      {items.map((item) => (
        <article key={item.id}>
          <p>
            <time dateTime={item.receivedAt}>
              {new Date(item.receivedAt).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}
            </time>{" "}
            · 编号：{item.id}
          </p>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {item.message}
          </p>
          {item.operationId || item.accountId ? (
            <details>
              <summary>关联记录</summary>
              <p>操作编号：{item.operationId ?? "未提供"}</p>
              <p>账户编号：{item.accountId ?? "未提供"}</p>
            </details>
          ) : null}
        </article>
      ))}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          更多反馈
        </Button>
      ) : null}
    </section>
  );
}
