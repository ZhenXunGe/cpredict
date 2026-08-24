# Sponsorship service

This package is a runnable, secure-by-default service shell, not a hosted production signer. It:

- rejects unrecognized account adapters, targets, selectors, ETH value and oversized calldata;
- decodes fixed-layout `createListing` calls and rejects sponsored listings below the configured
  minimum share-unit threshold before reserving budget or signing;
- requires an injected short-lived-request authorizer;
- requires an injected KMS/HSM signer and checks its address against the deployment-configured
  required signer address;
- binds the EIP-712 signature to the complete execution/gas fields, chain, EntryPoint, Paymaster,
  policy version, validity and maximum cost;
- never accepts an RPC URL, callback URL, target or selector from server configuration at request time;
- redacts authorization headers and does not log UserOperation signatures.
- reserves abuse budget before signing and retains that reservation if commit becomes uncertain;
- exposes `/healthz`, dependency-aware `/readyz`, `/metrics`, and authenticated
  `/v1/sponsorship` endpoints.

Build with `npm run build:offchain`, then run `npm run start:paymaster-service`. Startup validates
all `CPREDICT_PAYMASTER_*` variables and loads the absolute `file://` module named by
`CPREDICT_PAYMASTER_ADAPTER_MODULE`. That module must export `createSponsorRuntimeAdapters` and
inject four explicit boundaries: `SponsorAccountAdapter`, `SponsorAuthorizer`,
`SponsorBudgetStore`, and `SponsorSigner`. The repository deliberately contains no raw-key signer
or in-memory production budget implementation.

An account-specific decoder, real KMS/HSM adapter, short-lived authentication provider,
transactional shared budget datastore, live on-chain `sponsorSigner`/policy-version verification,
infrastructure TLS, WAF and egress policy remain deployment integrations. The process accepts only
loopback bind addresses unless `CPREDICT_PAYMASTER_CONTAINER_MODE=true`; that override is reserved
for an isolated Compose network whose host publish remains loopback-only. It should still run behind
a correctly configured gateway. The expected signer environment value is a fail-closed deployment
assertion, not proof that chain state was queried.
