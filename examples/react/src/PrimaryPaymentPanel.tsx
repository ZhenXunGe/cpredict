import type { Address, Hex } from "viem";
import {
  buildBuyPermit2TypedData,
  BUY_WITH_PERMIT2_SELECTOR,
  type CpredictClient,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";

export interface TypedDataSigner {
  signTypedData(
    data: ReturnType<typeof buildBuyPermit2TypedData>,
  ): Promise<Hex>;
}

export function PrimaryPaymentPanel(props: {
  client: Pick<CpredictClient, "approvePaymentToken" | "buyWithPermit2">;
  signer: TypedDataSigner;
  chainId: bigint;
  permit2: Address;
  paymentToken: Address;
  owner: Address;
  vault: Address;
  outcomeId: bigint;
  units: bigint;
  permitNonce: bigint;
}) {
  const { state, run } = useTransactionAction();
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);

  async function permit2Buy() {
    const callDeadline = deadline();
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
    return props.client.buyWithPermit2({
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
        onClick={() =>
          void run(() =>
            props.client.approvePaymentToken(
              props.paymentToken,
              props.vault,
              props.units,
            ),
          )
        }
      >
        Approve exact USDC to market
      </button>
      <button
        disabled={state.pending}
        onClick={() =>
          void run(() =>
            props.client.approvePaymentToken(
              props.paymentToken,
              props.permit2,
              props.units,
            ),
          )
        }
      >
        Approve exact USDC to Permit2
      </button>
      <button disabled={state.pending} onClick={() => void run(permit2Buy)}>
        Sign Permit2 witness and buy
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
