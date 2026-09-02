import { useEffect, useState } from "react";
import type { Address } from "viem";
import type {
  CpredictClient,
  CreateMarketInput,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
import {
  authorizationRequired,
  authorizeThenExecute,
} from "./authorizationFlow.js";

export function CreateMarketPanel(props: {
  client: Pick<CpredictClient, "approvePaymentToken" | "createMarket">;
  draft: CreateMarketInput;
  paymentToken: Address;
  creationFee: bigint;
  factoryAllowance?: bigint | null;
}) {
  const { state, run } = useTransactionAction();
  const { params } = props.draft;
  const requiredPayment = params.creatorBond + props.creationFee;
  const [factoryAllowance, setFactoryAllowance] = useState(
    props.factoryAllowance,
  );
  useEffect(
    () => setFactoryAllowance(props.factoryAllowance),
    [props.draft.factory, props.factoryAllowance],
  );

  async function approveFactory() {
    const result = await props.client.approvePaymentToken(
      props.paymentToken,
      props.draft.factory,
      requiredPayment,
    );
    setFactoryAllowance(requiredPayment);
    return result;
  }

  async function createMarket() {
    const needsAuthorization = authorizationRequired(
      factoryAllowance,
      requiredPayment,
    );
    const result = await authorizeThenExecute(
      needsAuthorization,
      approveFactory,
      () => props.client.createMarket(props.draft),
    );
    setFactoryAllowance(
      needsAuthorization
        ? 0n
        : (factoryAllowance ?? requiredPayment) - requiredPayment,
    );
    return result;
  }
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
        onClick={() => void run(approveFactory)}
      >
        Approve exact creation fee and bond
      </button>
      <button
        disabled={state.pending}
        onClick={() => void run(createMarket)}
      >
        {authorizationRequired(factoryAllowance, requiredPayment)
          ? "Authorize exact payment and create immutable market"
          : "Create immutable market"}
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
