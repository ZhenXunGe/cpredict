# Permissionless terminal worker

`src/main.ts` is a deployable composition root for permissionless `settleBond` and
`LaunchExposureGuard.sync`. It consumes terminal markets from the Indexer API, persists attempts in
PostgreSQL, subscribes to a real viem RPC and exposes liveness/readiness/Prometheus endpoints.

The repository deliberately contains **no raw-private-key signer adapter**. A deployment-owned
absolute `file:` module must export:

```ts
export async function createTerminalWorkerRuntimeAdapters(config) {
  return {
    publicClient, // bounded real RPC client
    walletClient, // remote signer/KMS/HSM-backed viem wallet client
    account, // must equal CPREDICT_WORKER_EXPECTED_ACCOUNT
    sql, // postgres Sql used for durable attempt state
    telemetry, // TerminalWorkerTelemetry implementation
    registry, // prom-client Registry used by /metrics
    async ready() {
      /* check RPC, DB, signer and exporter */
    },
    async close() {
      /* close deployment-owned resources */
    },
  };
}
```

The adapter may consume `config.rpcUrl` and `config.databaseUrl`, but must obtain signer authority
from KMS/HSM or another deployment secret provider. Any unknown `CPREDICT_WORKER_*` variable,
including `CPREDICT_WORKER_PRIVATE_KEY`, is rejected before the adapter loads.

Apply `migrations/001_terminal_worker.sql` before startup. Attempt state is keyed by chain ID and
market, so one database can safely host isolated worker instances for multiple chains. After
`npm run build:offchain`, run:

```text
node dist/offchain/workers/src/main.js
```

Required configuration:

```text
CPREDICT_WORKER_HOST=127.0.0.1
CPREDICT_WORKER_PORT=3002
CPREDICT_WORKER_LOG_LEVEL=info
CPREDICT_WORKER_ADAPTER_MODULE=file:///absolute/path/to/worker-adapters.js
CPREDICT_WORKER_CHAIN_ID=84532
CPREDICT_WORKER_RPC_URL=https://...
CPREDICT_WORKER_DATABASE_URL=postgresql://...?...sslmode=verify-full
CPREDICT_WORKER_EXPECTED_ACCOUNT=0x...
CPREDICT_WORKER_BOND_ESCROW=0x...
CPREDICT_WORKER_EXPOSURE_GUARD=0x...
CPREDICT_WORKER_INDEXER_URL=https://...
CPREDICT_WORKER_INDEXER_MAX_PAGES=100
CPREDICT_WORKER_INDEXER_TIMEOUT_MS=5000
```

Remote HTTP must use HTTPS and remote PostgreSQL must request TLS. Loopback plaintext is allowed for
development. Startup checks adapter readiness, RPC chain ID, expected signer and the worker migration.

`TerminalWorkerScheduler` queues every observed/missed block onto one drainable lane. Markets and the
two writes per market remain sequential, so a dedicated EOA never has concurrent nonce submissions.
Simulation rejection, submission failure, receipt failure and on-chain revert are separate metrics
and persisted results; attempts repeat only on a later block. Indexer pagination and every HTTP
request are bounded. SIGINT/SIGTERM unsubscribes, drains the nonce lane, closes health HTTP and then
closes adapter-owned signer/RPC/database resources.

- `GET /healthz`: liveness only.
- `GET /readyz`: signer/RPC/database/migration/scheduler readiness.
- `GET /metrics`: adapter-supplied Prometheus registry.

The worker has no privileged protocol role and must use a dedicated low-balance account. Run the
health server on loopback behind deployment-controlled monitoring; it intentionally exposes no write
HTTP endpoint.
