# Keeping old markets live during a factory update

Use this flow for time-v2 to time-v2 upgrades. Do not run the legacy `rollover`
command: it archives markets instead of keeping their claims available.

1. Publish and verify the shared-admission-lock release on the current deployment.
   Verify a native database backup/restore before maintenance. Keep configuration
   and receipts in private, immutable directories, outside the source inventory.
2. Deploy and initialize the new factory using the existing sandbox token, roles,
   and 24-hour resolution window. Use separate deploy state and pending paths.
   Generate a successor with `prepare-time-v2-site.mjs --successor-id <new-id>`.
   This checks live receipts, creation code, active wiring and per-market fee support.
3. Run `prepare-history-services.mjs --runtime <old-runtime> --output <private-dir>`.
   It pins the existing service images/configs in a separate Compose project on
   the original networks. No database or wallet is duplicated. Historical routes
   use `/ctusd/app/history`, `/ctusd/indexer/history` and `/ctusd/metadata/history` through the existing authenticated edge routes; the original environment/deployment identity is preserved.
4. Run `site:maintain -- prepare-history --input <old-runtime> --config <new-runtime>
   --environment <new-id>` and review the reported schema before `--apply`.
   Use one dedicated migrator connection to the OLD schema. This adds a current
   schema and copies verified wallet identities. Old markets, operation recovery
   and claims remain in the original schema, including unknown operations.
   Shared quota views count both deployments' live reservations and fees once.
   Do not retry a partially prepared schema without inspection.
5. Add the history runtime's environment to the public site's
   `historicalEnvironments`, with the new environment as the default. Select the
   new runtime package and `CPREDICT_STACK_CTUSD_SCHEMA` from the maintenance
   report. Keep provider credentials, token, wallet derivation and budget limits.
   The main services point to the new schema; the history Compose project stays
   pinned to the old schema. Start history sidecars and use `stack:update:public`
   for the main services and public configuration. The updater validates main
   source/runtime revisions; verify history images and health separately.
6. Reconcile/activate the new ledger before treating totals as complete. Verify
   current and historical public catalogs, fee totals, old entitlement reads,
   per-market fee controls and unchanged sponsorship consumption. Fixture tests
   do not constitute real-wallet claim acceptance. Never submit a user claim for
   testing or resubmit an unknown operation.

Full database backups include both schemas. Keep the historical service project
running on restart unless the owner explicitly retires it; do not remove it as a side effect of updating the main stack. Future database
migrations affecting history require a separate compatibility review. Ordinary
main updates must not recreate shared quota views or reset old usage.

## Retiring a historical deployment

After the owner explicitly requests retirement and deletion, remove its public
environment and return HTTP 410 from its old page/API namespaces before removing
the historical Compose services. The shared PostgreSQL container and networks
belong to the current deployment and must remain.

Before deleting old schemas, validate their environment identities and check for
unresolved operations, unsettled sponsorship charges and deposits. Move only the
quota history still needed by the current billing window into the current
schema's `app_quota_carryover`, then replace its quota view with the local
operations/carryover union. Verify the per-operation charges and budget totals
are unchanged inside the same transaction. Delete the old market/indexer/app
schemas only after detaching this dependency, and verify current schema tables
are unchanged. Metadata is shared: delete publications and challenges by the
retired factory identities, never truncate the shared metadata database.

Do not restore a pre-retirement configuration or database backup over the live
deployment without a separate review; it can resurrect removed endpoints and
data. On-chain contracts and transactions are not deleted by this procedure.
