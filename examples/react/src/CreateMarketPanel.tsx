import type { Address } from "viem";
import type {
  CpredictClient,
  CreateMarketInput,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";

export function CreateMarketPanel(props: {
  client: Pick<CpredictClient, "approvePaymentToken" | "createMarket">;
  draft: CreateMarketInput;
  paymentToken: Address;
  creationFee: bigint;
}) {
  const { state, run } = useTransactionAction();
  const { params } = props.draft;
  const requiredPayment = params.creatorBond + props.creationFee;
  return (
    <section aria-labelledby="create-market-title">
      <h2 id="create-market-title">Review and create market</h2>
      <dl>
        <dt>Rules commitment</dt>
        <dd>
          <code>{params.rulesHash}</code>
        </dd>
        <dt>Resolution source</dt>
        <dd>{params.resolutionSourceURI}</dd>
        <dt>Close</dt>
        <dd>{new Date(Number(params.closeAt) * 1000).toISOString()}</dd>
        <dt>Outcomes</dt>
        <dd>{params.outcomeCount}</dd>
        <dt>Market cap</dt>
        <dd>{params.marketPrimaryCap.toString()} atomic USDC</dd>
        <dt>Creation fee + bond</dt>
        <dd>{requiredPayment.toString()} atomic USDC</dd>
        <dt>Deployment</dt>
        <dd>
          {params.deploymentMode === 0
            ? "Full"
            : "Clone (higher implementation risk)"}
        </dd>
      </dl>
      <button
        disabled={state.pending}
        onClick={() =>
          void run(() =>
            props.client.approvePaymentToken(
              props.paymentToken,
              props.draft.factory,
              requiredPayment,
            ),
          )
        }
      >
        Approve exact creation fee and bond
      </button>
      <button
        disabled={state.pending}
        onClick={() => void run(() => props.client.createMarket(props.draft))}
      >
        Create immutable market
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
