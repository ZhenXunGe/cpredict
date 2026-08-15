# React protocol-call examples

These components demonstrate the complete transaction surfaces expected from a product client:

- `BuyPanel`: primary purchase with explicit minimum and maximum payment;
- `PrimaryPaymentPanel`: exact market allowance, or exact Permit2 allowance followed by a canonical
  one-shot witness;
- `CreateMarketPanel`: exact creation-fee-plus-bond allowance, immutable market review and creation;
- `MarketLifecyclePanel`: creator resolve/void, optional canonical settlement evidence and
  permissionless timeout void;
- `MarketplacePanel`: ERC-1155 escrow approval, listing, exact USDC fill allowance, fill and cancellation;
- `ClaimsPanel`: winner, early-bird, principal and timeout-bonus claims.

They intentionally do not bundle a wallet vendor, Paymaster credential or RPC URL. An application must
inject the SDK client, re-read authoritative chain state before each economic action and use the SDK's
AA sponsorship selector before the account signs a UserOperation. These are integration examples, not
the flagship product or browser E2E evidence.

Settlement evidence uses the SDK's fixed V1 canonical JSON bytes and SHA-256/raw-CID helpers. The
example deliberately has no IPFS client or credential. A product may inject
`uploadCanonicalEvidence`; that adapter must upload the provided `canonicalBytes` verbatim and return
the exact `expectedUri`. The component verifies that URI before asking the SDK to submit
`evidenceHash`. Leaving both evidence fields empty submits the protocol-defined zero hash. Supplying
only one field fails before simulation.
