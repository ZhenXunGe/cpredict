import { z } from "zod";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  AppError,
  environmentKey,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
export type TokenGetter = () => Promise<string | null>;
export class SiteApi {
  constructor(
    readonly environment: Environment,
    readonly getToken: TokenGetter = async () => null,
  ) {}
  get key() {
    return environmentKey(this.environment);
  }
  headers() {
    return {
      "x-cpredict-environment": this.environment.id,
      "x-cpredict-deployment": this.environment.deployment.id,
    };
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      body?: unknown;
      signal?: AbortSignal;
      auth?: boolean;
      service?: "app" | "indexer" | "metadata";
    } = {},
  ): Promise<T> {
    const service = options.service ?? "app",
      url = new URL(
        `${this.environment.services[service]}${path}`,
        window.location.origin,
      );
    if (service === "indexer") {
      url.searchParams.set("environment", this.environment.id);
      url.searchParams.set("deploymentId", this.environment.deployment.id);
      url.searchParams.set(
        "chainId",
        String(this.environment.deployment.chainId),
      );
    }
    const token = options.auth ? await this.getToken() : null;
    if (options.auth && !token)
      throw new AppError("login_required", 401, "请先登录");
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000);
    const response = await fetch(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        ...this.headers(),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    const text = await response.text();
    if (text.length > 4_194_304) throw new AppError("response_too_large", 503);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError("service_response_invalid", 503);
    }
    if (!response.ok) {
      const parsed = z
        .object({
          error: z.object({
            code: z.string(),
            message: z.string().optional(),
            operationId: z.string().optional(),
          }),
        })
        .safeParse(value);
      throw new AppError(
        parsed.success ? parsed.data.error.code : "service_unavailable",
        response.status,
        undefined,
        parsed.success ? parsed.data.error.operationId : undefined,
      );
    }
    return schema.parse(value);
  }
  publicClient(): PublicClient {
    return createPublicClient({
      chain: arbitrumSepolia,
      transport: http(this.environment.services.rpc, {
        retryCount: 0,
        timeout: 10000,
        fetchOptions: { headers: this.headers() },
      }),
    });
  }
}
const messages: Record<string, string> = {
  invalid_asset_amount: "请输入大于零、最多 6 位小数的金额。",
  external_wallet_required: "请在已恢复控制钱包的浏览器中打开此工具。",
  browser_lock_required:
    "此浏览器无法协调多标签页提交，请使用支持 Web Locks 的最新浏览器。",
  recovery_preparation_failed:
    "配置、连接或费用核对未完成。请核对恢复文件与服务地址；自付退出需要应用账户有 ETH。",
  operation_query_required: "请到交易历史或原操作记录中查询，勿重复提交。",
  confirmation_context_changed: "账户或确认内容已变化，请重新核对。",
  environment_mismatch: "当前钱包、账户或服务不属于所选环境，请核对配置。",
  user_operation_event_missing:
    "尚无法核对本次操作的链上执行结果，请继续查询原操作。",
  login_required: "请先登录，再确认这笔操作。",
  account_not_found: "请选择当前环境中已验证的应用账户。",
  controller_not_linked: "请通过登录窗口验证此控制钱包。",
  account_configuration_changed: "账户配置与原账户不一致，已停止操作。",
  account_implementation_changed:
    "此账户版本已变化，请使用恢复说明核对控制方式。",
  rules_unverified: "市场规则暂时无法验证，请稍后重试。已持有资产仍可退出。",
  sponsorship_disabled: "当前暂停项目代付。请查看账户与帮助中的独立退出说明。",
  operation_preparation_changed:
    "余额、账户或交易数据已变化，请重新核对并确认。",
  operation_result_unknown: "提交结果未知。请查询原操作，勿重复提交。",
  operation_already_submitted: "该操作已提交，请继续查询原操作。",
  operation_in_progress: "此账户还有正在进行的操作，请先查看交易历史。",
  gas_cost_exceeds_limit: "预计网络费用超出本次代付上限。",
  operation_admission_expired: "本次确认已过期，请重新核对交易。",
  snapshot_invalidated: "历史快照已变化，正在等待重新查询。",
  faucet_cooldown: "该账户每 24 小时可领取一次测试资产。",
  quota_exceeded: "当前代付额度已用尽，请稍后重试。",
  sponsorship_budget_exhausted:
    "当前操作类别的代付额度已用尽，请查看独立退出说明或稍后重试。",
  sponsorship_weekly_budget_exhausted:
    "当前操作类别的本周代付额度已用尽。新增交易与退出分别保留额度；可查看独立退出说明。",
  method_quota_exhausted: "此类操作今日已达到代付次数限制，请稍后重试。",
  ops_forbidden: "此账号没有查看运营报表的权限。",
  new_exposure_disabled: "当前暂停新增交易，已有资产的领取和退出仍可使用。",
};
export function errorCopy(error: unknown): string {
  if (error instanceof AppError)
    return (
      messages[error.code] ??
      `暂时无法完成请求（${error.code}）。请重试或通过反馈入口提供操作编号。`
    );
  if (error instanceof DOMException && error.name === "AbortError")
    return "请求已取消。";
  return "请求未完成。请检查连接；已提交的操作请到交易历史中继续查询。";
}
