import { useState, type FormEvent } from "react";
import type { Address } from "viem";
import type { CpredictClient } from "../../../offchain/sdk/src/index.js";
import {
  evidenceHashForSettlement,
  settlementEvidenceBlockReason,
  type CanonicalEvidenceUploader,
} from "./settlementEvidence.js";
import { useTransactionAction } from "./useTransactionAction.js";

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

type MarketLifecycleProps = {
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
  marketQuestion?: string | null;
  onTerminal?: () => void;
};

export function MarketLifecyclePanel(props: MarketLifecycleProps) {
  return (
    <MarketLifecycleForm
      key={JSON.stringify([
        props.vault.toLowerCase(),
        props.creatorMode,
        props.outcomeCount,
        props.outcomeLabels,
        props.marketQuestion,
      ])}
      {...props}
    />
  );
}

function MarketLifecycleForm(props: MarketLifecycleProps) {
  const [outcomeId, setOutcomeId] = useState("");
  const [evidenceSourceUri, setEvidenceSourceUri] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [voidConfirmed, setVoidConfirmed] = useState(false);
  const { state, run } = useTransactionAction();
  const blocked = state.pending || props.disabled === true;
  const phase = creatorSettlementPhase(props);
  const resolveAllowed = phase === null || phase === "creator-window";
  const creatorVoidAllowed =
    phase === null || phase === "before-close" || phase === "creator-window";
  const timeoutAllowed = phase === null || phase === "window-expired";
  const hasEvidenceUploader = props.uploadCanonicalEvidence !== undefined;
  const evidenceBlockReason = settlementEvidenceBlockReason(
    evidenceSourceUri,
    evidenceSummary,
    hasEvidenceUploader,
  );
  const evidenceBlocked = evidenceBlockReason !== null;
  const hasEvidenceDraft =
    evidenceSourceUri.length !== 0 || evidenceSummary.length !== 0;
  const selectedOutcome = outcomeId === "" ? null : Number(outcomeId);
  const validOutcome =
    selectedOutcome !== null &&
    Number.isInteger(selectedOutcome) &&
    selectedOutcome >= 0 &&
    selectedOutcome < props.outcomeCount;
  const selectedOutcomeLabel =
    validOutcome && selectedOutcome !== null
      ? outcomeOptionLabel(selectedOutcome, props.outcomeLabels)
      : null;

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !validOutcome ||
      !confirmed ||
      blocked ||
      evidenceBlocked ||
      !resolveAllowed
    )
      return;
    void run(async () => {
      const result = await props.client.resolve(
        props.vault,
        BigInt(outcomeId),
        await evidenceHashForSettlement(
          { sourceUri: evidenceSourceUri, summary: evidenceSummary },
          props.uploadCanonicalEvidence,
        ),
      );
      props.onTerminal?.();
      return result;
    });
  }

  async function creatorVoid() {
    const result = await props.client.creatorVoid(
      props.vault,
      await evidenceHashForSettlement(
        { sourceUri: evidenceSourceUri, summary: evidenceSummary },
        props.uploadCanonicalEvidence,
      ),
    );
    props.onTerminal?.();
    return result;
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
          <dl className="settlement-confirmation">
            <div>
              <dt>当前市场</dt>
              <dd>{props.marketQuestion ?? "请核对市场金库地址"}</dd>
            </div>
            <div>
              <dt>市场金库</dt>
              <dd className="mono">{props.vault}</dd>
            </div>
            <div>
              <dt>即将结算的结果</dt>
              <dd>{selectedOutcomeLabel ?? "尚未选择"}</dd>
            </div>
          </dl>
          <label>
            获胜结果
            <select
              value={outcomeId}
              onChange={(event) => {
                setOutcomeId(event.currentTarget.value);
                setConfirmed(false);
                setVoidConfirmed(false);
              }}
              disabled={blocked || !resolveAllowed}
            >
              <option value="" disabled>
                请选择实际获胜结果
              </option>
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
                placeholder="选填，可留空"
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
                placeholder="选填，可留空"
                value={evidenceSummary}
                onChange={(event) =>
                  setEvidenceSummary(event.currentTarget.value)
                }
              />
            </label>
            {hasEvidenceDraft ? (
              <button
                type="button"
                onClick={() => {
                  setEvidenceSourceUri("");
                  setEvidenceSummary("");
                }}
              >
                清空证据
              </button>
            ) : null}
            <p role="note">
              {hasEvidenceUploader
                ? "证据为可选项。两个字段都留空即按无证据结算。都填写时会生成规范文档并上传，链上只提交哈希。"
                : "证据为可选项，不是结算前置条件。当前部署未开启证据上传，请将两个字段留空后直接结算。"}
            </p>
            {evidenceBlockReason === null ? null : (
              <p role="alert">{evidenceBlockReason}</p>
            )}
          </fieldset>
          <label className="settlement-check">
            <input
              type="checkbox"
              disabled={blocked || !validOutcome || !resolveAllowed}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            {validOutcome
              ? `我已核对上述市场和锁定规则，确认结果为「${selectedOutcomeLabel}」，并理解结算不可撤销。`
              : "请先选择结果，再核对并确认结算。"}
          </label>
          <button
            disabled={
              !validOutcome ||
              !confirmed ||
              blocked ||
              evidenceBlocked ||
              !resolveAllowed
            }
            type="submit"
          >
            {blocked ? "处理中…" : "结算"}
          </button>
          <label className="settlement-check">
            <input
              type="checkbox"
              checked={voidConfirmed}
              disabled={blocked || !creatorVoidAllowed}
              onChange={(event) =>
                setVoidConfirmed(event.currentTarget.checked)
              }
            />
            我确认作废上述市场，不指定赢家，按份额退还本金，并理解作废不可撤销。
          </label>
          <button
            disabled={
              !voidConfirmed ||
              blocked ||
              evidenceBlocked ||
              !creatorVoidAllowed
            }
            type="button"
            onClick={() => {
              if (
                !voidConfirmed ||
                blocked ||
                evidenceBlocked ||
                !creatorVoidAllowed
              )
                return;
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
          void run(async () => {
            const result = await props.client.voidAfterDeadline(props.vault);
            props.onTerminal?.();
            return result;
          })
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
    return (
      <p role="status">
        该市场已终局，不能再次结算或作废。正常结算或创建者作废后，请在「creator
        押金退还」区域释放并领取押金；仅超时弃盘且有参与者时押金罚没。
      </p>
    );
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
