import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import {
  buildBuyPermit2TypedData,
  BUY_WITH_PERMIT2_SELECTOR,
  type CpredictClient,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
import {
  authorizationRequired,
  authorizeThenExecute,
} from "./authorizationFlow.js";
import { transactionDeadline } from "./transactionTiming.js";

export interface TypedDataSigner {
  signTypedData(
    data: ReturnType<typeof buildBuyPermit2TypedData>,
  ): Promise<Hex>;
}

export function PrimaryPaymentPanel(props: {
  client: Pick<
    CpredictClient,
    "approvePaymentToken" | "buy" | "buyWithPermit2"
  >;
  signer: TypedDataSigner;
  chainId: bigint;
  permit2: Address;
  paymentToken: Address;
  owner: Address;
  vault: Address;
  outcomeId: bigint;
  units: bigint;
  permitNonce: bigint;
  vaultAllowance?: bigint | null;
  permit2Allowance?: bigint | null;
}) {
  const { state, run } = useTransactionAction();
  const [vaultAllowance, setVaultAllowance] = useState(props.vaultAllowance);
  const [permit2Allowance, setPermit2Allowance] = useState(
    props.permit2Allowance,
  );

  useEffect(
    () => setVaultAllowance(props.vaultAllowance),
    [props.owner, props.vault, props.vaultAllowance],
  );
  useEffect(
    () => setPermit2Allowance(props.permit2Allowance),
    [props.owner, props.permit2, props.permit2Allowance],
  );

  async function approveVault() {
    const result = await props.client.approvePaymentToken(
      props.paymentToken,
      props.vault,
      props.units,
    );
    setVaultAllowance(props.units);
    return result;
  }

  async function allowanceBuy() {
    const needsAuthorization = authorizationRequired(
      vaultAllowance,
      props.units,
    );
    const result = await authorizeThenExecute(
      needsAuthorization,
      approveVault,
      () => {
        const deadline = transactionDeadline();
        return props.client.buy({
          vault: props.vault,
          outcomeId: props.outcomeId,
          desiredUnits: props.units,
          minimumUnits: props.units,
          maximumPayment: props.units,
          deadline,
        });
      },
    );
    setVaultAllowance(
      needsAuthorization ? 0n : (vaultAllowance ?? props.units) - props.units,
    );
    return result;
  }

  async function approvePermit2() {
    const result = await props.client.approvePaymentToken(
      props.paymentToken,
      props.permit2,
      props.units,
    );
    setPermit2Allowance(props.units);
    return result;
  }

  async function permit2Buy() {
    const callDeadline = transactionDeadline();
    const permit = {
      permitted: { token: props.paymentToken, amount: props.units },
      nonce: props.permitNonce,
      deadline: callDeadline,
    } as const;
    const typedData = buildBuyPermit2TypedData(props.permit2, permit, {
      owner: props.owner,
      vault: props.vault,
      selector: BUY_WITH_PERMIT2_SELECTOR,
      outcomeId: props.outcomeId,
      desiredUnits: props.units,
      minUnits: props.units,
      maxPayment: props.units,
      callDeadline,
      chainId: props.chainId,
    });
    const signature = await props.signer.signTypedData(typedData);
    const result = await props.client.buyWithPermit2({
      vault: props.vault,
      owner: props.owner,
      outcomeId: props.outcomeId,
      desiredUnits: props.units,
      minimumUnits: props.units,
      maximumPayment: props.units,
      deadline: callDeadline,
      permit,
      signature,
    });
    return result;
  }

  async function authorizedPermit2Buy() {
    const needsAuthorization = authorizationRequired(
      permit2Allowance,
      props.units,
    );
    const result = await authorizeThenExecute(
      needsAuthorization,
      approvePermit2,
      permit2Buy,
    );
    setPermit2Allowance(
      needsAuthorization
        ? 0n
        : (permit2Allowance ?? props.units) - props.units,
    );
    return result;
  }

  return (
    <section aria-labelledby="primary-payment-title">
      <h2 id="primary-payment-title">Primary payment authorization</h2>
      <p>
        Choose one path. Permit2 requires a token allowance to the Permit2
        contract, then signs a single bounded witness; this example uses an
        exact allowance instead of an unlimited one.
      </p>
      <button
        disabled={state.pending}
        onClick={() => void run(approveVault)}
      >
        Approve exact USDC to market
      </button>
      <button
        disabled={state.pending}
        onClick={() => void run(allowanceBuy)}
      >
        {authorizationRequired(vaultAllowance, props.units)
          ? "Authorize exact USDC and buy"
          : "Buy with market allowance"}
      </button>
      <button
        disabled={state.pending}
        onClick={() => void run(approvePermit2)}
      >
        Approve exact USDC to Permit2
      </button>
      <button
        disabled={state.pending}
        onClick={() => void run(authorizedPermit2Buy)}
      >
        {authorizationRequired(permit2Allowance, props.units)
          ? "Authorize exact USDC, sign Permit2 witness and buy"
          : "Sign Permit2 witness and buy"}
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
