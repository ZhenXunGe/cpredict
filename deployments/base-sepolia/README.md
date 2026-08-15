# Base Sepolia deployment evidence — BLOCKED / NOT DEPLOYED

Current authoritative status: **BLOCKED_NOT_DEPLOYED**. No transaction was broadcast and no
`pending.json`, `final.json`, address, transaction hash, or canary result exists in this directory.
The files under `templates/` are deliberately invalid as runtime evidence. Copy them to a separate,
access-controlled evidence workspace; never remove their warning and present the template itself as
proof.

Static artifact index: `script/DeployBaseSepolia.s.sol`, `script/FinalizeBootstrap.s.sol`,
`final-manifest.schema.json`, `templates/final-manifest.template.json`,
`templates/canary-evidence.template.json`, `templates/ops-drill-evidence.template.json`,
`scripts/deployment/validate-final-manifest.mjs`, `scripts/deployment/verify-live-rpc.mjs`,
`scripts/deployment/validate-canary-evidence.mjs`, `scripts/deployment/validate-ops-evidence.mjs`,
`scripts/deployment/validate-monitoring-config.mjs`, and
`monitoring/prometheus/cpredict-alerts.yml`.

## External prerequisites

Deployment requires explicit release authorization plus all of the following outside this repository:

- two independent Base Sepolia RPC providers with different origins;
- funded, short-lived deployer and hardware-backed 4/6 Governance Safe and 2/6 Emergency Safe;
- distinct protocol treasury and sponsor signer; production sponsor signing must use KMS/HSM;
- exact Base Sepolia USDC, Permit2 and EntryPoint v0.8 code identities;
- an audit commit and signed tag whose source manifest, ABI and bytecode are frozen;
- source-verification credentials, immutable evidence storage, monitoring/alert routing and on-call;
- a funded Paymaster EntryPoint deposit with a finite loss cap.

Sensitive environment values are injected only into the execution session. Never persist the deployer
private key, RPC credentials, Safe credentials, KMS credentials, explorer API key, or alert-routing
secrets in a manifest, terminal transcript, template, Git history, or report.

Required execution variables:

```text
DEPLOYER_PRIVATE_KEY
GOVERNANCE_SAFE
EMERGENCY_SAFE
PROTOCOL_TREASURY
SPONSOR_SIGNER
EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT
BASE_SEPOLIA_RPC_URL_A
BASE_SEPOLIA_RPC_URL_B
```

Optional overrides must be independently codehash-reviewed before use:

```text
USDC_ADDRESS
PERMIT2_ADDRESS
ENTRYPOINT_ADDRESS
PAYMASTER_MAX_COST_PER_OP
PAYMASTER_MAX_COST_PER_USER_DAY
PAYMASTER_MAX_COST_GLOBAL_DAY
```

## Fail-closed execution order

1. Freeze a clean audit commit and signed tag; run every release gate from a clean checkout.
2. Simulate `script/DeployBaseSepolia.s.sol` on chainId 84532 without broadcast. Independently derive
   and review the Factory dependency fingerprint. Do not copy an unreviewed trace value into the
   broadcast environment.
3. Broadcast only after explicit deployment authorization. Preserve every receipt, block hash,
   constructor argument and runtime code hash outside the repository.
4. Validate the scheduled bootstrap operation, then wait at least 3,600 seconds.
5. Simulate and broadcast `script/FinalizeBootstrap.s.sol`; confirm activation and deployer role
   removal. `pending.json` is not a final release.
6. Populate a candidate manifest using the field shape documented by the final template, with status
   `BOOTSTRAP_FINALIZED_PENDING_CANARY`, canary status `PENDING`, and a zero canary SHA placeholder.
   Do not call it final evidence. Run the live verifier against exactly two independent RPC origins at
   the manifest reference block:

   ```sh
   BASE_SEPOLIA_RPC_URL_A=... BASE_SEPOLIA_RPC_URL_B=... \
     node scripts/deployment/verify-live-rpc.mjs /secure/evidence/final-manifest.json
   ```

   On the first evidence-binding pass the verifier may fail with the independently computed
   `roleEventsSha256` and `rpcEvidenceSha256`. Insert those values and rerun. Only the second strict
   `PASS` is runtime verification. The verifier checks chainId 84532, reference block agreement and
   confirmations, code presence/hash, all critical getters/wiring, Factory activation/fingerprint,
   canonical USDC decimals, locked Clone implementation storage, Safe owners/thresholds, Timelock
   delay, permissionless executor and role-event reconstruction.

7. Execute Full/Clone and protocol E2E canaries. Keep the timeout canary open for a real 24 hours.
   Validate receipts, timestamp boundaries, 1:1 principal refunds, bond funding and exact bonus
   conservation:

   ```sh
   node scripts/deployment/validate-canary-evidence.mjs /secure/evidence/canary-evidence.json
   ```

8. Execute role, monitoring and incident drills and validate durable artifacts and independent
   signoff:

   ```sh
   node scripts/deployment/validate-ops-evidence.mjs /secure/evidence/ops-drill-evidence.json
   node scripts/deployment/validate-monitoring-config.mjs
   ```

9. Bind the validated canary SHA-256 into the manifest, change the status to `FINALIZED_VERIFIED` and
   canary status to `COMPLETE`, then run the strict final-manifest validator:

   ```sh
   node scripts/deployment/validate-final-manifest.mjs /secure/evidence/final-manifest.json
   ```

10. Rerun the dual-RPC verifier against the final manifest and include all validated evidence in the
    signed release bundle.

## Evidence boundary

- JSON Schema conformance alone is not proof; the repository validator is stricter and mandatory.
- A single RPC is never accepted. Two endpoints on the same origin are not independent.
- Explorer source verification does not replace runtime bytecode/codehash verification.
- A `status: COMPLETE` string does not prove anything unless the validator passes over receipts and
  durable artifact hashes.
- Static scripts, mock tests and templates are `static verified` only. Base Sepolia becomes
  `runtime verified` only after authorized broadcasts and strict validators pass.
- Deployment does not imply external audit completion, mainnet approval, legal approval or production
  Paymaster/provider readiness.
