import { useState, type FormEvent } from "react";
import type { Address } from "viem";
import type { CpredictClient } from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
import {
  evidenceHashForSettlement,
  type CanonicalEvidenceUploader,
} from "./settlementEvidence.js";

export function MarketLifecyclePanel(props: {
  client: Pick<CpredictClient, "resolve" | "creatorVoid" | "voidAfterDeadline">;
  vault: Address;
  outcomeCount: number;
  creatorMode: boolean;
  disabled?: boolean;
  uploadCanonicalEvidence?: CanonicalEvidenceUploader | undefined;
}) {
  const [outcomeId, setOutcomeId] = useState("0");
  const [evidenceSourceUri, setEvidenceSourceUri] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { state, run } = useTransactionAction();
  const blocked = state.pending || props.disabled === true;

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcome = BigInt(outcomeId);
    if (
      !confirmed ||
      blocked ||
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
      {props.creatorMode ? (
        <form onSubmit={resolve} aria-busy={blocked}>
          <label>
            获胜结果
            <input
              value={outcomeId}
              inputMode="numeric"
              onChange={(event) => setOutcomeId(event.currentTarget.value)}
            />
          </label>
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
          <button disabled={!confirmed || blocked} type="submit">
            {blocked ? "处理中…" : "结算"}
          </button>
          <button
            disabled={!confirmed || blocked}
            type="button"
            onClick={() => void run(creatorVoid)}
          >
            {blocked ? "处理中…" : "创建者作废"}
          </button>
        </form>
      ) : null}
      <button
        disabled={blocked}
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
