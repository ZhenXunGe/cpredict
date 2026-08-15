import type { Address } from "viem";
import type { CpredictClient } from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";

export function ClaimsPanel(props: {
  client: Pick<
    CpredictClient,
    "claimWinner" | "claimEarlyBird" | "refund" | "claimTimeoutBonus"
  >;
  vault: Address;
  owner: Address;
}) {
  const { state, run } = useTransactionAction();
  return (
    <section aria-labelledby="claims-title">
      <h2 id="claims-title">Claims and refunds</h2>
      <p>
        Every relayed claim pays the fixed owner address shown below; the caller
        cannot redirect it.
      </p>
      <code>{props.owner}</code>
      <div>
        <button
          disabled={state.pending}
          onClick={() =>
            void run(() => props.client.claimWinner(props.vault, props.owner))
          }
        >
          Claim winnings
        </button>
        <button
          disabled={state.pending}
          onClick={() =>
            void run(() =>
              props.client.claimEarlyBird(props.vault, props.owner),
            )
          }
        >
          Claim early-bird reward
        </button>
        <button
          disabled={state.pending}
          onClick={() =>
            void run(() => props.client.refund(props.vault, props.owner))
          }
        >
          Refund principal
        </button>
        <button
          disabled={state.pending}
          onClick={() =>
            void run(() =>
              props.client.claimTimeoutBonus(props.vault, props.owner),
            )
          }
        >
          Claim timeout bond bonus
        </button>
      </div>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
