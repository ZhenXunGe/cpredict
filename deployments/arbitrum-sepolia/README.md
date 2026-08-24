# Arbitrum Sepolia deployment evidence — BLOCKED / NOT DEPLOYED

Current authoritative status: **BLOCKED_NOT_DEPLOYED**. No transaction was broadcast and no
`pending.json`, `final.json`, address, transaction hash, or canary result exists in this directory.
The files under `templates/` are deliberately invalid as runtime evidence. Copy them to a separate,
access-controlled evidence workspace; never remove their warning and present the template itself as
proof.

Static artifact index: `script/DeployArbitrumSepolia.s.sol`, `script/FinalizeBootstrap.s.sol`,
`scripts/deployment/deploy-arbitrum-sepolia.sh`,
`scripts/deployment/deploy-arbitrum-sepolia.mjs`, `deploy.env.example`,
`final-manifest.schema.json`, `templates/final-manifest.template.json`,
`templates/canary-evidence.template.json`, `templates/ops-drill-evidence.template.json`,
`scripts/deployment/validate-final-manifest.mjs`, `scripts/deployment/verify-live-rpc.mjs`,
`scripts/deployment/validate-canary-evidence.mjs`, `scripts/deployment/validate-ops-evidence.mjs`,
`scripts/deployment/validate-monitoring-config.mjs`, and
`monitoring/prometheus/cpredict-alerts.yml`.

Testnet acceptance/operations tooling additionally includes `compose.yaml`, `.env.compose.example`,
`scripts/stack/`, `scripts/deployment/sync-runtime.mjs`, `scripts/deployment/verify-source.mjs`,
`scripts/deployment/canary-runner.mjs`, `CANARY-ADAPTER.md` and `OPS-ADAPTER.md`. These files are
static tooling until a Docker runtime or Arbitrum transaction is actually observed.

## Direct deployment CLI

The operator-facing entrypoint wraps both Foundry scripts without weakening their two-stage
Timelock or evidence boundary. It safely parses a local `KEY=VALUE` file (it never `source`s the
file), keeps redacted logs and resumable state under the ignored `runtime/` directory, derives the
address-bound Factory fingerprint through a non-broadcast preview, reruns the exact simulation, and
requires an explicit confirmation before either broadcast.

```sh
cp deployments/arbitrum-sepolia/deploy.env.example .env.arbitrum-sepolia.local
chmod 600 .env.arbitrum-sepolia.local

# Read-only chain, balance, dependency, role and local-artifact checks.
npm run deploy:arbitrum-sepolia -- preflight --profile debug

# One operator command: preflight → preview → exact simulation → confirmed deploy.
npm run deploy:arbitrum-sepolia -- deploy --profile debug

# Run after the one-hour Timelock becomes ready.
npm run deploy:arbitrum-sepolia -- finalize --profile debug

# Read-only live state at any time.
npm run deploy:arbitrum-sepolia -- status --profile debug
```

For a single unattended testnet command, set the acknowledgement from `deploy.env.example` and run:

```sh
npm run deploy:arbitrum-sepolia -- all --profile debug --yes --wait-for-timelock
```

`all` normally returns after scheduling and prints the resume command instead of hiding an hour-long
wait. `--wait-for-timelock` is explicit. A failed or partially broadcast run is recorded as
`BROADCAST_FAILED_REQUIRES_INSPECTION`; it is never silently retried. `--resume` is accepted only from
that state and delegates to Foundry's transaction-aware resume path.

The default profile is `formal`. It requires two distinct RPC origins, a clean checkout, a valid
signed audit tag, exact 4/6 Governance and 2/6 Emergency Safes, separated roles and an independently
reviewed fingerprint for every broadcast. Run `plan`, review its value outside the deployment
session, place it in `EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT`, then run `deploy`. `debug` permits
test EOAs or reused roles and can derive the value inside one command for a Web Demo, but its output
must never be labelled `FINALIZED_VERIFIED`.

After Finalize, construct runtime evidence outside the repository and run the existing strict
validator through the same entrypoint:

