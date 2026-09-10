import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatUnits, type Hex } from "viem";
import { z } from "zod";
import {
  AppError,
  depositPageSchema,
  depositSchema,
  sameAddress,
  type Deposit,
  type Operation,
} from "../../../offchain/app-core/src/contracts.js";
import { USDC_ADDRESS, usdcAbi } from "../../../offchain/app-core/src/usdc.js";
import { parseAssetAmount } from "./amounts.js";
import {
  assertDepositContext,
  signDepositAuthorization,
} from "./deposit-client.js";
import {
  UserOperationClient,
  type OperationStage,
} from "./operation-client.js";
import { operationStateCopy } from "./operations.js";
import { useSession } from "./wallets.js";
import {
  AddressText,
  Amount,
  Button,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Notice,
  shortAddress,
} from "./ui.js";

const responseSchema = z.object({
  deposit: depositSchema,
  recovery: z.enum(["available", "unavailable"]).optional(),
});
function pending(d: Deposit): boolean {
  return (
    [
      "awaiting-authorization",
      "preparing",
      "awaiting-signature",
      "submitted",
      "confirming",
      "unknown",
    ].includes(d.state) ||
    (d.state === "reverted" && d.finality !== "finalized")
  );
}
function stateCopy(d: Deposit): string {
  return d.state === "awaiting-authorization"
    ? "等待资金钱包授权"
    : d.state === "expired"
      ? "授权已过期"
      : operationStateCopy[d.state];
}

