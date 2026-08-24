# Deployment and operations tooling report — 2026-08-21

## Result

- Compose/tooling: **STATIC VERIFIED**.
- Web Demo build and delivery secret scan: **PASS** (9 bundle files, zero findings).
- Docker image build / fresh Compose runtime: **NOT RUN** — Docker/Compose is unavailable on this host.
- Arbitrum Sepolia broadcast/source verification/24h canary/formal ops: **NOT RUN**.
- Deployment status remains **BLOCKED_NOT_DEPLOYED**.

## Implemented surfaces

- `compose.yaml`: PostgreSQL 17, migrations, canonical Indexer/API/WS, Nginx Demo and optional
  `sponsorship` Paymaster profile.
- `.env.compose.example` plus strict mode-0600, non-sourcing secret/public parser.
- manifest-driven candidate/final runtime packages with atomic version directory, current env and file hashes;
- candidate packages bind the deployed treasury, sponsorship signer, policy version and exact Paymaster budgets;
- locked Arbiscan verification plan and detailed redacted evidence;
- resumable three-wallet/Paymaster/24h canary lifecycle with external reviewed signer adapter;
- custom-format Indexer/Paymaster backups and disposable-volume restore drill;
- resumable 13-item local operations drill boundary that cannot masquerade as formal evidence.

## Local evidence

- `npm run test:stack-tools`: 16/16 PASS, including log redaction, JSON Schema 2020-12 compilation and runtime-package conformance.
- `npm run test:deployment-tools`: 40/40 PASS, including account/adapter resume identity and 24-hour chain-time boundaries.
- `npm run check:offchain`: PASS.
- `npm run demo:test`: 10/10 PASS.
- `npm run demo:build`: PASS.
- `npm run scan:demo-bundle`: 9 files, zero findings.

The exact final counts may increase if additional regression tests are added before artifact freeze. This
report must be updated together with the final source manifest; it is not Arbitrum runtime evidence.
