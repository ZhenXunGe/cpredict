import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatEther } from "viem";
import {
  leaderboardPageSchema,
  opsReportSchema,
  feedbackSchema,
} from "../../../../offchain/app-core/src/report-contracts.js";
import { z } from "zod";
import { useSession } from "../wallets.js";
import { AccountGate } from "../operations.js";
import {
  AddressText,
  Amount,
  Button,
  DataTable,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageTitle,
} from "../ui.js";
import { dateText } from "../data.js";
import { FeedbackInbox } from "./FeedbackInbox.js";
import { ProviderStatus } from "./ProviderStatus.js";
export function LeaderboardPage() {
  const { api, account } = useSession(),
    [period, setPeriod] = useState("");
  const query = useInfiniteQuery({
    queryKey: [api.key, "leaderboards", period],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.request(
        `/v2/leaderboards?limit=30${period ? `&period=${encodeURIComponent(period)}` : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        leaderboardPageSchema,
        { service: "indexer", signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60000,
  });
  const first = query.data?.pages[0],
    snapshot = first?.snapshot,
    items = query.data?.pages.flatMap((p) => p.items) ?? [],
    excluded = snapshot?.excluded.find(
      (e) => e.account.toLowerCase() === account?.address.toLowerCase(),
    );
  const descriptions = {
    disabled: "排行榜暂未开放。",
    "awaiting-roster": "首期测试市场名单尚未公布。",
    "awaiting-snapshot": "市场名单已公布，正在等待完整数据与统一统计区块。",
    available: "",
    "correction-pending": "检测到链重组或历史更正，正在重新生成榜单快照。",
  };
  return (
    <>
      <PageTitle
        title="测试排行榜"
        description="指定市场内的已实现净收益金额。没有奖励，仅用于公开测试。"
      />
      <Notice tone="warning">
        ctUSD
        可公开铸造，关联账户也无法被完全识别。测试榜单不能证明投资能力，收益不是实际货币收入。
      </Notice>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <Loading />}
      {first && (
        <>
          <Field label="统计期间">
            <select
              value={period || first.periods[0]?.id || ""}
              onChange={(e) => setPeriod(e.target.value)}
            >
              {first.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {dateText(p.startsAt)} — {dateText(p.endsAt)}
                </option>
              ))}
            </select>
          </Field>
          {first.status !== "available" && (
            <Empty title="等待可发布的测试榜单">
              {descriptions[first.status]}
            </Empty>
          )}
          {snapshot && (
            <section className="stack">
              <p className="small muted">
                统计范围 [{dateText(snapshot.period.startsAt)},{" "}
                {dateText(snapshot.period.endsAt)}) · 数据区块{" "}
                {snapshot.data.blockNumber} · 统计版本{" "}
                {snapshot.statisticsVersion} / 快照 {snapshot.version}
              </p>
              {snapshot.correction && (
                <Notice tone="warning">{snapshot.correction}</Notice>
              )}
              {excluded && (
                <Notice tone="warning">
                  此账户暂不入榜：{excluded.reasons.join("；")}
                  。不会把已知部分当作完整收益。
                </Notice>
              )}
              <DataTable
                headers={[
                  "名次",
                  "应用资产账户",
                  "已实现净收益",
                  "参与的计榜市场数",
                ]}
              >
                {items.map((item) => (
                  <tr key={item.account}>
                    <td>{item.rank}</td>
                    <td>
                      <AddressText
                        value={item.account}
                        explorer={api.environment.explorerUrl}
                      />
                      {item.account.toLowerCase() ===
                        account?.address.toLowerCase() && (
                        <span className="badge">当前账户</span>
                      )}
                    </td>
                    <td>
                      <Amount
                        value={item.realizedNet}
                        asset={api.environment.asset}
                        sign
                      />
                    </td>
                    <td>{item.marketCount}</td>
                  </tr>
                ))}
              </DataTable>
              {query.hasNextPage && (
                <Button
                  variant="secondary"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  更多账户
                </Button>
              )}
              <details>
                <summary>指定市场与统计规则</summary>
                <ul>
                  {snapshot.period.markets.map((m) => (
                    <li key={m.market}>
                      <Link to={`/${api.environment.id}/markets/${m.market}`}>
                        {m.market}
                      </Link>{" "}
                      · 从 {dateText(m.startsAt)} 开始计榜
                    </li>
                  ))}
                </ul>
                <p>
                  创作者和可验证由同一控制钱包控制的账户不参与自己市场的排名。充值、领币、转出、创作者费用、押金和项目代付
                  Gas 不计入交易收益。收益相同并列，按地址稳定分页。
                </p>
                <p>
                  未领取权益和当前持仓不使用估算值参与已实现收益排名。成本不完整的账户暂不入榜。
                </p>
              </details>
            </section>
          )}
        </>
      )}
    </>
  );
}
const shanghaiDay = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export function OpsPage() {
  const { api, opsRead, authenticated } = useSession(),
    [start, setStart] = useState(shanghaiDay(new Date(Date.now() - 86400000))),
    [end, setEnd] = useState(shanghaiDay(new Date())),
    [range, setRange] = useState({
      start: new Date(`${start}T00:00:00+08:00`).toISOString(),
      end: new Date(`${end}T00:00:00+08:00`).toISOString(),
    }),
    [error, setError] = useState("");
  const query = useQuery({
    queryKey: [api.key, "ops", range],
    enabled: authenticated && opsRead,
    queryFn: ({ signal }) =>
      api.request(
        `/v1/ops/reports?${new URLSearchParams(range)}`,
        opsReportSchema,
        { auth: true, signal },
      ),
    retry: 1,
  });
  const r = query.data;
  if (!authenticated)
    return (
      <>
        <PageTitle
          title="运营报表"
          description="仅对服务端授权的只读管理员开放。"
        />
        <AccountGate />
      </>
    );
  if (!opsRead)
    return <Notice tone="warning">当前登录主体没有运营报表权限。</Notice>;
  return (
    <>
      <PageTitle
        title="运营报表"
        description="只读。链上金额、用户漏斗、服务状态与费用来源分别展示。"
      />
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          const from = new Date(`${start}T00:00:00+08:00`),
            to = new Date(`${end}T00:00:00+08:00`);
          if (
            !Number.isFinite(from.getTime()) ||
            !Number.isFinite(to.getTime()) ||
            from >= to ||
            to.getTime() - from.getTime() > 32 * 86400000
          ) {
            setError("请选择 1–32 天的有效区间，结束当天不包含在内。");
            return;
          }
          setError("");
          setRange({ start: from.toISOString(), end: to.toISOString() });
        }}
      >
        <Field label="开始日期（上海）">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </Field>
        <Field label="结束日期（不含）">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </Field>
        <Button type="submit">查询报表</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <ErrorNotice error={query.error} />
      {query.isPending && <Loading />}
      {r && (
        <div className="stack">
          <Notice>
            数据区块 {r.data.indexedBlock ?? "未知"} · 链头{" "}
            {r.services.chainHead ?? "未知"} · 索引延迟{" "}
            {r.services.indexDelayBlocks ?? "未知"} 区块。
            {!r.data.coverageComplete &&
              "历史覆盖不完整，金额仅为当前已索引部分。"}
          </Notice>
          <div className="stats-grid">
            {[
              { label: "活跃资产账户", value: r.trading.activeAccounts },
              {
                label: "全部交易地址（含旧 EOA）",
                value: r.trading.activeAddresses,
              },
              {
                label: "首次成功交易账户",
                value: r.funnel.firstSuccessfulTradingAccounts,
              },
              {
                label: "未知结果操作（期间曾出现）",
                value: r.operations.unknown,
              },
              { label: "当前待恢复操作", value: r.operations.pending },
            ].map((v) => (
              <div className="stat-card" key={v.label}>
                <span>{v.label}</span>
                <strong>{v.value}</strong>
              </div>
            ))}
          </div>
          <div className="grid-two">
            <section className="surface">
              <h2>交易与收入</h2>
              <dl className="data-list">
                {[
                  { label: "一级投入", value: r.trading.primaryPayment },
                  { label: "C2C 成交总额", value: r.trading.c2cVolume },
                  { label: "协议费用产生", value: r.fees.protocolAccrued },
                  { label: "创作者费用产生", value: r.fees.creatorAccrued },
                  { label: "未分类费用", value: r.fees.unknownAccrued },
                  { label: "实际领取费用（跨市场）", value: r.fees.claimed },
                  { label: "当前累计可领取费用", value: r.fees.claimable },
                ].map((v) => (
                  <div key={v.label} style={{ display: "contents" }}>
                    <dt>{v.label}</dt>
                    <dd>
                      <Amount value={v.value} asset={api.environment.asset} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="surface">
              <h2>参与漏斗</h2>
              <dl className="data-list">
                {[
                  { label: "访问会话", value: r.funnel.visitingSessions },
                  { label: "登录主体", value: r.funnel.loginSubjects },
                  { label: "就绪应用账户", value: r.funnel.readyAccounts },
                  {
                    label: "首次成功交易账户",
                    value: r.funnel.firstSuccessfulTradingAccounts,
                  },
                  { label: "领取账户", value: r.funnel.claimingAccounts },
                  {
                    label: "领取后再投资账户",
                    value: r.funnel.reinvestingAccounts,
                  },
                ].map((v) => (
                  <div key={v.label} style={{ display: "contents" }}>
                    <dt>{v.label}</dt>
                    <dd>{v.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
          <section className="surface stack">
            <h2>Gas、预算与服务状态</h2>
            <p>
              期间 UserOperation 实际 Gas：
              <strong>
                {formatEther(BigInt(r.gas.userOperationActualWei))} ETH
              </strong>
              。供应商账单费用另列，不将整笔 Bundler 交易费用重复分摊。
            </p>
            <DataTable
              headers={[
                "每日防滥用额度",
                "已预留（ETH）",
                "剩余额度（ETH）",
                "剩余操作数",
                "业务预算重置",
              ]}
            >
              {r.budgets.map((b) => (
                <tr key={b.lane}>
                  <td>{b.lane === "exit" ? "退出操作" : "新增操作"}</td>
                  <td>{formatEther(BigInt(b.reservedWei))}</td>
                  <td>{formatEther(BigInt(b.remainingWei))}</td>
                  <td>{b.remainingOperations}</td>
                  <td>
                    {new Date(b.resetsAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                    })}
                  </td>
                </tr>
              ))}
            </DataTable>
            {r.weeklyBudget ? (
              <>
                <p>
                  本环境每周 Gas 总额{" "}
                  {formatEther(BigInt(r.weeklyBudget.projectLimitWei))} ETH，
                  北京时间周一 00:00 重置；本期截至{" "}
                  {new Date(r.weeklyBudget.end).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                  。
                </p>
                <DataTable
                  headers={[
                    "周预算",
                    "限额（ETH）",
                    "已预留（ETH）",
                    "剩余（ETH）",
                  ]}
                >
                  {r.weeklyBudget.lanes.map((b) => (
                    <tr key={b.lane}>
                      <td>{b.lane === "exit" ? "退出专用" : "新增操作"}</td>
                      <td>{formatEther(BigInt(b.limitWei))}</td>
                      <td>{formatEther(BigInt(b.reservedWei))}</td>
                      <td>{formatEther(BigInt(b.remainingWei))}</td>
                    </tr>
                  ))}
                </DataTable>
              </>
            ) : null}
            <p>
              RPC：{r.services.rpc}；配置的供应商 Gas 上限：
              {r.services.providerHardLimitWei !== null
                ? `${formatEther(BigInt(r.services.providerHardLimitWei))} ETH / ${r.services.providerHardLimitPeriodSeconds} 秒`
                : "未配置"}
              ；美元费用上限：{r.services.providerHardLimitUsd ?? "未配置"}
              {r.services.providerHardLimitUsd !== null ? " USD" : ""}
              ；供应商实际花费：未知。
            </p>
            <Notice tone="warning">
              此处上限来自本地配置。供应商费用硬上限、AND
              策略与错误关闭是否生效仍需真实验证记录。
            </Notice>
            {r.gas.providerBillingStatus === "unavailable" ? (
              <p>未导入供应商账单。</p>
            ) : (
              <DataTable headers={["账单编号", "原计费期间", "费用"]}>
                {r.gas.providerInvoices.map((i) => (
                  <tr key={i.reference}>
                    <td>{i.reference}</td>
                    <td>
                      {i.start} — {i.end}
                    </td>
                    <td>
                      {i.amount} {i.currency}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            <details>
              <summary>期间服务错误与拒绝</summary>
              <ul>
                {Object.entries(r.services.events).map(([code, count]) => (
                  <li key={code}>
                    {code}: {count}
                  </li>
                ))}
              </ul>
            </details>
          </section>
          <ProviderStatus status={r.providerManagement} />
          <details>
            <summary>统计口径</summary>
            <ul>
              {r.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
      <FeedbackInbox />
    </>
  );
}
export function FeedbackPage() {
  const { api, account, authenticated } = useSession(),
    [message, setMessage] = useState(""),
    [operationId, setOperationId] = useState(""),
    [key] = useState(() => crypto.randomUUID()),
    [result, setResult] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  return (
    <>
      <PageTitle
        title="测试反馈"
        description="提交功能问题及复现步骤。反馈会保存到本环境的应用服务。"
      />
      <Notice tone="warning">
        请勿输入私钥、助记词、访问令牌或可执行签名。
      </Notice>
      {!authenticated && <AccountGate />}
      {result ? (
        <Notice tone="success">反馈已保存，编号：{result}</Notice>
      ) : (
        <form
          className="surface stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setError(null);
            setBusy(true);
            void api
              .request(
                "/v1/feedback",
                z.object({ id: z.string(), accepted: z.literal(true) }),
                {
                  auth: true,
                  body: {
                    id: key,
                    message,
                    ...(account ? { accountId: account.id } : {}),
                    ...(operationId ? { operationId } : {}),
                  },
                },
              )
              .then((r) => setResult(r.id))
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          <Field label="问题与复现步骤">
            <textarea
              required
              minLength={8}
              maxLength={2000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          <Field label="业务操作 ID（可选）">
            <input
              value={operationId}
              onChange={(e) => setOperationId(e.target.value.trim())}
            />
          </Field>
          <ErrorNotice error={error} />
          <Button type="submit" disabled={!authenticated || busy}>
            {busy ? "正在保存" : "提交反馈"}
          </Button>
        </form>
      )}
    </>
  );
}
