# Canonical-chain Indexer and read API

`src/main.ts` is the production composition root. It creates a real `viem` HTTP `PublicClient`, a
`PostgresEventStore`, the canonical/reorg-aware `ChainIndexer`, a bounded non-overlapping polling
scheduler and the read-only Fastify API in one process. It never signs transactions.
The legacy `src/api-main.ts` executable is an alias to the same complete runtime, so deployments
cannot accidentally start an API-only process without ingestion, strict configuration or readiness.

## Database and startup

Apply `migrations/001_indexer.sql`, `migrations/002_settlement_evidence.sql`, and
`migrations/003_read_api_indexes.sql` in order with a separately authorized migration identity.
The latter migrations are idempotent and cover settlement evidence plus bounded read-path indexes.
Runtime readiness fails closed if a required table, evidence column, or read index is absent.
Runtime credentials should have only the DML privileges needed by the tables. Startup also fails
closed if PostgreSQL is unavailable or RPC `eth_chainId` differs from the configured chain.

After `npm run build:offchain`, start with:

```text
node dist/offchain/indexer/src/main.js
```

Required configuration (all values are strings):

```text
CPREDICT_INDEXER_HOST=127.0.0.1
CPREDICT_INDEXER_PORT=3001
CPREDICT_INDEXER_LOG_LEVEL=info
CPREDICT_INDEXER_CHAIN_ID=84532
CPREDICT_INDEXER_RPC_URL=https://...
CPREDICT_INDEXER_DATABASE_URL=postgresql://...?...sslmode=verify-full
CPREDICT_INDEXER_FACTORY_ADDRESS=0x...
CPREDICT_INDEXER_CORE_ADDRESSES=0xFactory,0xMarketplace
CPREDICT_INDEXER_DEPLOYMENT_BLOCK=...
CPREDICT_INDEXER_CONFIRMATIONS=2
CPREDICT_INDEXER_BATCH_SIZE=500
CPREDICT_INDEXER_MAX_BATCHES_PER_TICK=4
CPREDICT_INDEXER_POLL_INTERVAL_MS=1000
CPREDICT_INDEXER_RPC_TIMEOUT_MS=5000
CPREDICT_INDEXER_LISTEN_BACKLOG=16384
CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS=20000
CPREDICT_INDEXER_WS_MAX_CONNECTIONS=12000
CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS=15000
CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES=65536
CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS=5000
```

Unknown `CPREDICT_INDEXER_*` variables are rejected. Remote RPC must use HTTPS; remote PostgreSQL
must request TLS through `sslmode=require`, `verify-ca` or `verify-full`. Plain HTTP/PostgreSQL is
accepted only on loopback for local development. Factory is configured separately because its
`MarketCreated` logs drive same-batch market discovery; core addresses must include every always-on
contract whose events are indexed, normally Factory and Marketplace.

Each scheduler tick commits at most `MAX_BATCHES_PER_TICK`, each event batch is capped at 10,000
blocks, block RPC concurrency remains capped at 50, and ticks never overlap. SIGINT/SIGTERM stops new
polls, drains the active transaction, closes HTTP and then closes PostgreSQL.

## Operations

- `GET /healthz`: process liveness only.
- `GET /readyz`: 200 only while PostgreSQL schema, RPC chain and scheduler are ready.
- `GET /metrics`: Prometheus batch/event/head/timing metrics.
- `/v1/*`: read-only market, listing, fill, position and claim endpoints.
- `GET /v1/stream?chainId=<id>&market=<optional address>` upgraded to WebSocket: read-only
  checkpoint invalidations. A versioned `ready` message establishes the subscription; committed
  Indexer batches emit versioned `checkpoint` messages so clients can refetch canonical HTTP state.

Market responses expose `evidenceHash` and `evidenceUri`. Creator resolve/void events persist their
non-zero SHA-256 commitment; permissionless timeout void emits zero and is returned as `null`. The URI
is never trusted from an event or database: it is deterministically rebuilt as CIDv1 raw codec with a
sha2-256 multihash from the 32-byte digest.

The WebSocket server disables compression, rejects client application messages, bounds payloads,
connections and queued bytes, evicts dead peers using ping/pong, and drains with close code 1001
before HTTP/PostgreSQL shutdown. Prometheus exposes current, accepted, rejected, closed and outbound
stream metrics. The HTTP maximum must be at least the WebSocket maximum. These process bounds do not
replace TLS termination, edge admission control or multi-instance capacity planning.

Run behind a TLS reverse proxy and keep the bound host on loopback. Readiness is not proof that the
head is finalized or that upstream RPC is correct; operate multiple RPC checks and alert on indexed
head lag. PostgreSQL migration/reorg integration still requires a disposable `TEST_DATABASE_URL` in
the dedicated integration test.
