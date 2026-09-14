import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { formatUnits, hashTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AppError,
  sameAddress,
  type BusinessIntent,
} from "../../../offchain/app-core/src/contracts.js";
import {
  sessionViewSchema,
  tradingSessionPageSchema,
  tradingSessionSchema,
  sessionSpend,
  supportsQuickTrading,
  type SessionView,
  type TradingSession,
} from "../../../offchain/app-core/src/trading-session-contracts.js";
import { createSessionKernel } from "../../../offchain/app-core/src/trading-session-kernel.js";
import { useSession } from "./wallet-session.js";
import { useOperation } from "./operations.js";
import {
  loadTradingSession,
  saveTradingSession,
  removeTradingSession,
  tradingSessionScope,
  tradingSessionEpoch,
  type BrowserTradingSession,
} from "./trading-session-storage.js";
import { Button, ErrorNotice, Field, Modal, Notice } from "./ui.js";
import { parseAssetAmount } from "./amounts.js";

type QuickTrading = {
  local: BrowserTradingSession | null;
  view: SessionView | null;
  records: TradingSession[];
  nextCursor: string | null;
  error: unknown;
  busy: boolean;
  prompt: boolean;
  enabled: boolean;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  open(): void;
  dismiss(): void;
  enable(perOperation: string, total: string): Promise<void>;
  disable(id: string): Promise<void>;
  credential(intent: BusinessIntent): Promise<BrowserTradingSession>;
};
const QuickContext = createContext<QuickTrading | null>(null);
export const useQuickTrading = () => useContext(QuickContext);
export function QuickTradingProvider({ children }: { children: ReactNode }) {
  const wallet = useSession(),
    { account, identityKey, api } = wallet;
  const scope =
    account && identityKey
      ? tradingSessionScope(identityKey, api, account.id)
      : "";
  const kernelCache = useRef<{
    key: string;
    promise: ReturnType<typeof createSessionKernel>;
  } | null>(null);
  const latest = useRef(scope);
  latest.current = scope;
  const [state, setState] = useState<{
    scope: string;
    local: BrowserTradingSession | null;
    view: SessionView | null;
    records: TradingSession[];
    nextCursor: string | null;
  }>({ scope: "", local: null, view: null, records: [], nextCursor: null });
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [prompt, setPrompt] = useState(false);
  const enabled =
    api.environment.asset === "ctUSD" &&
    !!api.environment.quickTrading?.enabled;
  const current = () => {
    if (!scope || latest.current !== scope)
      throw new AppError("confirmation_context_changed", 409);
  };
  const refresh = async () => {
    if (!account || !identityKey) return;
    const [local, records] = await Promise.all([
      loadTradingSession(identityKey, api, account.id).catch(() => null),
      api.request(
        `/v1/trading-sessions?accountId=${account.id}`,
        tradingSessionPageSchema,
        { auth: true },
      ),
    ]);
    const view = local
      ? await api.request(
          `/v1/trading-sessions/${local.session.id}`,
          sessionViewSchema,
          { auth: true },
        )
      : null;
    current();
    setState({
      scope,
      local,
      view,
      records: records.items,
      nextCursor: records.nextCursor,
    });
    setError(null);
    if (
      enabled &&
      !local &&
      !sessionStorage.getItem(`quick-trading-prompt:${scope}`)
    )
      setPrompt(true);
  };
  useEffect(() => {
    if (!scope || api.environment.asset !== "ctUSD") return;
    const run = () => {
      void refresh().catch((e) => {
        if (latest.current === scope) setError(e);
      });
    };
    run();
    const interval = window.setInterval(run, 30000);
    const invalidate = () => {
      kernelCache.current = null;
      run();
    };
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("cpredict-trading-sessions")
        : null;
    if (channel) channel.onmessage = invalidate;
    window.addEventListener("cpredict-trading-sessions", invalidate);
    return () => {
      clearInterval(interval);
      channel?.close();
      window.removeEventListener("cpredict-trading-sessions", invalidate);
      kernelCache.current = null;
    };
  }, [scope, enabled]);
  const dismiss = () => {
    setPrompt(false);
    sessionStorage.setItem(`quick-trading-prompt:${scope}`, "1");
  };
  const enable = async (perOperation: string, total: string) => {
    if (!account || !identityKey || !enabled || !navigator.locks)
      throw new AppError("trading_session_unavailable", 409);
    const authorizationEpoch = tradingSessionEpoch(identityKey);
    const authorizationCurrent = () => {
      current();
      if (tradingSessionEpoch(identityKey) !== authorizationEpoch)
        throw new AppError("confirmation_context_changed", 409);
    };
    await navigator.locks.request(
      `cpredict-quick-authorize:${scope}`,
      async () => {
        authorizationCurrent();
        setBusy(true);
        setError(null);
        let descriptor: TradingSession | undefined;
        try {
          const privateKey = generatePrivateKey(),
            signer = privateKeyToAccount(privateKey),
            config = api.environment.quickTrading!;
          const result = await api.request(
            "/v1/trading-sessions/prepare",
            z.object({ session: tradingSessionSchema }),
            {
              auth: true,
              body: {
                accountId: account.id,
                publicKey: signer.address,
                perOperation,
                total,
              },
            },
          );
          descriptor = result.session;
          authorizationCurrent();
          if (
            descriptor.accountId !== account.id ||
            !sameAddress(descriptor.account, account.address) ||
            !sameAddress(descriptor.controller, account.controller) ||
            descriptor.environment !== api.environment.id ||
            descriptor.deploymentId !== api.environment.deployment.id ||
            !sameAddress(descriptor.publicKey, signer.address) ||
            descriptor.perOperation !== perOperation ||
            descriptor.total !== total ||
            JSON.stringify(descriptor.config) !== JSON.stringify(config) ||
            BigInt(descriptor.validUntil) - BigInt(descriptor.validAfter) >
              BigInt(config.maxDurationSeconds) ||
            BigInt(descriptor.validAfter) >
              BigInt(Math.floor(Date.now() / 1000) + 60)
          )
            throw new AppError("invalid_session_authorization", 409);
          // Verify encrypted persistence before requesting a wallet signature.
          await saveTradingSession(identityKey, api, {
            session: descriptor,
            privateKey,
            enableSignature: "0x",
          });
          const provider = await wallet.controller(account);
          authorizationCurrent();
          const kernel = await createSessionKernel(
            api.publicClient(),
            api.environment,
            descriptor,
            { controller: provider, signer },
          );
          if (
            !sameAddress(kernel.address, account.address) ||
            hashTypedData(
              await kernel.kernelPluginManager.getPluginsEnableTypedData(
                account.address,
              ),
            ) !== descriptor.authorizationHash
          )
            throw new AppError("invalid_session_authorization", 409);
          const enableSignature =
            await kernel.kernelPluginManager.getPluginEnableSignature(
              account.address,
            );
          authorizationCurrent();
          const activated = await api.request(
            `/v1/trading-sessions/${descriptor.id}/activate`,
            z.object({ session: tradingSessionSchema }),
            { auth: true, body: { signature: enableSignature } },
          );
          authorizationCurrent();
          await saveTradingSession(identityKey, api, {
            session: activated.session,
            privateKey,
            enableSignature,
          });
          authorizationCurrent();
          dismiss();
          await refresh();
        } catch (e) {
          if (descriptor) {
            await api
              .request(
                `/v1/trading-sessions/${descriptor.id}/disable`,
                z.object({ session: tradingSessionSchema }),
                { auth: true, body: {} },
              )
              .catch(() => undefined);
            await removeTradingSession(descriptor.id).catch(() => undefined);
          }
          const safe =
            e instanceof AppError
              ? e
              : new AppError("trading_session_authorization_failed", 409);
          if (latest.current === scope) setError(safe);
          throw safe;
        } finally {
          setBusy(false);
        }
      },
    );
  };
  const disable = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.request(
        `/v1/trading-sessions/${id}/disable`,
        z.object({ session: tradingSessionSchema }),
        { auth: true, body: {} },
      );
      await removeTradingSession(id);
      await refresh();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const credential = async (intent: BusinessIntent) => {
    current();
    if (!enabled || !identityKey || !account || !supportsQuickTrading(intent))
      throw new AppError("trading_session_unavailable", 409);
    const credentialEpoch = tradingSessionEpoch(identityKey);
    const assertCurrent = () => {
      current();
      if (tradingSessionEpoch(identityKey) !== credentialEpoch)
        throw new AppError("confirmation_context_changed", 409);
    };
    const local = await loadTradingSession(identityKey, api, account.id);
    if (!local) throw new AppError("trading_session_unavailable", 409);
    const view = await api.request(
      `/v1/trading-sessions/${local.session.id}`,
      sessionViewSchema,
      { auth: true },
    );
    current();
    if (
      local.enableSignature === "0x" ||
      view.session.state !== "active" ||
      view.revoked ||
      BigInt(view.session.validUntil) * 1000n <= BigInt(Date.now()) ||
      local.session.authorizationHash !== view.session.authorizationHash
    )
      throw new AppError("trading_session_unavailable", 409);
    const amount = sessionSpend(intent);
    if (
      amount > BigInt(view.session.perOperation) ||
      amount + BigInt(view.spent) + BigInt(view.pending) >
        BigInt(view.session.total)
    )
      throw new AppError("trading_session_budget_exceeded", 409);
    assertCurrent();
    const kernel = () => {
      assertCurrent();
      const key = `${scope}:${local.session.id}:${local.session.authorizationHash}`;
      if (kernelCache.current?.key === key) return kernelCache.current.promise;
      const promise = createSessionKernel(
        api.publicClient(),
        api.environment,
        local.session,
        {
          signer: privateKeyToAccount(local.privateKey),
          enableSignature: local.enableSignature,
        },
      );
      kernelCache.current = { key, promise };
      void promise.catch(() => {
        if (kernelCache.current?.promise === promise)
          kernelCache.current = null;
      });
      return promise;
    };
    return { ...local, assertCurrent, kernel };
  };
  const loadMore = async () => {
    if (!account || state.scope !== scope || !state.nextCursor) return;
    try {
      const page = await api.request(
        `/v1/trading-sessions?accountId=${account.id}&cursor=${state.nextCursor}`,
        tradingSessionPageSchema,
        { auth: true },
      );
      current();
      setState((previous) =>
        previous.scope === scope
          ? {
              ...previous,
              records: [
                ...new Map(
                  [...previous.records, ...page.items].map((s) => [s.id, s]),
                ).values(),
              ],
              nextCursor: page.nextCursor,
            }
          : previous,
      );
    } catch (e) {
      setError(e);
    }
  };
  const visible =
    state.scope === scope
      ? state
      : { local: null, view: null, records: [], nextCursor: null };
  return (
    <QuickContext.Provider
      value={{
        ...visible,
        error,
        busy,
        prompt: prompt && !!scope,
        enabled,
        refresh,
        loadMore,
        open: () => setPrompt(true),
        dismiss,
        enable,
        disable,
        credential,
      }}
    >
      {children}
    </QuickContext.Provider>
  );
}

