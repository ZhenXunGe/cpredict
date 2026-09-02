import { useState, type FormEvent } from "react";
import type { Address } from "viem";
import type { CpredictClient } from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
import {
  evidenceHashForSettlement,
  type CanonicalEvidenceUploader,
} from "./settlementEvidence.js";

export type CreatorSettlementPhase =
  "before-close" | "creator-window" | "window-expired" | "terminal";

export function creatorSettlementPhase(input: {
  marketState?: number | undefined;
  observedAt?: bigint | undefined;
  closeAt?: bigint | undefined;
  resolutionDeadline?: bigint | undefined;
}): CreatorSettlementPhase | null {
  if (
    input.observedAt === undefined ||
    input.closeAt === undefined ||
    input.resolutionDeadline === undefined
  )
    return null;
  if (input.marketState !== undefined && input.marketState !== 0)
    return "terminal";
  if (input.observedAt < input.closeAt) return "before-close";
  if (input.observedAt >= input.resolutionDeadline) return "window-expired";
  return "creator-window";
}

export function outcomeOptionLabel(
  index: number,
  labels: readonly string[] | null | undefined,
): string {
  const name = labels?.[index]?.trim();
  return name === undefined || name === "" ? `结果 ${index + 1}` : name;
}

export function MarketLifecyclePanel(props: {
  client: Pick<CpredictClient, "resolve" | "creatorVoid" | "voidAfterDeadline">;
  vault: Address;
  outcomeCount: number;
  creatorMode: boolean;
  disabled?: boolean;
  uploadCanonicalEvidence?: CanonicalEvidenceUploader | undefined;
  outcomeLabels?: readonly string[] | null | undefined;
  closeAt?: bigint | undefined;
  resolutionDeadline?: bigint | undefined;
  observedAt?: bigint | undefined;
  marketState?: number | undefined;
}) {
  const [outcomeId, setOutcomeId] = useState("0");
  const [evidenceSourceUri, setEvidenceSourceUri] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { state, run } = useTransactionAction();
  const blocked = state.pending || props.disabled === true;
  const phase = creatorSettlementPhase(props);
  const resolveAllowed = phase === null || phase === "creator-window";
  const creatorVoidAllowed =
    phase === null || phase === "before-close" || phase === "creator-window";
  const timeoutAllowed = phase === null || phase === "window-expired";

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcome = BigInt(outcomeId);
    if (
      !confirmed ||
      blocked ||
      !resolveAllowed ||
      outcome < 0n ||
      outcome >= BigInt(props.outcomeCount)
    )
      return;
    void run(async () =>
      props.client.resolve(
        props.vault,
        outcome,
        await evidenceHashForSettlement(
          { sourceUri: evidenceSourceUri, summary: evidenceSummary },
          props.uploadCanonicalEvidence,
        ),
      ),
    );
  }

  async function creatorVoid() {
    return props.client.creatorVoid(
      props.vault,
      await evidenceHashForSettlement(
        { sourceUri: evidenceSourceUri, summary: evidenceSummary },
        props.uploadCanonicalEvidence,
      ),
    );
  }

  return (
    <section aria-labelledby="market-lifecycle-title">
      <h2 id="market-lifecycle-title">市场结算</h2>
      <p role="note">
        创建者结算是单方面且不可逆的。协议不会裁定所选结果是否为真。
      </p>
      <SettlementWindowStatus
        phase={phase}
        closeAt={props.closeAt}
        resolutionDeadline={props.resolutionDeadline}
        observedAt={props.observedAt}
      />
      {props.creatorMode ? (
        <form onSubmit={resolve} aria-busy={blocked}>
          <label>
            获胜结果
            <select
              value={outcomeId}
              onChange={(event) => setOutcomeId(event.currentTarget.value)}
              disabled={blocked || !resolveAllowed}
            >
              {Array.from({ length: props.outcomeCount }, (_, index) => (
                <option value={String(index)} key={index}>
                  {outcomeOptionLabel(index, props.outcomeLabels)}
                </option>
              ))}
            </select>
          </label>
          <p role="note">
            选择实际获胜的一方，例如「是」或「否」。不要填写数字编号。
          </p>
          <fieldset disabled={blocked}>
            <legend>可选结算证据</legend>
            <label>
              证据来源 URI
              <input
                type="url"
                maxLength={512}
                value={evidenceSourceUri}
                onChange={(event) =>
                  setEvidenceSourceUri(event.currentTarget.value)
                }
              />
            </label>
            <label>
              证据摘要
              <textarea
                maxLength={2_048}
                value={evidenceSummary}
                onChange={(event) =>
                  setEvidenceSummary(event.currentTarget.value)
                }
              />
            </label>
            <p role="note">
              本仓库不会上传证据。两个字段都填写时，会生成规范 UTF-8
              字节，交给注入的 IPFS 上传器，校验返回的确定性 URI，然后才提交
              SHA-256 哈希。
            </p>
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            我已核对锁定规则，并理解结算不可撤销。
          </label>
          <button
            disabled={!confirmed || blocked || !resolveAllowed}
            type="submit"
          >
            {blocked ? "处理中…" : "结算"}
          </button>
          <button
            disabled={!confirmed || blocked || !creatorVoidAllowed}
            type="button"
            onClick={() => {
              if (!confirmed || blocked || !creatorVoidAllowed) return;
              void run(creatorVoid);
            }}
          >
            {blocked ? "处理中…" : "创建者作废"}
          </button>
        </form>
      ) : null}
      <button
        disabled={blocked || !timeoutAllowed}
        type="button"
        onClick={() =>
          void run(() => props.client.voidAfterDeadline(props.vault))
        }
      >
        {blocked ? "处理中…" : "超时作废"}
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}

function SettlementWindowStatus(props: {
  phase: CreatorSettlementPhase | null;
  closeAt?: bigint | undefined;
  resolutionDeadline?: bigint | undefined;
  observedAt?: bigint | undefined;
}) {
  if (props.phase === null) return null;
  if (props.phase === "terminal") {
    return <p role="status">该市场已终局，不能再次结算或作废。</p>;
  }
  if (props.phase === "before-close") {
    const closeAt = props.closeAt;
    return (
      <p role="status">
        市场尚未截止
        {closeAt === undefined ? "" : `（${formatClock(closeAt)}）`}
        ，不能指定获胜结果。截止前仍可创建者作废。
      </p>
    );
  }
  if (props.phase === "window-expired") {
    const deadline = props.resolutionDeadline;
    return (
      <p role="alert">
        创建者结算窗口已过
        {deadline === undefined ? "" : `（截止 ${formatClock(deadline)}）`}
        。现在不能指定获胜结果，只能点「超时作废」把本金退还给所有人。
      </p>
    );
  }
  const deadline = props.resolutionDeadline;
  const observedAt = props.observedAt;
  const remaining =
    deadline === undefined || observedAt === undefined
      ? null
      : deadline - observedAt;
  return (
    <p role="status">
      市场已截止。请在
      {deadline === undefined ? "结算窗口结束" : ` ${formatClock(deadline)} `}
      前指定获胜结果
      {remaining === null ? "" : `（剩余 ${formatRemaining(remaining)}）`}
      。逾期后不能再选赢家，只能超时作废并全员退本。
    </p>
  );
}

function formatClock(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function formatRemaining(seconds: bigint): string {
  if (seconds <= 0n) return "已结束";
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "—";
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${Math.max(1, Math.floor(total))} 秒`;
}
