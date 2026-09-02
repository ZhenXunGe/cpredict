import { useEffect, useState, type FormEvent } from "react";
import type { Address, Hex } from "viem";
import {
  formatShareUnits,
  formatUsdc,
  parseShareUnits,
  parseUsdc,
  SHARE_SCALE,
  type CpredictClient,
  type ListingSnapshot,
  type TransactionResult,
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

export interface MarketplaceListingSelection {
  listingId: Hex;
  vault: Address;
  outcomeId: bigint;
  remainingUnits: bigint;
  unitPrice: bigint;
  expiresAt: bigint;
}

export function quoteFillFromChain(
  listing: ListingSnapshot,
  expectedVault: Address,
  desiredUnits: bigint,
): bigint {
  if (!listing.active)
    throw new Error("Selected listing is no longer active. Refresh active listings.");
  if (listing.vault.toLowerCase() !== expectedVault.toLowerCase())
    throw new Error("Selected listing belongs to a different market.");
  if (listing.observedAt >= listing.expiresAt)
    throw new Error("Selected listing has expired. Refresh active listings.");
  if (desiredUnits <= 0n)
    throw new RangeError("Fill amount must be greater than zero.");
  if (desiredUnits > listing.remainingUnits)
    throw new Error("Requested shares exceed the listing's current remaining amount.");
  const gross = (desiredUnits * listing.unitPrice) / SHARE_SCALE;
  if (gross <= 0n)
    throw new RangeError("Fill total must be greater than zero.");
  return gross;
}

function selectionFromSnapshot(
  listing: ListingSnapshot,
): MarketplaceListingSelection {
  return {
    listingId: listing.listingId,
    vault: listing.vault,
    outcomeId: listing.outcomeId,
    remainingUnits: listing.remainingUnits,
    unitPrice: listing.unitPrice,
    expiresAt: listing.expiresAt,
  };
}

export function MarketplacePanel(props: {
  client: Pick<
    CpredictClient,
    | "approvePaymentToken"
    | "setMarketplaceApproval"
    | "readListing"
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
  selectedListing?: MarketplaceListingSelection | null;
  onListingChange?: (
    listing: MarketplaceListingSelection | null,
    result: TransactionResult,
  ) => void;
}) {
  const [sellOutcomeId, setSellOutcomeId] = useState("0");
  const [sellAmount, setSellAmount] = useState("1");
  const [sellUnitPrice, setSellUnitPrice] = useState("0.9");
  const [fillAmount, setFillAmount] = useState(
    props.selectedListing === null || props.selectedListing === undefined
      ? "1"
      : formatShareUnits(props.selectedListing.remainingUnits),
  );
  const [selectedListing, setSelectedListing] =
    useState<MarketplaceListingSelection | null>(props.selectedListing ?? null);
  const [paymentTokenAllowance, setPaymentTokenAllowance] = useState(
    props.paymentTokenAllowance,
  );
  const [shareEscrowApproved, setShareEscrowApproved] = useState(
    props.shareEscrowApproved === true,
  );
  const { state, run } = useTransactionAction();
  const paymentTokenSymbol = props.paymentTokenSymbol ?? "USDC";

  useEffect(
    () => setPaymentTokenAllowance(props.paymentTokenAllowance),
    [props.marketplace, props.paymentToken, props.paymentTokenAllowance],
  );
  useEffect(
    () => setShareEscrowApproved(props.shareEscrowApproved === true),
    [props.marketplace, props.shareEscrowApproved, props.vault],
  );
  useEffect(() => {
    const next = props.selectedListing ?? null;
    setSelectedListing(next);
    if (next !== null) setFillAmount(formatShareUnits(next.remainingUnits));
  }, [
    props.selectedListing?.listingId,
    props.selectedListing?.remainingUnits,
    props.selectedListing?.unitPrice,
    props.selectedListing?.expiresAt,
  ]);

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
    void run(async () => {
      const outcomeId = BigInt(sellOutcomeId);
      const amount = parseShareUnits(sellAmount);
      const unitPrice = parseUsdc(sellUnitPrice);
      const expiresAt = unixTimeSeconds() + LISTING_LIFETIME_SECONDS;
      const result = await authorizeThenExecute(
        !shareEscrowApproved,
        approveShareEscrow,
        () =>
          props.client.createListing({
            marketplace: props.marketplace,
            vault: props.vault,
            outcomeId,
            amount,
            unitPrice,
            expiresAt,
          }),
      );
      const next = {
        listingId: result.listingId,
        vault: props.vault,
        outcomeId,
        remainingUnits: amount,
        unitPrice,
        expiresAt,
      };
      setSelectedListing(next);
      setFillAmount(sellAmount);
      props.onListingChange?.(next, result);
      return result;
    });
  }

  async function freshFillQuote() {
    if (selectedListing === null)
      throw new Error("Select an active listing before filling.");
    const desiredUnits = parseShareUnits(fillAmount);
    const listing = await props.client.readListing(
      props.marketplace,
      selectedListing.listingId,
    );
    const gross = quoteFillFromChain(listing, props.vault, desiredUnits);
    setSelectedListing(selectionFromSnapshot(listing));
    return { desiredUnits, gross, listing };
  }

  async function approveFillPayment() {
    const quote = await freshFillQuote();
    const result = await props.client.approvePaymentToken(
      props.paymentToken,
      props.marketplace,
      quote.gross,
    );
    setPaymentTokenAllowance(quote.gross);
    return result;
  }

  async function fill() {
    let quote = await freshFillQuote();
    const needsAuthorization = authorizationRequired(
      paymentTokenAllowance,
      quote.gross,
    );
    const result = await authorizeThenExecute(
      needsAuthorization,
      approveFillPayment,
      async () => {
        quote = await freshFillQuote();
        return props.client.fillListing({
          marketplace: props.marketplace,
          listingId: quote.listing.listingId,
          desiredUnits: quote.desiredUnits,
          minimumUnits: quote.desiredUnits,
          maximumGross: quote.gross,
          deadline: transactionDeadline(),
        });
      },
    );
    const remainingUnits =
      quote.listing.remainingUnits - quote.desiredUnits;
    const next =
      remainingUnits === 0n
        ? null
        : { ...selectionFromSnapshot(quote.listing), remainingUnits };
    setPaymentTokenAllowance(
      needsAuthorization
        ? 0n
        : (paymentTokenAllowance ?? quote.gross) - quote.gross,
    );
    setSelectedListing(next);
    props.onListingChange?.(next, result);
    return result;
  }

  async function cancel() {
    if (selectedListing === null)
      throw new Error("Select an active listing before cancelling.");
    const listing = await props.client.readListing(
      props.marketplace,
      selectedListing.listingId,
    );
    if (!listing.active)
      throw new Error("Selected listing is no longer active. Refresh active listings.");
    if (listing.vault.toLowerCase() !== props.vault.toLowerCase())
      throw new Error("Selected listing belongs to a different market.");
    const result = await props.client.cancelListing(
      props.marketplace,
      listing.listingId,
    );
    setSelectedListing(null);
    props.onListingChange?.(null, result);
    return result;
  }

  let draftGross: bigint | null = null;
  if (selectedListing !== null) {
    try {
      draftGross =
        (parseShareUnits(fillAmount) * selectedListing.unitPrice) / SHARE_SCALE;
    } catch {
      draftGross = null;
    }
  }
  const fillAuthorizationRequired =
    draftGross === null ||
    authorizationRequired(paymentTokenAllowance, draftGross);

  return (
    <section aria-labelledby="marketplace-title">
      <h2 id="marketplace-title">C2C position transfer</h2>
      <p role="note">
        C2C price does not change the parimutuel pool or final payout.
      </p>

      <div className="marketplace-section">
        <h3>Create sell listing</h3>
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
              value={sellOutcomeId}
              onChange={(event) => setSellOutcomeId(event.currentTarget.value)}
            />
          </label>
          <label>
            Shares{" "}
            <input
              value={sellAmount}
              onChange={(event) => setSellAmount(event.currentTarget.value)}
            />
          </label>
          <label>
            {paymentTokenSymbol} per share{" "}
            <input
              value={sellUnitPrice}
              onChange={(event) => setSellUnitPrice(event.currentTarget.value)}
            />
          </label>
          <button disabled={state.pending} type="submit">
            {shareEscrowApproved
              ? "Create listing"
              : "Authorize share escrow and create listing"}
          </button>
        </form>
      </div>

      <div className="marketplace-section" aria-labelledby="selected-listing-title">
        <h3 id="selected-listing-title">Selected listing</h3>
        {selectedListing === null ? (
          <p>Select an active listing above to fill or cancel it.</p>
        ) : (
          <>
            <dl className="marketplace-listing-summary">
              <div>
                <dt>Listing ID</dt>
                <dd className="mono" data-testid="selected-listing-id">
                  {selectedListing.listingId}
                </dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{(selectedListing.outcomeId + 1n).toString()}</dd>
              </div>
              <div>
                <dt>Fixed price</dt>
                <dd>{formatUsdc(selectedListing.unitPrice)} {paymentTokenSymbol}</dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd>{formatShareUnits(selectedListing.remainingUnits)} shares</dd>
              </div>
            </dl>
            <label>
              Shares to buy{" "}
              <input
                value={fillAmount}
                onChange={(event) => setFillAmount(event.currentTarget.value)}
              />
            </label>
            <p>
              Total: {draftGross === null ? "—" : formatUsdc(draftGross)} {paymentTokenSymbol}
            </p>
            <button
              disabled={state.pending}
              type="button"
              onClick={() => void run(approveFillPayment)}
            >
              Approve exact {paymentTokenSymbol} for fill
            </button>
            <button
              disabled={state.pending}
              type="button"
              onClick={() => void run(fill)}
            >
              {fillAuthorizationRequired
                ? `Authorize exact ${paymentTokenSymbol} and fill`
                : "Fill exact amount"}
            </button>
            <button
              disabled={state.pending}
              type="button"
              onClick={() => void run(cancel)}
            >
              Cancel selected listing
            </button>
          </>
        )}
      </div>
      <output aria-live="polite">{state.message}</output>
    </section>
  );
}