```sh
npm run deploy:arbitrum-sepolia -- verify --profile formal \
  --manifest /secure/evidence/final-manifest.json \
  --canary-evidence /secure/evidence/canary-evidence.json \
  --ops-evidence /secure/evidence/ops-drill-evidence.json
```

After a debug broadcast, generate consumer configuration without claiming finality:

```sh
npm run deploy:sync -- candidate \
  --pending deployments/arbitrum-sepolia/pending.json \
  --broadcast broadcast/DeployArbitrumSepolia.s.sol/421614/run-latest.json
npm run stack:up
```

`pending.json` records the actual protocol treasury, sponsorship signer,
Paymaster policy version, and all three Paymaster budget limits. Runtime sync
never substitutes the temporary deployer or hard-coded budget defaults.

The formal `deploy:sync final` command requires the final manifest, validated canary/ops evidence and
two independent RPC URLs. See `docs/zh/13-compose-runtime-operations.md` for the complete commands.

## External prerequisites

Deployment requires explicit release authorization plus all of the following outside this repository:

- two independent Arbitrum Sepolia RPC providers with different origins;
- funded, short-lived deployer and hardware-backed 4/6 Governance Safe and 2/6 Emergency Safe;
- distinct protocol treasury and sponsor signer; production sponsor signing must use KMS/HSM;
- exact Arbitrum Sepolia USDC, Permit2 and EntryPoint v0.8 addresses and code identities;
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
ARBITRUM_SEPOLIA_RPC_URL_A
ARBITRUM_SEPOLIA_RPC_URL_B
```

Use `deploy.env.example` as the complete operator template. The filled
`.env.arbitrum-sepolia.local` must have mode `0600` and is ignored by Git.

The deployment script deliberately has no token/Permit2/EntryPoint address overrides. Any upstream
address change requires a reviewed source change and a new frozen candidate. Current constants:

```text
USDC       0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
Permit2    0x000000000022D473030F116dDEE9F6B43aC78BA3
EntryPoint 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
```

Sources and runtime boundary:

- Circle publishes the Arbitrum Sepolia USDC address at
  `https://developers.circle.com/stablecoins/usdc-contract-addresses`;
- Uniswap publishes canonical Permit2 at `https://github.com/Uniswap/permit2`;
- eth-infinitism publishes EntryPoint v0.8 at
  `https://github.com/eth-infinitism/account-abstraction`;
- static addresses are not sufficient: the deploy simulation and final dual-RPC verifier must both
  observe code, USDC decimals `6`, and the candidate manifest's independently reviewed runtime
  codehashes.

Only Paymaster budget bounds remain optional execution overrides:

```text
PAYMASTER_MAX_COST_PER_OP
PAYMASTER_MAX_COST_PER_USER_DAY
PAYMASTER_MAX_COST_GLOBAL_DAY
```

## Fail-closed execution order

1. Freeze a clean audit commit and signed tag; run every release gate from a clean checkout.
2. Simulate `script/DeployArbitrumSepolia.s.sol` on chainId 421614 without broadcast. Independently derive
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
   ARBITRUM_SEPOLIA_RPC_URL_A=... ARBITRUM_SEPOLIA_RPC_URL_B=... \
     node scripts/deployment/verify-live-rpc.mjs /secure/evidence/final-manifest.json
   ```

   On the first evidence-binding pass the verifier may fail with the independently computed
   `roleEventsSha256` and `rpcEvidenceSha256`. Insert those values and rerun. Only the second strict
   `PASS` is runtime verification. The verifier checks chainId 421614, reference block agreement,
   Ethereum Sepolia parent block binding, and that the reference block is at or below each provider's
   `finalized` block; it also checks code presence/hash, all critical getters/wiring, Factory activation/fingerprint,
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
- Static scripts, mock tests and templates are `static verified` only. Arbitrum Sepolia becomes
  `runtime verified` only after authorized broadcasts and strict validators pass.
- Deployment does not imply external audit completion, mainnet approval, legal approval or production
  Paymaster/provider readiness.
