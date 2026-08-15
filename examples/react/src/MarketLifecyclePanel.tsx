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
  uploadCanonicalEvidence?: CanonicalEvidenceUploader | undefined;
}) {
  const [outcomeId, setOutcomeId] = useState("0");
  const [evidenceSourceUri, setEvidenceSourceUri] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { state, run } = useTransactionAction();

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcome = BigInt(outcomeId);
    if (!confirmed || outcome < 0n || outcome >= BigInt(props.outcomeCount))
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
      <h2 id="market-lifecycle-title">Market settlement</h2>
      <p role="note">
        Creator settlement is unilateral and irreversible. The protocol does not
        adjudicate whether the selected outcome is true.
      </p>
      {props.creatorMode ? (
        <form onSubmit={resolve} aria-busy={state.pending}>
          <label>
            Winning outcome
            <input
              value={outcomeId}
              inputMode="numeric"
              onChange={(event) => setOutcomeId(event.currentTarget.value)}
            />
          </label>
          <fieldset disabled={state.pending}>
            <legend>Optional settlement evidence</legend>
            <label>
              Evidence source URI
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
              Evidence summary
              <textarea
                maxLength={2_048}
                value={evidenceSummary}
                onChange={(event) =>
                  setEvidenceSummary(event.currentTarget.value)
                }
              />
            </label>
            <p role="note">
              This repository does not upload evidence. When both fields are
              supplied, it builds exact canonical UTF-8 bytes, delegates those
              bytes to the injected IPFS uploader, verifies the returned
              deterministic URI, and only then submits the SHA-256 hash.
            </p>
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            I verified the locked rules and understand settlement is final.
          </label>
          <button disabled={!confirmed || state.pending} type="submit">
            Resolve
          </button>
          <button
            disabled={!confirmed || state.pending}
            type="button"
            onClick={() => void run(creatorVoid)}
          >
            Creator void
          </button>
        </form>
      ) : null}
      <button
        disabled={state.pending}
        type="button"
        onClick={() =>
          void run(() => props.client.voidAfterDeadline(props.vault))
        }
      >
        Permissionless timeout void
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
