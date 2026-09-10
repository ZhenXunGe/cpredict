import type { ManagementStatus } from "../../../../offchain/app-core/src/provider-contracts.js";
import { DataTable, Notice } from "../ui.js";

const labels = {
  statistics: "项目统计",
  policies: "链上代付策略",
  webhooks: "业务策略回调",
  "team-spend": "团队项目费用（含测试网）",
};
const errors = {
  unauthorized: "凭据无效",
  forbidden: "读取权限不足",
  "rate-limited": "请求受限",
  "provider-error": "供应商异常",
  timeout: "读取超时",
  unavailable: "连接失败",
  "invalid-response": "响应无法解析",
};
const time = (value: string | null) =>
  value === null
    ? "尚未成功"
    : new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function ProviderStatus({
  status,
}: {
  status: ManagementStatus | null;
}) {
  return (
    <section className="surface stack" aria-label="供应商读取状态">
      <h2>供应商读取状态</h2>
      <Notice tone="warning">
        金额与策略仍待核验。读取成功仅代表收到了接口响应；需核对真实响应字段，并通过代付正反例，才能确认费用和策略生效。
      </Notice>
      {status ? (
        <>
          <p>
            每 5 分钟读取一次，15
            分钟未成功则标记过期。读取失败保留最后成功时间与数据。
          </p>
          <DataTable
            headers={["来源", "本次读取", "最后成功（上海）", "新鲜度"]}
          >
            {status.endpoints.map((item) => (
              <tr key={item.endpoint}>
                <td>{labels[item.endpoint]}</td>
                <td>
                  {item.error
                    ? errors[item.error]
                    : item.lastSuccessAt
                      ? "读取成功，待核验"
                      : "等待首次读取"}
                </td>
                <td>{time(item.lastSuccessAt)}</td>
                <td>
                  {item.lastSuccessAt === null
                    ? "无数据"
                    : item.stale
                      ? "已过期"
                      : "15 分钟内"}
                </td>
              </tr>
            ))}
          </DataTable>
          <details>
            <summary>项目与查询窗口</summary>
            <p>
              ZeroDev 项目：{status.projectId} · 链：{status.chainId} ·
              数据来源：{status.source}
            </p>
            {status.endpoints
              .filter((item) => item.requestedWindow)
              .map((item) => (
                <p key={item.endpoint}>
                  {labels[item.endpoint]}：本次请求{" "}
                  {time(item.requestedWindow!.start)} —{" "}
                  {time(item.requestedWindow!.end)}； 最后成功数据窗口{" "}
                  {item.dataWindow
                    ? `${time(item.dataWindow.start)} — ${time(item.dataWindow.end)}`
                    : "未知"}
                  。
                </p>
              ))}
          </details>
        </>
      ) : (
        <p>尚未配置供应商管理 API 只读凭据。</p>
      )}
    </section>
  );
}
