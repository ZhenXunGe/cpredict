# Token integration and ERC-1155 conformance review

Status: internal static and local-test evidence for the current candidate. This is not Arbitrum runtime
verification or an external audit.

## Asset model

- The only payment asset is the deployment-pinned six-decimal token exposed by
  `ProtocolConfigV1.paymentToken`; V1 deployment intends canonical Arbitrum USDC.
- One primary USDC atomic unit mints one ERC-1155 share unit. Every market has an independent
  ERC-1155 contract and outcome IDs are local to that market.
- Factory fees/bond, primary principal and Permit2 gross transfers measure the receiving balance or
  immediately check vault solvency. Fee-on-transfer/rebasing input cannot silently create credit.
- Claims and credits use `SafeERC20` and assume canonical USDC transfer semantics. A USDC pause,
  blocklist or proxy upgrade can make exits revert until the issuer restores transferability; the
  protocol cannot repair or bypass that external trust failure.

## Approval and custody paths

| Operation | User authority | Recipient/custodian | Bounded client example |
|---|---|---|---|
| create market | ERC-20 allowance | Factory atomically routes fee and bond | exact `creationFee + creatorBond` |
| primary buy | ERC-20 allowance | market Vault | exact requested amount |
| Permit2 buy | ERC-20 allowance to Permit2 + witness signature | market Vault | exact allowance, amount, nonce and deadlines |
| create listing | ERC-1155 operator approval | fixed Marketplace escrow | market-specific operator approval |
| allowance fill | ERC-20 allowance | seller and FeeVault | exact `maxGross` |
| Permit2 fill | ERC-20 allowance to Permit2 + witness signature | Marketplace, then seller/FeeVault | exact allowance and witnessed limits |

There is no administrator principal sweep. `claimFor` and permissionless maintenance cannot redirect
the beneficiary. The Marketplace rejects unsolicited single/batch ERC-1155 receipts and terminal
positions must be returned to the seller before the Vault will burn/claim them.

## Permit2 domain review

Buy and fill use canonical `PermitWitnessTransferFrom` suffixes. Each witness binds owner/buyer,
spender contract, exact function selector, market or listing, desired/minimum units, maximum payment,
call deadline and chain ID. Permit2 nonce/deadline/token/amount are also part of the signed typed data.
Independent Solidity constants and TypeScript EIP-712 signing/recovery tests prevent the protocol
implementation from serving as its own oracle.

## ERC-1155 checker and runtime disposition

Commands:

```bash
PATH="$PWD/.tools/foundry/bin:$PATH" .tools/slither/bin/slither-check-erc . \
  FullMarketVaultV1 --erc ERC1155 --json reports/security/erc1155-full.json
PATH="$PWD/.tools/foundry/bin:$PATH" .tools/slither/bin/slither-check-erc . \
  CloneMarketVaultV1 --erc ERC1155 --json reports/security/erc1155-clone.json
```

Both reports have `success=true` and identify all required ERC-1155 functions, return types,
interfaces and standard events. They report two optional receiver functions as absent, which is
expected because a share token is not itself an ERC-1155 receiver. They also report that inherited
`safeBatchTransferFrom` does not emit `TransferBatch`; this is a checker call-graph false positive
against OpenZeppelin's inherited `_updateWithAcceptanceCheck` path. The focused
`testErc1155BatchTransferEmitsStandardEventAndPreservesSupply` runtime regression observes the exact
standard event, recipient balances and unchanged per-outcome total supply.

## Residual integration risks

- Arbitrum USDC proxy/admin, Permit2 runtime and Arbitrum sequencing remain external trust assumptions. Their
  addresses and current code hashes must be independently reviewed before Factory activation.
- Per-address primary caps do not stop Sybil splitting. ERC-1155 transferability intentionally makes
  current holder identity differ from the original buyer.
- Some USDC implementations require a zero-first allowance update; the SDK demonstrates exact
  approvals but a production wallet should simulate and offer an explicit zero-then-set flow when the
  configured token requires it.
- Direct token donations are not accounting credits and cannot be swept as user principal. Operational
  monitoring must flag unexplained balance surplus rather than treating it as protocol revenue.

## Evidence boundary

Focused fee-on-transfer, Permit2, transfer, Marketplace escrow, claim and Full/Clone differential
tests pass locally. Real Arbitrum USDC pause/blocklist behavior, Permit2 deployment code hash, wallet UX,
hardware wallet signing and production indexer interpretation are not runtime verified here.
