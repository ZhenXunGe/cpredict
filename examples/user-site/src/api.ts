import { z } from "zod";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  AppError,
  environmentKey,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
export type TokenGetter = () => Promise<string | null>;

const metadataCodes: Record<string, string> = {
  "invalid challenge request": "invalid_factory",
  "invalid factory": "invalid_factory",
  "challenge unavailable": "challenge_unavailable",
  "challenge expired": "challenge_expired",
  "challenge not found": "challenge_not_found",
  "challenge already consumed": "challenge_consumed",
  "invalid signature": "invalid_signature",
  "signature verification unavailable": "signature_verification_unavailable",
  "rules do not match challenge": "rules_challenge_mismatch",
  "invalid request": "metadata_invalid_request",
  "internal error": "metadata_internal_error",
};

/** Bounded, plain-text diagnostics; never include credentials or signed payloads. */
export function safeErrorDetail(text: string): string {
  return text
    .replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s"<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        return url.protocol.startsWith("postgres")
          ? "[连接信息已隐藏]"
          : `${url.origin}${url.pathname.replace(/\/api\/.*$/i, "/[已隐藏]")}`;
      } catch {
        return "[连接信息已隐藏]";
      }
    })
    .replace(
      /(?:Bearer\s+\S+|privy_app_secret_\S+|0x[0-9a-fA-F]{128,})/gi,
      "[已隐藏]",
    )
    .replace(
      /((?:secret|password|token|signature|authorization|cookie|privateKey)["']?\s*[:=]\s*["']?)[^\s,}"']+/gi,
      "$1[已隐藏]",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

export class ServiceResponseError extends AppError {
  readonly responseBody: string;
  constructor(
    readonly service: "app" | "indexer" | "metadata",
    status: number,
    readonly contentType: string,
    body: string,
    code: string,
    message: string,
    operationId?: string,
    readonly requestId?: string,
  ) {
    super(code, status, safeErrorDetail(message), operationId);
    this.responseBody = safeErrorDetail(body);
  }
}

function responseError(
  service: ServiceResponseError["service"],
  response: Response,
  body: string,
  value: unknown,
) {
  const object = z
    .object({
      error: z.union([
        z.string(),
        z.object({
          code: z.string(),
          message: z.string().optional(),
          operationId: z.string().uuid().optional(),
        }),
      ]),
      code: z.string().optional(),
      requestId: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional(),
    })
    .safeParse(value);
  const error = object.success ? object.data.error : undefined;
  const message =
    typeof error === "string" ? error : (error?.message ?? error?.code ?? body);
  const code =
    typeof error === "object"
      ? error.code
      : object.success && object.data.code
        ? object.data.code
        : service === "metadata" && typeof error === "string"
          ? (metadataCodes[error] ?? "metadata_request_failed")
          : response.ok
            ? "service_response_invalid"
            : "service_http_error";
  return new ServiceResponseError(
    service,
    response.status,
    response.headers.get("content-type") ?? "unknown",
    body,
    code,
    message,
    typeof error === "object" ? error.operationId : undefined,
    object.success ? object.data.requestId : undefined,
  );
}

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
      throw responseError(service, response, text, undefined);
    }
    if (!response.ok) throw responseError(service, response, text, value);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw responseError(service, response, text, value);
    return parsed.data;
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
  invalid_factory: "规则服务的 Factory 与当前环境不一致，请联系维护者。",
  challenge_expired: "规则签名挑战已过期，请重新发布规则并再次签名。",
  challenge_unavailable:
    "规则签名挑战不可用（可能已过期或已使用），请重新发布规则并签名。",
  challenge_not_found: "未找到这次规则签名挑战，请重新发布规则并签名。",
  challenge_consumed: "这次规则签名挑战已使用，请重新发布规则并签名。",
  invalid_signature: "规则签名无效，请核对控制钱包后重新签名。",
  rules_signature_rejected: "已取消规则签名，可以重新发布规则并签名。",
  rules_signature_expired: "钱包签名已过期，请重新发布规则并签名。",
  signature_verification_unavailable:
    "暂时无法验证规则签名，请稍后重新发布规则。",
  rules_challenge_mismatch: "规则内容与签名挑战不一致，请重新发布规则。",
  metadata_storage_incompatible:
    "规则服务的签名存储格式不兼容，请联系维护者更新服务。",
  metadata_internal_error: "规则服务内部错误，请联系维护者核查。",
  metadata_invalid_request: "规则服务拒绝了请求，请核对规则字段与当前环境。",
  gasless_deposit_disabled: "当前暂停 USDC 免 Gas 入金，已有记录仍可查询。",
  deposit_source_not_eoa:
    "请选择普通 EOA 资金钱包；本次不支持合约钱包或已委托的账户。",
  deposit_source_required: "请连接并选择持有 USDC 的资金钱包。",
  deposit_insufficient_balance: "资金钱包的 USDC 余额不足，请重新核对数量。",
  deposit_signature_rejected: "已取消资金钱包签名，尚未提交入金。",
  deposit_signature_invalid: "无法核对资金钱包的授权签名，请重新确认。",
  deposit_authorization_expired:
    "本次 USDC 授权已过期或剩余时间不足，请取消原准备后重新核对。",
  deposit_authorization_used: "这份授权已被使用或撤销，请查询原入金记录。",
  deposit_authorization_mismatch: "授权与原入金记录不一致，已停止操作。",
  deposit_domain_changed: "USDC 签名配置发生变化，已停止操作。",
  deposit_recipient_mismatch: "收款地址与当前应用账户不一致，已停止操作。",
  deposit_in_progress: "此账户已有待完成的入金，请继续查询或核对原记录。",
  deposit_already_registered: "这笔入金已登记，请继续查询原操作。",
  deposit_not_found: "无法读取当前账户的这笔入金，请核对账号与环境。",
  deposit_source_quota_exhausted: "此资金钱包今日已达到入金代付次数限制。",
  deposit_transfer_unverified:
    "尚无法完整核对 USDC 到账事件，请查询原操作，勿重复入金。",
  usdc_authorization_unavailable:
    "当前无法验证 USDC 签名转账能力，请稍后重新查询。",
  usdc_transfers_unavailable: "USDC 暂时不允许这笔转账，资金尚未转入。",
  chain_query_unavailable:
    "链上读取暂不可用，请稍后重新查询。已提交的操作请勿重复发送。",
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
  sponsorship_disabled: "当前暂停项目代付，可选择自行支付 ETH Gas。",
  operation_preparation_changed:
    "余额、账户或交易数据已变化，请重新核对并确认。",
  operation_result_unknown: "提交结果未知。请查询原操作，勿重复提交。",
  operation_already_submitted: "该操作已提交，请继续查询原操作。",
  operation_in_progress: "此账户还有正在进行的操作，请先查看交易历史。",
  gas_cost_exceeds_limit: "预计网络费用超出本次操作的 Gas 上限。",
  self_funded_balance_insufficient:
    "智能账户的 ETH Gas 余额不足，请补充后重新估算。",
  self_funded_paymaster_forbidden: "自付交易不能使用项目代付，请重新核对。",
  gas_payment_mismatch: "Gas 支付方式已变化，请重新核对。",
  gas_confirmation_required: "请先核对并确认本次 ETH Gas 费用。",
  invalid_gas_funding_amount: "请输入大于零的 ETH 转入金额，最多 18 位小数。",
  gas_funding_reverted: "ETH 转入交易已回滚，请查看链上记录。",
  gas_funding_query_required:
    "ETH 转入未完成确认。请检查钱包和已有转账记录，避免重复转入。",
  operation_admission_expired: "本次确认已过期，请重新核对交易。",
  snapshot_invalidated: "历史快照已变化，正在等待重新查询。",
  faucet_cooldown: "该账户每 24 小时可领取一次测试资产。",
  quota_exceeded: "当前代付额度已用尽，请稍后重试。",
  sponsorship_budget_exhausted:
    "当前操作类别的代付额度已用尽，可在 Gas 支付方式中选择自行支付 ETH。",
  sponsorship_weekly_budget_exhausted:
    "当前操作类别的本周代付额度已用尽，可在 Gas 支付方式中选择自行支付 ETH。新增交易与退出分别保留额度。",
  method_quota_exhausted: "此类操作今日已达到代付次数限制，请稍后重试。",
  ops_forbidden: "此账号没有查看运营报表的权限。",
  new_exposure_disabled: "当前暂停新增交易，已有资产的领取和退出仍可使用。",
};
export function errorCopy(error: unknown): string {
  if (
    error instanceof AppError &&
    error.code === "self_funded_balance_insufficient" &&
    error.message !== error.code
  )
    return safeErrorDetail(error.message);
  if (error instanceof ServiceResponseError) {
    const detail = error.message || "响应内容为空";
    return `${messages[error.code] ?? "服务请求失败。"}（HTTP ${error.status}；${detail}）${
      error.requestId ? ` 服务请求号：${error.requestId}。` : ""
    }${error.operationId ? ` 操作编号：${error.operationId}。` : ""}`;
  }
  if (error instanceof AppError)
    return (
      messages[error.code] ??
      `暂时无法完成请求（${error.code}${error.message !== error.code ? `：${safeErrorDetail(error.message)}` : ""}）。${error.operationId ? `请通过反馈入口提供操作编号 ${error.operationId}。` : "请稍后重试。"}`
    );
  if (error instanceof DOMException && error.name === "AbortError")
    return "请求已取消。";
  return "请求未完成。请检查连接；已提交的操作请到交易历史中继续查询。";
}