/** Mounted with an account/environment key; signatures live only in this component's memory. */
export function GaslessDeposit() {
  const session = useSession(),
    api = session.api,
    account = session.account!,
    env = api.environment,
    cache = useQueryClient();
  const storageKey = `cpredict-deposit:${api.key}:${session.identityKey}:${account.id}`;
  const [depositId, setDepositId] = useState<string | null>(() => {
    const parsed = z
      .string()
      .uuid()
      .safeParse(sessionStorage.getItem(storageKey));
    return parsed.success ? parsed.data : null;
  });
  const [source, setSource] = useState(
      session.wallets.find((w) => sameAddress(w.address, account.controller))
        ?.address ?? "",
    ),
    [amount, setAmount] = useState(""),
    [open, setOpen] = useState(false),
    [signature, setSignature] = useState<Hex | null>(null),
    [busy, setBusy] = useState<
      | "preparing"
      | "funding-signature"
      | "account-operation"
      | "cancelling"
      | null
    >(null),
    [stage, setStage] = useState<OperationStage | null>(null),
    [error, setError] = useState<unknown>(null),
    [otherOperation, setOtherOperation] = useState<string | null>(null);
  const wallet = session.wallets.find((w) => sameAddress(w.address, source));
  const mounted = useRef(true),
    walletEpoch = useRef(0);
  const context = useRef({ source, amount, open });
  context.current = { source, amount, open };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      walletEpoch.current++;
    };
  }, []);
  const enabled =
    env.features.gaslessDeposit === true &&
    env.features.sponsorship &&
    env.features.newExposure;
  const active = useQuery({
    queryKey: [api.key, "active-deposits", session.identityKey, account.id],
    queryFn: ({ signal }) =>
      api.request(
        `/v1/deposits?accountId=${account.id}&active=true`,
        depositPageSchema,
        { auth: true, signal },
      ),
    retry: 1,
    refetchInterval: 5000,
  });
  const key = [
    api.key,
    "deposit",
    session.identityKey,
    account.id,
    depositId,
  ] as const;
  const query = useQuery({
    queryKey: key,
    enabled: depositId !== null,
    queryFn: ({ signal }) =>
      api.request(`/v1/deposits/${depositId}`, responseSchema, {
        auth: true,
        signal,
      }),
    retry: 1,
    refetchInterval: (q) =>
      q.state.data && !pending(q.state.data.deposit) ? false : 3500,
  });
  const record = query.data?.deposit;
  const balance = useQuery({
    queryKey: [api.key, "funding-balance", source],
    enabled: !!wallet,
    queryFn: () =>
      api
        .publicClient()
        .readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [wallet!.address as `0x${string}`],
        }),
    staleTime: 10000,
    retry: 1,
  });
  const selectRecord = (d: Deposit) => {
    if (!mounted.current) return;
    setDepositId(d.id);
    sessionStorage.setItem(storageKey, d.id);
    cache.setQueryData(
      [api.key, "deposit", session.identityKey, account.id, d.id],
      { deposit: d },
    );
  };
  useEffect(() => {
    const d = active.data?.items[0];
    if (
      d &&
      (!depositId || (record && !pending(record))) &&
      d.id !== depositId
    ) {
      setDepositId(d.id);
      sessionStorage.setItem(storageKey, d.id);
      cache.setQueryData(
        [api.key, "deposit", session.identityKey, account.id, d.id],
        { deposit: d },
      );
    }
  }, [
    active.data,
    depositId,
    record,
    api.key,
    session.identityKey,
    account.id,
    storageKey,
    cache,
  ]);
  useEffect(() => {
    if (record?.state === "confirmed") {
      void cache.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === api.key &&
          [
            "balance",
            "funding-balance",
            "activity",
            "pnl",
            "active-deposits",
          ].includes(String(q.queryKey[1])),
      });
    }
  }, [record?.id, record?.state, api.key, cache]);
  useEffect(() => {
    if (!wallet) return;
    let disposed = false,
      cleanup = () => {};
    void wallet
      .getEthereumProvider()
      .then((provider) => {
        if (disposed) return;
        const p = provider as typeof provider & {
          on?: (event: string, listener: (value: unknown) => void) => void;
          removeListener?: (
            event: string,
            listener: (value: unknown) => void,
          ) => void;
        };
        const invalidate = () => {
          walletEpoch.current++;
          if (mounted.current) {
            setSignature(null);
            if (context.current.open)
              setError(new AppError("confirmation_context_changed", 409));
          }
        };
        const accountsChanged = (value: unknown) => {
          if (
            !Array.isArray(value) ||
            !value.some(
              (a) => typeof a === "string" && sameAddress(a, wallet.address),
            )
          )
            invalidate();
        };
        const chainChanged = (value: unknown) => {
          try {
            if (BigInt(String(value)) !== 421614n) invalidate();
          } catch {
            invalidate();
          }
        };
        p.on?.("accountsChanged", accountsChanged);
        p.on?.("chainChanged", chainChanged);
        p.on?.("disconnect", invalidate);
        cleanup = () => {
          p.removeListener?.("accountsChanged", accountsChanged);
          p.removeListener?.("chainChanged", chainChanged);
          p.removeListener?.("disconnect", invalidate);
        };
      })
      .catch(() => {
        /* The explicit signing action reports connection errors. */
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [wallet]);
  const guard = () => {
    const captured = { ...context.current },
      epoch = walletEpoch.current;
    return () =>
      mounted.current &&
      context.current.source === captured.source &&
      context.current.amount === captured.amount &&
      context.current.open === captured.open &&
      walletEpoch.current === epoch;
  };
  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy("preparing");
    setSignature(null);
    setOtherOperation(null);
    const current = guard();
    try {
      if (!wallet) throw new AppError("deposit_source_required");
      const value = parseAssetAmount(amount);
      if (balance.data === undefined || value > balance.data)
        throw new AppError("deposit_insufficient_balance", 409);
      const result = await api.request("/v1/deposits/prepare", responseSchema, {
        auth: true,
        body: {
          accountId: account.id,
          source: wallet.address,
          amount: value.toString(),
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (!current()) throw new AppError("confirmation_context_changed", 409);
      assertDepositContext(result.deposit, api, account, wallet.address, value);
      selectRecord(result.deposit);
      setOpen(true);
    } catch (e) {
      if (mounted.current) {
        setError(e);
        void active.refetch();
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const resume = () => {
    if (!record) return;
    setSource(record.authorization.from);
    setAmount(formatUnits(BigInt(record.authorization.value), 6));
    setSignature(null);
    setError(null);
    setOtherOperation(null);
    setOpen(true);
  };
  const signFunding = async () => {
    if (!record || !wallet || busy) return;
    setError(null);
    setBusy("funding-signature");
    const current = guard();
    try {
      assertDepositContext(
        record,
        api,
        account,
        wallet.address,
        parseAssetAmount(amount),
      );
      const signed = await signDepositAuthorization(
        api,
        record,
        wallet,
        current,
      );
      if (current()) setSignature(signed);
    } catch (e) {
      if (mounted.current) {
        setSignature(null);
        setError(e);
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const submit = async () => {
    if (!record || !signature || busy || record.operationId) return;
    setBusy("account-operation");
    setError(null);
    const current = guard(),
      d = record;
    const onRecord = (o: Operation) => {
      if (!mounted.current) return;
      if (o.intent.kind !== "deposit-usdc" || o.intent.depositId !== d.id) {
        setOtherOperation(o.id);
        return;
      }
      selectRecord({
        ...d,
        operationId: o.id,
        state: o.state,
        userOperationHash: o.userOperationHash,
        transactionHash: o.transactionHash,
        blockNumber: o.blockNumber,
        blockHash: o.blockHash,
        actualGasCost: o.actualGasCost,
        finality: o.finality,
        reason: o.reason,
        updatedAt: o.updatedAt,
      });
    };
    try {
      assertDepositContext(d, api, account, source, parseAssetAmount(amount));
      const client = new UserOperationClient(
        api,
        account,
        () => session.controller(account),
        current,
      );
      const o = await client.submit(
        {
          kind: "deposit-usdc",
          depositId: d.id,
          authorization: d.authorization,
          signature,
        },
        onRecord,
        (value) => {
          if (mounted.current) setStage(value);
        },
      );
      if (o.intent.kind !== "deposit-usdc" || o.intent.depositId !== d.id)
        throw new AppError("operation_query_required", 409);
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      if (mounted.current) {
        setBusy(null);
        setStage(null);
        setSignature(null);
        void query.refetch();
        void active.refetch();
      }
    }
  };
  const cancel = async () => {
    if (!record || busy) return;
    setBusy("cancelling");
    setError(null);
    try {
      const result = await api.request(
        `/v1/deposits/${record.id}/cancel`,
        responseSchema,
        { auth: true, body: {} },
      );
      selectRecord(result.deposit);
      setSignature(null);
      setOpen(false);
      void active.refetch();
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const close = () => {
    context.current.open = false;
    setOpen(false);
    setSignature(null);
    walletEpoch.current++;
  };
  const hasPending =
    !!(record && pending(record)) || !!active.data?.items.length;
  return (
    <div
      className="stack"
      style={{ borderTop: "1px solid var(--line)", paddingTop: 20 }}
    >
      <h3>免 Gas 入金</h3>
      <p className="small">
        将资金钱包中的 Arbitrum Sepolia USDC
        转入当前应用账户。需要两次授权，网络 Gas 由项目申请代付。
      </p>
      {!enabled && <Notice>当前暂停免 Gas 入金，已有记录仍可查询。</Notice>}
      <form className="stack" onSubmit={(event) => void prepare(event)}>
        <Field label="资金钱包">
          <select
            aria-label="资金钱包"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSignature(null);
              walletEpoch.current++;
            }}
            disabled={!!busy || hasPending}
          >
            <option value="">选择持有 USDC 的钱包</option>
            {source && !wallet && (
              <option value={source}>请重新连接 {shortAddress(source)}</option>
            )}
            {session.wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {w.walletClientType === "privy"
                  ? "内嵌钱包"
                  : w.walletClientType}{" "}
                · {shortAddress(w.address)}
              </option>
            ))}
          </select>
        </Field>
        <Button
          variant="secondary"
          disabled={!!busy}
          onClick={session.connectFundingWallet}
        >
          连接资金钱包
        </Button>
        <p className="small">连接资金钱包不会更换当前应用账户。</p>
        {wallet && (
          <p className="small">
            资金钱包余额：
            <Amount value={balance.data?.toString()} asset="USDC" />
          </p>
        )}
        <Field
          label="入金数量（USDC）"
          hint="最多 6 位小数；请先在资金钱包准备测试 USDC。"
        >
          <input
            aria-label="入金数量（USDC）"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setSignature(null);
            }}
            disabled={!!busy || hasPending}
            placeholder="0.00"
            required
          />
        </Field>
        <Button
          type="submit"
          disabled={
            !enabled ||
            !!busy ||
            hasPending ||
            !wallet ||
            balance.data === undefined ||
            active.isPending ||
            !!active.error
          }
        >
          核对入金
        </Button>
      </form>
      {!open && (
        <ErrorNotice
          error={error ?? query.error ?? active.error ?? balance.error}
          retry={() => {
            if (depositId) void query.refetch();
            void active.refetch();
            if (wallet) void balance.refetch();
          }}
        />
      )}
      {busy === "preparing" && <Loading label="正在准备固定金额的入金授权" />}
      {record && (
        <div className="stack">
          <Notice tone={record.state === "confirmed" ? "success" : "info"}>
            入金记录 · {stateCopy(record)} ·{" "}
            <Amount value={record.authorization.value} asset="USDC" />
          </Notice>
          {query.data?.recovery === "unavailable" && (
            <Notice tone="warning">
              恢复查询暂不可用，保留上次已知状态，请勿重复入金。
            </Notice>
          )}
          <p className="small">
            资金来源 <AddressText value={record.authorization.from} /> →
            应用账户 <AddressText value={record.account} />
          </p>
          {record.operationId ? (
            <Link
              className="button button-secondary"
              to={`/${env.id}/history?operation=${record.operationId}`}
            >
              查看原入金操作
            </Link>
          ) : record.state === "awaiting-authorization" ? (
            <Button variant="secondary" disabled={!!busy} onClick={resume}>
              继续核对原入金
            </Button>
          ) : null}
          {["awaiting-authorization", "awaiting-signature"].includes(
            record.state,
          ) && (
            <Button
              variant="quiet"
              disabled={!!busy}
              onClick={() => void cancel()}
            >
              取消本次入金
            </Button>
          )}
          {record.state === "confirmed" && (
            <p className="small">
              USDC 转账事件已核对。余额若尚未更新，请重新查询；这不会再次入金。
            </p>
          )}
        </div>
      )}
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title="确认 USDC 入金"
        description="核对资金钱包、收款应用账户和两次授权。"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              关闭
            </Button>
            {record && !record.operationId && (
              <Button
                disabled={!enabled || !!busy || !wallet}
                onClick={() => void (signature ? submit() : signFunding())}
              >
                {signature ? "2. 确认应用账户接收" : "1. 授权 USDC 转出"}
              </Button>
            )}
          </>
        }
      >
        {record && (
          <div className="stack">
            <dl className="data-list">
              <dt>转出资金钱包</dt>
              <dd>
                <AddressText value={record.authorization.from} full />
              </dd>
              <dt>收款应用账户</dt>
              <dd>
                <AddressText value={record.account} full />
              </dd>
              <dt>应用账户控制钱包</dt>
              <dd>
                <AddressText value={account.controller} full />
              </dd>
              <dt>入金金额</dt>
              <dd>
                <Amount value={record.authorization.value} asset="USDC" />
              </dd>
              <dt>网络</dt>
              <dd>Arbitrum Sepolia</dd>
              <dt>授权截止时间</dt>
              <dd>{new Date(record.expiresAt).toLocaleString()}</dd>
              <dt>网络 Gas</dt>
              <dd>
                {record.userOperationHash
                  ? "项目代付已提交，等待链上结果"
                  : "等待项目代付准入"}
              </dd>
            </dl>
            <Notice>
              {signature
                ? "资金钱包授权已取得，下一步由应用账户控制钱包确认接收。"
                : "第一步仅授权本次固定金额的 USDC 转出；第二步由应用账户控制钱包确认执行。"}
            </Notice>
            {!wallet && (
              <Notice tone="warning">请连接上方所示的资金钱包后继续。</Notice>
            )}
            {busy && (
              <Loading
                label={
                  busy === "funding-signature"
                    ? "请在资金钱包中核对 USDC 授权"
                    : stage === "awaiting-signature"
                      ? "请在应用账户控制钱包中确认"
                      : stage === "submitting"
                        ? "正在提交，请勿重复操作"
                        : "正在校验账户与项目代付"
                }
              />
            )}
            {record.operationId && (
              <Link
                className="button button-secondary"
                to={`/${env.id}/history?operation=${record.operationId}`}
                onClick={close}
              >
                查询已登记的原操作
              </Link>
            )}
            {otherOperation && (
              <Link
                to={`/${env.id}/history?operation=${otherOperation}`}
                onClick={close}
              >
                查看此前未完成的操作
              </Link>
            )}
            <ErrorNotice error={error ?? query.error} />
            <p className="small">
              关闭窗口不会撤销已签署的 USDC
              授权；授权按上述时间到期。已提交或结果未知的操作只能继续查询。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
