import { useState, type FormEvent } from "react";
import type { Address, Hex } from "viem";
import {
  parseShareUnits,
  parseUsdc,
  type CpredictClient,
} from "../../../offchain/sdk/src/index.js";
import { useTransactionAction } from "./useTransactionAction.js";
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
}) {
  const [outcomeId, setOutcomeId] = useState("0");
  const [amount, setAmount] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0.9");
  const [listingId, setListingId] = useState<Hex>(`0x${"00".repeat(32)}`);
  const { state, run } = useTransactionAction();
  const maximumGross = () =>
    (parseUsdc(unitPrice) * parseShareUnits(amount)) / 1_000_000n;

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() =>
      props.client.createListing({
        marketplace: props.marketplace,
        vault: props.vault,
        outcomeId: BigInt(outcomeId),
        amount: parseShareUnits(amount),
        unitPrice: parseUsdc(unitPrice),
        expiresAt: unixTimeSeconds() + LISTING_LIFETIME_SECONDS,
      }),
    );
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
        onClick={() =>
          void run(() =>
            props.client.setMarketplaceApproval(
              props.vault,
              props.marketplace,
              true,
            ),
          )
        }
      >
        Step 1: approve share escrow
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
          Step 2: create listing
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
        onClick={() =>
          void run(() =>
            props.client.approvePaymentToken(
              props.paymentToken,
              props.marketplace,
              maximumGross(),
            ),
          )
        }
      >
        Approve exact {props.paymentTokenSymbol ?? "USDC"} for fill
      </button>
      <button
        disabled={state.pending}
        type="button"
        onClick={() =>
          void run(() =>
            props.client.fillListing({
              marketplace: props.marketplace,
              listingId,
              desiredUnits: parseShareUnits(amount),
              minimumUnits: parseShareUnits(amount),
              maximumGross: maximumGross(),
              deadline: transactionDeadline(),
            }),
          )
        }
      >
        Fill exact amount
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