export function QuickTradingAuthorization() {
  const quick = useQuickTrading(),
    wallet = useSession(),
    config = wallet.api.environment.quickTrading;
  const [per, setPer] = useState(""),
    [total, setTotal] = useState(""),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (quick?.prompt && config) {
      setPer(formatUnits(BigInt(config.defaultPerOperation), 6));
      setTotal(formatUnits(BigInt(config.defaultTotal), 6));
      setError(null);
    }
  }, [quick?.prompt, config]);
  if (!quick || !config || !quick.enabled) return null;
  return (
    <Modal
      open={quick.prompt}
      onOpenChange={(v) => {
        if (!v && !quick.busy) quick.dismiss();
      }}
      title="开启快捷交易"
      description="这是交易授权，与登录身份验证分开。仅当前浏览器有效。"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={quick.busy}
            onClick={quick.dismiss}
          >
            暂不开启
          </Button>
          <Button
            disabled={quick.busy}
            onClick={() => {
              try {
                void quick
                  .enable(
                    parseAssetAmount(per).toString(),
                    parseAssetAmount(total).toString(),
                  )
                  .catch(setError);
              } catch (e) {
                setError(e);
              }
            }}
          >
            {quick.busy ? "授权中…" : "确认授权并签名"}
          </Button>
        </>
      }
    >
      <p>
        一次钱包签名，授权一级买入、购买挂单、挂单卖出、撤单、终局份额取回及各项领取。每笔操作仍需站内确认，仅支持项目代付。
      </p>
      <Field
        label={`单笔买入额度（最高 ${formatUnits(BigInt(config.maxPerOperation), 6)} ctUSD）`}
      >
        <input
          inputMode="decimal"
          value={per}
          onChange={(e) => setPer(e.target.value)}
        />
      </Field>
      <Field
        label={`累计买入额度（最高 ${formatUnits(BigInt(config.maxTotal), 6)} ctUSD）`}
      >
        <input
          inputMode="decimal"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
        />
      </Field>
      <p>
        有效期 {config.maxDurationSeconds / 3600} 小时，预计到期：
        {new Date(
          Date.now() + config.maxDurationSeconds * 1000,
        ).toLocaleString()}
        。准确时间在授权后显示。
      </p>
      <Notice tone="warning">
        额度按最大支付金额计入；验证通过即扣减，随后执行失败也不返还。卖出、退款及领取不恢复额度。每次新授权拥有独立预算，旧授权持续到期或链上撤销。
      </Notice>
      <p>
        转出资产、创建市场、发布结果、作废市场、水龙头和入金仍需控制钱包签名。退出登录会清除本地凭证并停用服务端会话；链上撤销是独立操作。
      </p>
      <ErrorNotice error={error ?? quick.error} />
    </Modal>
  );
}
export function QuickTradingPanel() {
  const quick = useQuickTrading(),
    begin = useOperation();
  if (!quick || (!quick.enabled && !quick.records.length)) return null;
  return (
    <section className="surface stack">
      <h2>快捷交易</h2>
      <p>仅当前浏览器有效；每笔操作保留站内确认。</p>
      {quick.enabled && (
        <Button disabled={quick.busy} onClick={quick.open}>
          {quick.local ? "重新授权" : "开启快捷交易"}
        </Button>
      )}
      <ErrorNotice error={quick.error} />
      {quick.view && (
        <p>
          已消耗 {formatUnits(BigInt(quick.view.spent), 6)} ctUSD，待处理预留{" "}
          {formatUnits(BigInt(quick.view.pending), 6)}{" "}
          ctUSD。额度最终以链上判断为准。
        </p>
      )}
      {quick.nextCursor && (
        <Button variant="quiet" onClick={() => void quick.loadMore()}>
          更多授权记录
        </Button>
      )}
      {quick.records.map((s) => (
        <TradingSessionRecord key={s.id} session={s} />
      ))}
    </section>
  );
}
function TradingSessionRecord({ session: s }: { session: TradingSession }) {
  const quick = useQuickTrading()!,
    wallet = useSession(),
    begin = useOperation();
  const state = useQuery({
    queryKey: [wallet.api.key, "trading-session", wallet.identityKey, s.id],
    queryFn: () =>
      wallet.api.request(`/v1/trading-sessions/${s.id}`, sessionViewSchema, {
        auth: true,
      }),
    refetchInterval: 30000,
  });
  const revoked = state.data?.revoked,
    expired = BigInt(s.validUntil) * 1000n <= BigInt(Date.now());
  return (
    <div className="stack">
      <p>
        权限 {s.permissionId} · 单笔 {formatUnits(BigInt(s.perOperation), 6)} /
        累计 {formatUnits(BigInt(s.total), 6)} ctUSD
        <br />
        到期 {new Date(Number(s.validUntil) * 1000).toLocaleString()} ·{" "}
        {revoked
          ? "链上已撤销"
          : expired
            ? "已到期"
            : s.state === "disabled"
              ? "已停用；链上撤销待完成"
              : s.state === "prepared"
                ? "待完成授权"
                : "已授权"}
      </p>
      {state.data && (
        <p>
          已消耗 {formatUnits(BigInt(state.data.spent), 6)} ctUSD · 待处理{" "}
          {formatUnits(BigInt(state.data.pending), 6)} ctUSD
        </p>
      )}
      <div className="row">
        <Button
          variant="secondary"
          disabled={quick.busy || s.state === "disabled"}
          onClick={() => void quick.disable(s.id).catch(() => undefined)}
        >
          停用并清除本地凭证
        </Button>
        <Button
          variant="secondary"
          disabled={quick.busy || revoked}
          onClick={() =>
            begin({
              intent: { kind: "revoke-trading-session", sessionId: s.id },
              summary: [
                { label: "撤销权限", value: s.permissionId },
                { label: "资产账户", value: s.account },
              ],
              feeNote:
                "由控制钱包签名执行链上撤销。交易确认前，显示为链上撤销待完成；已停用的权限不会再获项目代付。",
            })
          }
        >
          链上撤销
        </Button>
      </div>
    </div>
  );
}
