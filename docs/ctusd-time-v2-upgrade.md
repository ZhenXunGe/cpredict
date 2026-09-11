# ctUSD time-v2 cutover

The public site uses the new time-v2 deployment exclusively. Existing ctUSD,
controller wallets, Kernel 0.3.1 / EntryPoint 0.7 / index 1001, login projects
and weekly sponsorship budgets remain unchanged. Old markets and financial
history remain in an archive schema in the same PostgreSQL database. No token,
market share or user asset is transferred by this upgrade.

## Prepare the chain deployment

Use the existing sandbox deployment tool with an explicit existing-token address
and runtime code hash in its private env file. Keep a separate state directory
and pending manifest; do not overwrite a previous deployment's receipts.

```sh
npm run build:offchain
npm run deploy:arbitrum-sepolia -- plan --env-file <private-env> --state-dir <new-state-dir> --pending-manifest <new-state-dir>/pending.json
npm run deploy:arbitrum-sepolia -- deploy --env-file <private-env> --state-dir <new-state-dir> --pending-manifest <new-state-dir>/pending.json
npm run deploy:arbitrum-sepolia -- finalize --env-file <private-env> --state-dir <new-state-dir> --pending-manifest <new-state-dir>/pending.json
```

The sandbox bootstrap has **zero delay**. The protocol's resolution window is a
market settlement deadline and does not delay deployment or creation. Broadcast
requires the reviewed testnet target, roles, token, source and fee estimate. An
unknown broadcast result must be inspected with the original state/receipts.

After successful initialization, generate the new private runtime and public
configuration from live receipt and source evidence:

```sh
node scripts/deployment/prepare-time-v2-site.mjs --previous <current-ctusd.runtime.json> --state <new-state-dir>/state.json --pending <new-state-dir>/pending.json --provider-env <current-provider.env> --output <new-output-directory>
npm run deploy:sync -- candidate --pending <new-state-dir>/pending.json --broadcast <new-state-dir>/foundry/broadcast/DeployArbitrumSepolia.s.sol/421614/run-latest.json
```

Configuration generation checks the creation bytecode against the pinned source,
successful canonical receipts, active Factory, dependency fingerprint, existing
token hash, decimals and contract wiring. It never switches the running site.
The candidate classification remains explicit; it is not formal mainnet release
evidence. Preserve the old runtime package and `current.env` before generating
the new package, since `deploy:sync` selects its generated package locally.

## Switch the existing database and services

1. Build and verify the new images before stopping services. Close new sponsorship
   admission and let original operations recover. Take and verify the existing
   database backup. Preserve the original runtime, site config and provider files.
2. Stop the ctUSD app service and indexer. The reverse proxy/container remains in
   place. Apply the normal additive migrations, including application `004`, to
   the existing database using the established migration runner.
3. Set `CPREDICT_MAINTENANCE_DATABASE_URL` to the existing indexer database with the
   migrator role, and `CPREDICT_MAINTENANCE_RPC_URL` to its RPC. Do not print them.
   Review the rollover before applying it:

   ```sh
   npm run site:maintain -- rollover --config <new-ctusd.runtime.json> --input <old-ctusd.runtime.json> --environment ctusd-public-test
   npm run site:maintain -- rollover --config <new-ctusd.runtime.json> --input <old-ctusd.runtime.json> --environment ctusd-public-test --apply
   ```

   When running the maintenance command inside the existing Compose network,
   add `--container` and use the internal `postgres:5432` endpoint with
   `sslmode=disable`. This mode accepts only that endpoint and no additional
   database URL options. Keep PostgreSQL unpublished on the host. Host-local
   commands and remote TLS connections continue to run without this flag.

   Submitted, unknown and nonfinal operations block the switch. Resolve them
   through the original recovery flow; never delete records to pass this check.
   Rollover builds fresh tables using the normal migration registry in a private
   staging schema, then atomically archives the old schema and selects the new
   one. A staging failure leaves live data intact; inspect the named staging
   schema before retrying. Repeating a completed rollover does not import twice.

4. Select the newly generated runtime package, private ctUSD runtime and public
   site config in the existing stack configuration. Keep provider files, budgets,
   account derivation and the metadata database. Immutable old rules may remain
   readable at their original URI; they are not markets in the new catalog.
5. Start the updated indexer, metadata and app service with matching deployment
   addresses. Refresh the gateway's configuration/static publication using the
   existing public updater. Verify the publicly served config matches the exact
   new deployment, and refresh the local dev site's proxied config.

The indexer starts at the **first block of the new deployment**, with a fresh
checkpoint and new contract set. It does not replay old market history. Verified
account transfer tracking starts at that block; the payment-token balance is
read directly from the chain. Reconciliation anchors each account's opening
balance to the preceding block and records that block hash in its report, then
adds only new transfers. An unavailable historical balance or changed block hash
blocks reconciliation rather than assuming a zero balance. Historical ctUSD
transfers are not invented as
new trading activity. Old operation records retained solely for quotas do not
appear in activity, recovery or PnL; provider budget consumption is preserved.

The user-approved ctUSD per-operation cap is 0.005 ETH
(`sponsor.maxCostPerOperation = "5000000000000000"`). Apply it to the actual
service runtime, preserving the weekly 0.1 ETH total and 0.02 ETH exit reserve.
Check the daily account/subject limits and outstanding reservations before
claiming that a freshly funded account can immediately create a full market.

For this demo the user also approved daily `projectWei`, `accountWei` and
`subjectWei` of `"80000000000000000"` in the exposure lane and
`"20000000000000000"` in the exit lane. Keep the weekly allocation, provider hard
limit and operation-count limits unchanged. With the current full-reservation
accounting, these limits allow at most 16 exposure and 4 exit admissions per
week before carried-over usage; they do not represent actual gas spent.

## Acceptance and recovery

Verify on PC in both local and public sites: login, stable account address,
existing ctUSD balance, creation through the smart account, index discovery and
purchase. Then verify listing/fill/cancel, settlement/void, claims, refunds,
creator bond/fees and transfer for eligible market states. Record receipt hashes
and before/after balances. UI fixtures and contract tests are separate evidence
from actual wallet/UserOperation execution. Mobile and independent USDC remain
deferred.

Before any new operations, a failed switch can select the preserved old runtime
and schema under stopped services after inspecting the cutover record. Once new
operations exist, preserve both schemas and both sets of operation records; do
not restore an old backup over new writes. Fix or roll back service code without
automatically replaying transactions. The normal whole-database backup includes
the archived schemas; archive reads are limited to maintenance/backup roles.
