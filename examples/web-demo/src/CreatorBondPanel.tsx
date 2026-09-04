import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex, PublicClient } from "viem";
import {
  classifyProtocolError,
  type CpredictClient,
} from "../../../offchain/sdk/src/index.js";
import { BondSubmissionUnknownError } from "../../../offchain/sdk/src/client.js";
import type { ExecuteTransaction } from "./CreateMarketForm.js";
import { formatPaymentToken, type MarketSnapshot } from "./protocol.js";
import {
  bondDisposition,
  readBondReceipt,
  readCreatorBond,
  type BondAction,
  type BondSubmission,
  type CreatorBondSnapshot,
} from "./creator-bond.js";
import {
  BondStorageUnavailableError,
  loadBondOperation,
  saveBondOperation,
} from "./bond-operation-storage.js";

interface CreatorBondPanelProps {
  market: MarketSnapshot;
  wallet: Address;
  escrow: Address | null;
  chainId: number;
  publicClient: PublicClient | null;
  client: Pick<CpredictClient, "settleBond" | "claimBondFor">;
  execute: ExecuteTransaction;
  writeReady: boolean;
  busy: boolean;
  refreshVersion: number;
  paymentTokenSymbol: string;
}

export function CreatorBondPanel(props: CreatorBondPanelProps) {
  // A changed asset/actor identity must never render the previous request or receipt.
  return (
    <CreatorBondSession
      key={`${props.chainId}:${props.wallet}:${props.escrow}:${props.market.address}:${props.market.creator}`}
      {...props}
    />
  );
}

