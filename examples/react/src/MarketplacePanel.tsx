import { useEffect, useState, type FormEvent } from "react";
import type { Address, Hex } from "viem";
import {
  parseShareUnits,
  parseUsdc,
  type CpredictClient,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
import {
  authorizationRequired,
  authorizeThenExecute,
} from "./authorizationFlow.js";
import {
  transactionDeadline,
  unixTimeSeconds,
} from "./transactionTiming.js";

const LISTING_LIFETIME_SECONDS = 24n * 60n * 60n;

export function MarketplacePanel(props: {
  client: Pick<
    CpredictClient,
    | "approvePaymentToken"
    | "setMarketplaceApproval"
    | "createListing"
    | "fillListing"
    | "cancelListing"
  >;
  paymentToken: Address;
  paymentTokenSymbol?: string;
  vault: Address;
  marketplace: Address;
  paymentTokenAllowance?: bigint | null;
  shareEscrowApproved?: boolean | null;
}) {
  const [outcomeId, setOutcomeId] = useState("0");
  const [amount, setAmount] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0.9");
  const [listingId, setListingId] = useState<Hex>(`0x${"00".repeat(32)}`);
  const [paymentTokenAllowance, setPaymentTokenAllowance] = useState(
    props.paymentTokenAllowance,
  );
  const [shareEscrowApproved, setShareEscrowApproved] = useState(
    props.shareEscrowApproved === true,
  );
  const { state, run } = useTransactionAction();
  const maximumGross = () =>
    (parseUsdc(unitPrice) * parseShareUnits(amount)) / 1_000_000n;

  useEffect(
    () => setPaymentTokenAllowance(props.paymentTokenAllowance),
    [props.marketplace, props.paymentToken, props.paymentTokenAllowance],
  );
  useEffect(
    () => setShareEscrowApproved(props.shareEscrowApproved === true),
    [props.marketplace, props.shareEscrowApproved, props.vault],
  );

  async function approveShareEscrow() {
    const result = await props.client.setMarketplaceApproval(
      props.vault,
      props.marketplace,
      true,
    );
    setShareEscrowApproved(true);
    return result;
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() =>
      authorizeThenExecute(
        !shareEscrowApproved,
        approveShareEscrow,
        () =>
          props.client.createListing({
            marketplace: props.marketplace,
            vault: props.vault,
            outcomeId: BigInt(outcomeId),
            amount: parseShareUnits(amount),
            unitPrice: parseUsdc(unitPrice),
            expiresAt: unixTimeSeconds() + LISTING_LIFETIME_SECONDS,
          }),
      ),
    );
  }

  async function approveFillPayment() {
    const required = maximumGross();
    const result = await props.client.approvePaymentToken(
      props.paymentToken,
      props.marketplace,
      required,
    );
    setPaymentTokenAllowance(required);
    return result;
  }

  async function fill() {
    const required = maximumGross();
    const needsAuthorization = authorizationRequired(
      paymentTokenAllowance,
      required,
    );
    const result = await authorizeThenExecute(
      needsAuthorization,
      approveFillPayment,
      () =>
        props.client.fillListing({
          marketplace: props.marketplace,
          listingId,
          desiredUnits: parseShareUnits(amount),
          minimumUnits: parseShareUnits(amount),
          maximumGross: required,
          deadline: transactionDeadline(),
        }),
    );
    setPaymentTokenAllowance(
      needsAuthorization
        ? 0n
        : (paymentTokenAllowance ?? required) - required,
    );
    return result;
  }

  let fillAuthorizationRequired = true;
  try {
    fillAuthorizationRequired = authorizationRequired(
      paymentTokenAllowance,
      maximumGross(),
    );
  } catch {
    // Invalid draft values are reported by the submitted action without crashing render.
  }

  return (
    <section aria-labelledby="marketplace-title">
      <h2 id="marketplace-title">C2C position transfer</h2>
      <p role="note">
        C2C price does not change the parimutuel pool or final payout.
      </p>
      <button
        disabled={state.pending}
        type="button"
        onClick={() => void run(approveShareEscrow)}
      >
        Approve share escrow separately
      </button>
      <form onSubmit={create} aria-busy={state.pending}>
        <label>
          Outcome{" "}
          <input
            value={outcomeId}
            onChange={(event) => setOutcomeId(event.currentTarget.value)}
          />
        </label>
        <label>
          Shares{" "}
          <input
            value={amount}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        <label>
          {props.paymentTokenSymbol ?? "USDC"} per share{" "}
          <input
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.currentTarget.value)}
          />
        </label>
        <button disabled={state.pending} type="submit">
          {shareEscrowApproved
            ? "Create listing"
            : "Authorize share escrow and create listing"}
        </button>
      </form>
      <label>
        Listing ID
        <input
          value={listingId}
          onChange={(event) => setListingId(event.currentTarget.value as Hex)}
        />
      </label>
      <button
        disabled={state.pending}
        type="button"
        onClick={() => void run(approveFillPayment)}
      >
        Approve exact {props.paymentTokenSymbol ?? "USDC"} for fill
      </button>
      <button
        disabled={state.pending}
        type="button"
        onClick={() => void run(fill)}
      >
        {fillAuthorizationRequired
          ? `Authorize exact ${props.paymentTokenSymbol ?? "USDC"} and fill`
          : "Fill exact amount"}
      </button>
      <button
        disabled={state.pending}
        type="button"
        onClick={() =>
          void run(() =>
            props.client.cancelListing(props.marketplace, listingId),
          )
        }
      >
        Cancel listing
      </button>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
