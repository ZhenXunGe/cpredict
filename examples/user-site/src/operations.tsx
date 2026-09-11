import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { formatEther } from "viem";
import {
  intentSchema,
  AppError,
  isRecoverable,
  operationSchema,
  type BusinessIntent,
  type Operation,
  type OperationKind,
  type GasPayment,
} from "../../../offchain/app-core/src/contracts.js";
import { useSession } from "./wallets.js";
import {
  UserOperationClient,
  type OperationStage,
  type GasQuote,
} from "./operation-client.js";
import { GasPaymentPanel } from "./GasPayment.js";
import {
  AddressText,
  Button,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
  shortAddress,
} from "./ui.js";
export const operationLabels: Record<OperationKind, string> = {
  faucet: "领取测试资产",
  "deposit-usdc": "USDC 免 Gas 入金",
  buy: "一级购买",
  "create-market": "创建市场",
  "create-listing": "挂单卖出",
  "fill-listing": "购买挂单",
  "cancel-listing": "撤销挂单",
  "return-listing": "取回终局挂单份额",
  resolve: "结算市场",
  "creator-void": "作废市场",
  "void-timeout": "超时作废",
  "claim-winner": "领取赢家收益",
  "claim-early-bird": "领取早鸟返还",
  refund: "领取退款",
  "claim-timeout-bonus": "领取超时补偿",
  "settle-bond": "结算创作者押金",
  "claim-bond": "领取押金余额",
  "claim-fees": "领取费用收入",
  transfer: "转出测试资产",
};
export const operationStateCopy: Record<Operation["state"], string> = {
  preparing: "准备中",
  "awaiting-signature": "等待签名",
  submitted: "已提交",
  confirming: "链上确认中",
  confirmed: "已确认",
  reverted: "链上已回滚",
  cancelled: "已取消",
  unknown: "结果未知",
};
type Request = {
  intent: BusinessIntent;
  summary: readonly { label: string; value: string }[];
  feeNote: string;
};
const draftSchema = z.object({
  id: z.string().uuid(),
  intent: intentSchema,
  summary: z.array(z.object({ label: z.string(), value: z.string() })),
  feeNote: z.string(),
  path: z.string(),
  accountId: z.string().uuid().nullable(),
  identityKey: z.string().nullable(),
});
type Draft = z.infer<typeof draftSchema>;
const Operations = createContext<((request: Request) => void) | null>(null);
const CurrentOperation = createContext<Operation | null>(null);
export function useCurrentOperation() {
  return useContext(CurrentOperation);
}
export function useOperation() {
  const value = useContext(Operations);
  if (!value) throw new Error("operation context unavailable");
  return value;
}
export function AccountGate() {
  const session = useSession(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  if (!session.authenticated)
    return (
      <div className="stack">
        <p>登录后进入你的应用资产账户。浏览市场无需登录。</p>
        <Button onClick={session.login} disabled={!session.ready}>
          登录或连接钱包
        </Button>
      </div>
    );
  if (session.account) return null;
  return (
    <div className="stack">
      <p>选择一个控制钱包，为当前环境验证应用账户。资产保存在应用账户中。</p>
      <ErrorNotice error={error ?? session.error} />
      {session.wallets.map((wallet) => (
        <Button
          key={wallet.address}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setBusy(true);
            void session
              .bindWallet(wallet)
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {wallet.walletClientType === "privy" ? "内嵌钱包" : "外部钱包"} ·{" "}
          {shortAddress(wallet.address)}
        </Button>
      ))}
      <Button variant="quiet" onClick={session.linkWallet}>
        验证其他外部钱包
      </Button>
      {busy && <Loading label="请在钱包中确认账户控制证明" />}
    </div>
  );
}
export function OperationProvider({ children }: { children: ReactNode }) {
  const session = useSession(),
    cache = useQueryClient(),
    location = useLocation(),
    path = location.pathname + location.search,
    storageKey = `cpredict-draft:${session.api.key}`;
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (!stored) return null;
      const parsed = draftSchema.parse(JSON.parse(stored));
      return parsed.path === path && parsed.intent.kind !== "deposit-usdc"
        ? parsed
        : null;
    } catch {
      return null;
    }
  });
  const [record, setRecord] = useState<Operation | null>(null),
    [stage, setStage] = useState<OperationStage | null>(null),
    [error, setError] = useState<unknown>(null);
  const [gasPayment, setGasPayment] = useState<GasPayment>(
      session.api.environment.features.sponsorship
        ? "sponsored"
        : "self-funded",
    ),
    [gasQuote, setGasQuote] = useState<GasQuote | null>(null);
  const gasApproval = useRef<{
    resolve: () => void;
    reject: (e: AppError) => void;
  } | null>(null);
  const discardGasApproval = () => {
    gasApproval.current?.reject(
      new AppError("confirmation_context_changed", 409),
    );
    gasApproval.current = null;
    setGasQuote(null);
  };
  useEffect(
    () => () => {
      gasApproval.current?.reject(
        new AppError("confirmation_context_changed", 409),
      );
    },
    [],
  );
  const current = useRef({
    draftId: draft?.id,
    account: session.account?.id,
    identity: session.identityKey,
  });
  current.current = {
    draftId: draft?.id,
    account: session.account?.id,
    identity: session.identityKey,
  };
  const accountScope = useRef({
    account: session.account?.id,
    identity: session.identityKey,
  });
  useEffect(() => {
    const previous = accountScope.current;
    accountScope.current = {
      account: session.account?.id,
      identity: session.identityKey,
    };
    if (
      (draft && draft.path !== path) ||
      (draft &&
        session.authenticated &&
        !session.loading &&
        ((draft.accountId && session.account?.id !== draft.accountId) ||
          (draft.identityKey && session.identityKey !== draft.identityKey))) ||
      (previous.account && previous.account !== session.account?.id) ||
      (previous.identity && previous.identity !== session.identityKey)
    ) {
      setDraft(null);
      setRecord(null);
      setStage(null);
      discardGasApproval();
      sessionStorage.removeItem(storageKey);
    }
  }, [
    session.account?.id,
    session.identityKey,
    session.authenticated,
    session.loading,
    storageKey,
    draft,
    path,
  ]);
  const operation = useQuery({
    queryKey: [
      session.api.key,
      "operation",
      session.identityKey,
      record?.accountId,
      record?.id,
    ],
    enabled: !!record && session.authenticated,
    queryFn: ({ signal }) =>
      session.api.request(
        `/v1/operations/${record!.id}`,
        z.object({ operation: operationSchema }),
        { auth: true, signal },
      ),
    refetchInterval: (q) =>
      q.state.data?.operation.state === "confirmed" ||
      q.state.data?.operation.state === "reverted" ||
      q.state.data?.operation.state === "cancelled"
        ? false
        : 3500,
    retry: 1,
  });
  const latest = operation.data?.operation ?? record;
  useEffect(() => {
    if (latest?.state === "confirmed")
      void cache.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === session.api.key && q.queryKey[1] !== "operation",
      });
  }, [latest?.id, latest?.state, cache, session.api.key]);
  const begin = (request: Request) => {
    const next = draftSchema.parse({
      ...request,
      id: crypto.randomUUID(),
      path,
      accountId: session.account?.id ?? null,
      identityKey: session.identityKey,
    });
    setDraft(next);
    setRecord(null);
    setError(null);
    setStage(null);
    discardGasApproval();
    setGasPayment(
      session.api.environment.features.sponsorship
        ? "sponsored"
        : "self-funded",
    );
    // A USDC authorization is executable by the recipient; never persist its signature in the browser.
    if (next.intent.kind === "deposit-usdc")
      sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, JSON.stringify(next));
  };
  const close = () => {
    discardGasApproval();
    current.current.draftId = undefined;
    setDraft(null);
    setStage(null);
    sessionStorage.removeItem(storageKey);
  };
  const submit = async () => {
    const account = session.account;
    if (!draft || !account || stage || record) return;
    const id = draft.id,
      identity = session.identityKey;
    setError(null);
    const client = new UserOperationClient(
      session.api,
      account,
      () => session.controller(account),
      () =>
        current.current.draftId === id &&
        current.current.account === account.id &&
        current.current.identity === identity,
    );
    try {
      await client.submit(
        draft.intent,
        (value) => {
          if (
            current.current.draftId === id &&
            current.current.account === account.id
          )
            setRecord(value);
        },
        (value) => {
          if (current.current.draftId === id) setStage(value);
        },
        {
          payment: gasPayment,
          confirm: (quote) =>
            new Promise<void>((resolve, reject) => {
              if (
                current.current.draftId !== id ||
                current.current.account !== account.id ||
                current.current.identity !== identity
              ) {
                reject(new AppError("confirmation_context_changed", 409));
                return;
              }
              setGasQuote(quote);
              gasApproval.current = { resolve, reject };
            }),
        },
      );
    } catch (e) {
      if (current.current.draftId === id) setError(e);
    } finally {
      if (current.current.draftId === id) setStage(null);
    }
  };
  const cancel = async (retry = false) => {
    if (!latest) return;
    setError(null);
    try {
      const result = await session.api.request(
        `/v1/operations/${latest.id}/cancel`,
        z.object({ operation: operationSchema }),
        { auth: true, body: {} },
      );
      setRecord(result.operation);
      await cache.invalidateQueries({
        queryKey: [session.api.key, "operation"],
      });
      if (retry) {
        discardGasApproval();
        setRecord(null);
        setError(null);
        setStage(null);
      } else close();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Operations.Provider value={begin}>
      <CurrentOperation.Provider value={latest}>
        {children}
      </CurrentOperation.Provider>
      <Modal
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={draft ? operationLabels[draft.intent.kind] : "确认操作"}
        description="请核对本次操作。每笔交易都需要你的明确确认。"
        footer={
          session.account ? (
            <>
              {stage === "reviewing-gas" && gasQuote ? (
                <div className="stack" style={{ width: "100%", gap: 12 }}>
                  <p className="small" style={{ margin: 0 }}>
                    本次最多支付{" "}
                    <strong>{formatEther(gasQuote.cost)} ETH</strong>；可用 Gas
                    余额 {formatEther(gasQuote.balance)} ETH
                  </p>
                  <div className="row">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        discardGasApproval();
                        void cancel(true);
                      }}
                    >
                      取消签名
                    </Button>
                    <Button
                      onClick={() => {
                        const approval = gasApproval.current;
                        gasApproval.current = null;
                        setStage("awaiting-signature");
                        approval?.resolve();
                      }}
                    >
                      确认自付 ETH 并签名
                    </Button>
                  </div>
                </div>
              ) : latest ? (
                <>
                  <Link
                    className="button button-secondary"
                    to={`/${session.api.environment.id}/history?operation=${latest.id}`}
                    onClick={close}
                  >
                    查看原操作
                  </Link>
                  {latest.state === "awaiting-signature" && !stage ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void cancel(true)}
                      >
                        取消并重新核对
                      </Button>
                      <Button variant="quiet" onClick={() => void cancel()}>
                        取消本次操作
                      </Button>
                    </>
                  ) : (
                    <Button onClick={close}>关闭</Button>
                  )}
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={close}>
                    取消
                  </Button>
                  <Button disabled={!!stage} onClick={() => void submit()}>
                    {stage
                      ? "处理中"
                      : gasPayment === "self-funded"
                        ? "估算自付 Gas"
                        : "确认并继续"}
                  </Button>
                </>
              )}
            </>
          ) : undefined
        }
      >
        {draft && (
          <>
            <dl className="data-list">
              {draft.summary.map((row) => (
                <div key={row.label} style={{ display: "contents" }}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <Notice>{draft.feeNote}</Notice>
            <AccountGate />
            {session.account && (
              <>
                <dl className="data-list">
                  <dt>资产账户</dt>
                  <dd>
                    <AddressText value={session.account.address} />
                  </dd>
                  <dt>控制钱包</dt>
                  <dd>
                    <AddressText value={session.account.controller} />
                  </dd>
                  <dt>当前环境</dt>
                  <dd>{session.api.environment.label}</dd>
                  <dt>网络 Gas</dt>
                  <dd>
                    {(latest?.gasPayment ?? gasPayment) === "self-funded"
                      ? "自行支付 ETH"
                      : latest
                        ? "已登记项目代付"
                        : "等待代付准入"}
                  </dd>
                </dl>
                {!gasQuote && (
                  <GasPaymentPanel
                    key={`${session.api.key}:${session.identityKey}:${session.account.id}`}
                    payment={gasPayment}
                    onChange={(v) => {
                      setGasPayment(v);
                      setError(null);
                    }}
                    disabled={!!stage || !!latest}
                  />
                )}
                {gasQuote && (
                  <Notice tone="warning">
                    本次最多支付 {formatEther(gasQuote.cost)} ETH；智能账户可用
                    Gas 余额 {formatEther(gasQuote.balance)}{" "}
                    ETH。请确认后再签名。
                  </Notice>
                )}
                <Notice tone="warning">
                  所有金额均为测试资产。网络 Gas
                  与协议费用、创建费及押金分别核算。
                </Notice>
              </>
            )}
            {stage && (
              <div className="step-status" role="status">
                <span className="spinner" />
                {stage === "preparing"
                  ? gasPayment === "self-funded"
                    ? "重新核对交易并估算自付 Gas"
                    : "重新核对交易并申请代付"
                  : stage === "reviewing-gas"
                    ? "请核对 ETH Gas 费用"
                    : stage === "awaiting-signature"
                      ? "请在钱包中确认签名"
                      : "正在提交，请勿重复操作"}
              </div>
            )}
            {latest && (
              <Notice
                tone={
                  latest.state === "confirmed"
                    ? "success"
                    : isRecoverable(latest.state)
                      ? "warning"
                      : "info"
                }
              >
                <strong>{operationStateCopy[latest.state]}</strong>
                <p className="small">操作编号 {latest.id}</p>
                {isRecoverable(latest.state) && (
                  <p>仅查询此操作，不会自动重新发送。</p>
                )}
                {latest.transactionHash && (
                  <a
                    href={`${session.api.environment.explorerUrl}/tx/${latest.transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看链上交易
                  </a>
                )}
              </Notice>
            )}
            <ErrorNotice error={error ?? operation.error} />
          </>
        )}
      </Modal>
    </Operations.Provider>
  );
}