function useCreatorBond(props: CreatorBondPanelProps) {
  const {
    publicClient,
    escrow,
    chainId,
    wallet,
    market,
    paymentTokenSymbol: symbol,
  } = props;
  const identity = useMemo(
    () =>
      escrow === null
        ? null
        : {
            chainId,
            wallet,
            escrow,
            market: market.address,
            creator: market.creator,
          },
    [chainId, wallet, escrow, market.address, market.creator],
  );
  const [restored] = useState(() => {
    try {
      return {
        submission:
          typeof window === "undefined" || identity === null
            ? null
            : loadBondOperation(identity),
        error: "",
        warning: "",
      };
    } catch (cause: unknown) {
      if (cause instanceof BondStorageUnavailableError) {
        return {
          submission: null,
          error: "",
          warning:
            "浏览器存储不可用，本页仍可操作；请保留交易哈希并在离开前核对结果，刷新后不能自动恢复记录。",
        };
      }
      return {
        submission: null,
        error:
          "无法核对本页保存的押金操作记录。请先检查钱包中的原交易，勿重复提交。",
        warning: "",
      };
    }
  });
  const [snapshot, setSnapshot] = useState<CreatorBondSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [submission, setSubmission] = useState<BondSubmission | null>(
    restored.submission,
  );
  const submissionRef = useRef(restored.submission);
  const [message, setMessage] = useState(
    restored.submission === null
      ? ""
      : "发现未核实的押金交易，请核对原交易结果；不会重新提交。",
  );
  const [receiptMessage, setReceiptMessage] = useState("");
  const [receiptHash, setReceiptHash] = useState("");
  const [storageWarning, setStorageWarning] = useState(restored.warning);
  const [recoveryHash, setRecoveryHash] = useState("");
  const active = useRef(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const minimumBlock = useRef(0n);
  const writable = useRef(props.writeReady);
  useEffect(() => {
    writable.current = props.writeReady;
  }, [props.writeReady]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++request.current;
    if (publicClient === null || identity === null) {
      setSnapshot(null);
      setReadError("押金状态未知：RPC 或押金托管地址尚不可用。");
      return null;
    }
    setLoading(true);
    try {
      const next = await readCreatorBond(
        publicClient,
        identity,
        minimumBlock.current,
      );
      if (!mounted.current || generation !== request.current) return null;
      setSnapshot(next);
      setReadError("");
      return next;
    } catch (cause: unknown) {
      if (mounted.current && generation === request.current) {
        setSnapshot(null);
        setReadError(`押金状态未知：${classifyProtocolError(cause).message}`);
      }
      return null;
    } finally {
      if (mounted.current && generation === request.current) setLoading(false);
    }
  }, [publicClient, identity]);
  useEffect(() => {
    if (!active.current) void refresh();
    const timer = window.setInterval(() => {
      if (!active.current) void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh, props.refreshVersion, market.marketState, market.voidReason]);

  function remember(next: BondSubmission | null) {
    submissionRef.current = next;
    if (mounted.current) setSubmission(next);
    if (identity === null) return;
    try {
      saveBondOperation(identity, next);
    } catch {
      if (mounted.current)
        setStorageWarning(
          "浏览器未保存恢复记录，请保留交易哈希；离开页面前先核对结果。",
        );
    }
  }

  async function checkReceipt(pending: BondSubmission) {
    if (publicClient === null || identity === null) return;
    try {
      const receipt = await readBondReceipt(publicClient, identity, pending);
      if (!mounted.current) return;
      minimumBlock.current = receipt.blockNumber;
      if (receipt.status === "reverted") {
        setMessage(
          "原押金交易已确认失败，没有完成该操作；请刷新状态后再决定是否重试。",
        );
      } else {
        setReceiptHash(pending.hash ?? "");
        setReceiptMessage(
          receipt.status === "claimed"
            ? `押金已到账：${formatPaymentToken(receipt.amount, symbol)} 已转给 creator。这是本次聚合领取的实际金额，不是单个市场的到账归属。`
            : receipt.status === "released"
              ? `押金已释放：${formatPaymentToken(receipt.amount, symbol)} 已记入 creator 可领取余额，尚未转入钱包。请继续领取押金。`
              : `罚没押金已转入该市场超时奖励池：${formatPaymentToken(receipt.amount, symbol)}，不是平台收入。`,
        );
        setMessage("");
      }
      remember(null);
    } catch {
      if (mounted.current)
        setMessage(
          "押金交易结果或到账事件仍待核实。请核对原交易结果；不会重复提交。",
        );
    }
  }

  async function recover() {
    if (active.current || submissionRef.current === null) return;
    let pending = submissionRef.current;
    if (pending.hash === null) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())) {
        setMessage(
          "请从钱包复制本次原交易的完整哈希，仅用于只读核对，不会重新提交。",
        );
        return;
      }
      pending = { ...pending, hash: recoveryHash.trim() as Hex };
      // Do not persist an unverified user-supplied hash over the original unknown record.
    }
    active.current = true;
    setWorking(true);
    try {
      await checkReceipt(pending);
      if (mounted.current) await refresh();
    } finally {
      active.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function handleAction(action: BondAction) {
    if (
      active.current ||
      props.busy ||
      !props.writeReady ||
      submissionRef.current !== null ||
      restored.error !== "" ||
      identity === null ||
      publicClient === null
    )
      return;
    active.current = true;
    setWorking(true);
    setMessage("正在重新核对链上押金状态…");
    try {
      const fresh = await refresh();
      if (fresh === null || !mounted.current || !writable.current) return;
      if (action === "release" && (fresh.settled || fresh.marketState === 0)) {
        setMessage(
          fresh.settled
            ? "该盘押金已经处理，无需重复释放；请按最新余额继续。"
            : "市场尚未终局，押金暂不能释放。",
        );
        return;
      }
      if (action === "claim" && fresh.credit === 0n) {
        setMessage("creator 当前没有可领取押金，未提交交易。");
        return;
      }
      if (action === "claim" && fresh.credit !== snapshot?.credit) {
        setMessage("可领取总额已变化，请确认最新金额后再次点击领取。");
        return;
      }
      let started = false;
      await props.execute(
        action === "release" ? "处理押金释放" : "领取 creator 押金",
        async () => {
          started = true;
          if (!mounted.current || !writable.current)
            throw new Error("账户或网络已变化，未提交押金操作。");
          setMessage("请在钱包确认本步交易；不会自动执行下一步。");
          try {
            const onSubmitted = (hash: Hex) => {
              remember({
                action,
                hash,
                afterBlock: fresh.blockNumber.toString(),
              });
              if (mounted.current)
                setMessage("押金交易已提交，正在等待链上回执…");
            };
            const result =
              action === "release"
                ? await props.client.settleBond(
                    identity.escrow,
                    identity.market,
                    onSubmitted,
                  )
                : await props.client.claimBondFor(
                    identity.escrow,
                    identity.creator,
                    onSubmitted,
                  );
            if (submissionRef.current === null)
              remember({
                action,
                hash: result.hash,
                afterBlock: fresh.blockNumber.toString(),
              });
            minimumBlock.current = result.blockNumber;
            // Preserve successful execution before the caller performs unrelated refreshes.
            if (mounted.current) {
              setReceiptHash(result.hash);
              setReceiptMessage(
                "押金交易已成功，实际处理金额待回执事件核对；这不等于已确认到账。",
              );
            }
            return result;
          } catch (cause: unknown) {
            if (cause instanceof BondSubmissionUnknownError) {
              remember({
                action,
                hash: null,
                afterBlock: fresh.blockNumber.toString(),
              });
            }
            if (mounted.current)
              setMessage(
                submissionRef.current === null
                  ? `押金操作未完成：${classifyProtocolError(cause).message}。未自动重试；提交情况不明时请先检查钱包记录。`
                  : submissionRef.current.hash === null
                    ? "钱包提交结果未知，未取得交易哈希；请先核对钱包记录，不要重复提交。"
                    : "押金交易已提交，结果待核实；请查询原交易，不要重复提交。",
              );
            throw cause;
          }
        },
      );
      if (!mounted.current) return;
      if (!started)
        setMessage("押金操作未启动，请检查钱包、网络或其他进行中的交易。");
      if (submissionRef.current !== null)
        await checkReceipt(submissionRef.current);
      await refresh();
    } catch (cause: unknown) {
      if (mounted.current)
        setMessage(`暂未完成押金操作：${classifyProtocolError(cause).message}`);
    } finally {
      active.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return {
    snapshot,
    readError,
    loading,
    working,
    message,
    receiptMessage,
    receiptHash,
    submission,
    storageWarning,
    recoveryHash,
    setRecoveryHash,
    restoreError: restored.error,
    refresh,
    handleAction,
    recover,
  };
}

function CreatorBondSession(props: CreatorBondPanelProps) {
  const { market, paymentTokenSymbol: symbol } = props;
  const {
    snapshot,
    readError,
    loading,
    working,
    message,
    receiptMessage,
    receiptHash,
    submission,
    storageWarning,
    recoveryHash,
    setRecoveryHash,
    restoreError,
    refresh,
    handleAction,
    recover,
  } = useCreatorBond(props);
  const disposition = snapshot === null ? null : bondDisposition(snapshot);
  const disabled =
    props.busy ||
    working ||
    loading ||
    !props.writeReady ||
    snapshot === null ||
    submission !== null ||
    restoreError !== "";
  const releaseLabel =
    disposition === "timeout-pending" ? "将罚没押金转入奖励池" : "释放押金";
  return (
    <section
      className="panel creator-bond-panel"
      aria-label="creator 押金退还"
      aria-busy={loading || working}
    >
      <header className="panel-heading">
        <div>
          <h3>creator 押金退还</h3>
          <p>
            结算或作废成功 ≠
            押金已到账。押金只在超时弃盘且该盘有本金时罚没；空市场超时仍可退。
          </p>
        </div>
      </header>
      <p className="bond-state" data-testid="bond-state">
        {readError ||
          (snapshot === null
            ? "正在读取押金状态…"
            : disposition === "credited" && snapshot.credit === 0n
              ? "该盘押金已释放 · 当前没有可领取押金。"
              : BOND_STATE_COPY[disposition!])}
      </p>
      {receiptMessage ? (
        <div className="callout bond-receipt" role="status">
          {receiptMessage}
          <div className="mono">{receiptHash}</div>
        </div>
      ) : null}
      <dl className="bond-amounts">
        <div>
          <dt>当前市场 · 链 {props.chainId}</dt>
          <dd className="mono">{market.address}</dd>
        </div>
        <div>
          <dt>该盘押金</dt>
          <dd>
            {snapshot === null
              ? "未知"
              : formatPaymentToken(snapshot.amount, symbol)}
          </dd>
        </div>
        <div>
          <dt>creator 可领取总额（跨市场）</dt>
          <dd>
            {snapshot === null
              ? "未知"
              : formatPaymentToken(snapshot.credit, symbol)}
          </dd>
        </div>
        <div>
          <dt>固定收款地址 · creator</dt>
          <dd className="mono">{market.creator}</dd>
        </div>
      </dl>
      <p>
        「释放押金」只记账；「领取押金」才转入钱包，合并该 creator
        在此托管合约已释放的全部押金，不是仅领取本盘。EOA
        分步确认，每步独立交易。
      </p>
      {snapshot?.credit === 0n && disposition === "credited" ? (
        <p>
          当前无可领取余额。不能仅凭余额为零判断本盘何时到账，请核对历史领取交易。
        </p>
      ) : null}
      {snapshot !== null ? (
        <p className="muted">
          链上快照：区块 {snapshot.blockNumber.toString()} · 提交前重新核对
        </p>
      ) : null}
      <div className="operation-grid">
        <button
          disabled={
            disabled || disposition === "locked" || snapshot?.settled !== false
          }
          onClick={() => void handleAction("release")}
        >
          {releaseLabel}
        </button>
        <button
          disabled={disabled || (snapshot?.credit ?? 0n) === 0n}
          onClick={() => void handleAction("claim")}
        >
          领取押金
        </button>
        <button disabled={working || loading} onClick={() => void refresh()}>
          刷新押金状态
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {submission !== null ? (
        <div className="callout">
          {submission.hash === null ? (
            <label>
              钱包中的原交易哈希
              <input
                value={recoveryHash}
                onChange={(event) => setRecoveryHash(event.target.value)}
                placeholder="从钱包记录复制 0x…，仅查询，不发送交易"
              />
            </label>
          ) : (
            <p>
              原交易哈希：<span className="mono">{submission.hash}</span>
            </p>
          )}
          <button disabled={working} onClick={() => void recover()}>
            核对原交易结果
          </button>
        </div>
      ) : null}
      {restoreError ? <p role="alert">{restoreError}</p> : null}
      {storageWarning ? <p role="alert">{storageWarning}</p> : null}
    </section>
  );
}

const BOND_STATE_COPY = {
  locked: "尚未终局 · 押金仍在托管，结算或作废后按规则处理。",
  "return-pending":
    "押金待退还 · 第 1 步：释放押金；第 2 步：领取到 creator 钱包。",
  credited: "该盘押金已释放 · 请核对 creator 可领取总额，继续领取。",
  "timeout-pending":
    "超时弃盘且有本金 · 该盘押金应罚没，待转入参与者奖励池，不退 creator。",
  "timeout-funded": "该盘押金已罚没并转入参与者奖励池，不退 creator。",
} as const;
