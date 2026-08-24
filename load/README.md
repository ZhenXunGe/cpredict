# Cpredict load and concurrency acceptance

## Distributed commercial gate

**Current status: infrastructure STATIC/fixture verified; formal three-host acceptance NOT RUN.**
No schema-v4 production/equivalent-capacity role bundle, telemetry window, reorg drill or Ed25519-
verified commercial PASS exists. The implementation record is
[`reports/performance/distributed-commercial-load-system-2026-08-12.md`](../reports/performance/distributed-commercial-load-system-2026-08-12.md).

Formal closure no longer uses the all-in-one local runner. Copy the same clean source checkout to
three independently identified hosts, use one `RUN_ID`, and run these roles with overlapping time
windows:

- `scripts/load/sut-up.sh` on the production/equivalent-capacity API + Indexer + PostgreSQL host;
- `scripts/load/load-run.sh` on a separate k6 host against non-loopback TLS API/WS targets;
- `scripts/load/chain-run.sh` on a separate controlled-chain host for 50 tx/s x 600 seconds;
- `scripts/load/evidence-collect.sh` after copying all three immutable role directories to an
  evidence host with an offline Ed25519 key pair.

Every role requires `CPREDICT_HOST_IDENTITY` plus `CPREDICT_HOST_IDENTITY_SOURCE` (for example a cloud
instance document ID or TPM attestation label). The role manifest stores only SHA-256 identities and
an independently derived machine fingerprint. Schema-v4 aggregation fails if any declared identity
or machine fingerprint repeats, a stage is nonzero/unrun, an artifact digest changes, required
telemetry/reorg/event-latency evidence is absent, or the final Ed25519 signature cannot be verified.
Each role also requires `CPREDICT_GIT_COMMIT_SHA`, `CPREDICT_SOURCE_MANIFEST_PATH`,
`CPREDICT_RELEASE_CONFIG_PATH`, `CPREDICT_RUNTIME_IMAGE_DIGEST`, `CPREDICT_CLOCK_SOURCE`, and
`CPREDICT_CLOCK_MAX_OFFSET_MS`, plus `CPREDICT_CLOCK_EVIDENCE_PATH` for the sampled schema-v1 clock
receipt. Aggregation rejects source/commit/config/migration drift, clock offset
over 100 ms, less than 300 seconds of three-role overlap, or an SUT window that does not cover the load
and chain role windows. Runtime image digests are individually retained because the three roles may
legitimately use different images.

The frozen release-config input has schema version 1 and binds the shared `gitCommitSha`,
`sourceManifestSha256`, `migrationsSha256`, plus exact `runtimeImageDigests.sut/load/chain`. Each role
checks its own image digest against that shared file before it can emit completed evidence; the root
collector then requires all three copies of the config and source manifest to have identical hashes.

The checked-in SUT collector samples `/metrics`, the configured chain RPC, and PostgreSQL SQL for the
whole overlapping gate. Its normalized report covers Node CPU/memory/event-loop lag/connections/
queued/in-flight requests and request latency, PostgreSQL connection-pool acquisition wait/active
connections/checkpoints/QPS/query p95, Indexer chain head/
last indexed block/block lag/tick latency, and WS accepted/current/peak/rejected/ready/heartbeat.
The chain observability command must write event-to-client p95/p99 with verified clock
synchronization, plus a multi-block reorg report proving common ancestor detection, atomic database
rollback, replay, and recovery. Event-to-client p95 remains strictly below 2 seconds.

The environment-specific start/telemetry/reorg commands are intentionally injected instead of
hard-coding a cloud vendor or container orchestrator. They are acceptance inputs and must themselves
be frozen by the release operator. The historical `run-full.sh` remains for local diagnostics only;
it cannot produce schema-v4 distributed commercial evidence or close the release acceptance.

The commercial API/WS lane now exercises the production composition: the real Fastify read API and
bounded WebSocket stream, the real `PostgresEventStore`, the production Indexer scheduler, a fresh
project-local PostgreSQL 17.10 cluster, and a fresh local Anvil RPC. PostgreSQL is migrated and seeded
with exactly 100 markets and 100,000 listings. The previous deterministic HTTP/WS harness remains in
`load/harness/` only for isolated development; neither production smoke nor the full gate starts it.

Separate proof lanes remain explicit:

1. Production API/WS + PostgreSQL: capacity and connection acceptance on the local production
   composition.
2. `indexer/benchmark.mjs`: the real `ChainIndexer` against a deterministic synthetic client/store;
   supplemental ingestion-logic evidence only.
3. `chain/hot-market.mjs`: current protocol artifacts on fresh local Anvil; submitted, included,
   successful and expected-revert outcomes remain separate.

## Focused production-composition smoke

This seeds the complete 100/100k PostgreSQL dataset, then runs a small HTTP and WebSocket sample. It
does not satisfy the commercial duration or concurrency target.

```bash
CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE \
bash scripts/load/run-production-smoke.sh
```

Optional safe calibration overrides:

```bash
CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE \
HTTP_RPS=20 HTTP_DURATION=3 WS_CONNECTIONS=20 WS_HOLD_SECONDS=3 \
bash scripts/load/run-production-smoke.sh
```

`scripts/load/run-smoke.sh` and `scripts/load/run-k6-smoke.sh` are aliases to this same real-composition
runner; they no longer invoke the reference harness.

## Commercial local profile

The full runner is intentionally expensive and refuses to start without explicit acknowledgement:

```bash
CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE \
bash scripts/load/run-full.sh
```

It executes:

- one persistent k6 VU pool at 500 RPS for five minutes plus one scheduler-guard second, a two-second
  linear transition to 2,000 RPS, then 2,000 RPS for one minute plus one scheduler-guard second
  against real indexed PostgreSQL reads; the single scenario keeps
  eligible HTTP connections reusable across the phase change instead of cold-starting a second pool;
- 10,000 WebSocket sessions, deterministically admitted over 20 seconds, with every accepted session
  required to receive protocol `ready` and remain open for its complete 60-second hold;
- the supplemental 100-market/100,000-listing synthetic Indexer ingestion lane;
- 50 submitted transactions/s for ten minutes against one real local Full market.

The full runner validates exact project-local k6, Anvil, Cast and PostgreSQL binary hashes against the
repository locks. Every `RUN_ID` owns a new report directory, PostgreSQL data directory and compiled
runtime. It rejects occupied/distinctness-invalid ports, verifies the spawned postmaster PID, data
directory, system identifier, start time, loopback binding, version and exact seeded counts, and
requires the production API child PID plus `/readyz` before load.

## Non-negotiable thresholds

API:

- p95 `< 300 ms` and p99 `< 750 ms`;
- 2xx failure, 5xx and transport rates each `< 0.5%`;
- dropped iterations exactly `0`;
- at least 150,000 steady arrivals, 1,250 transition arrivals and 120,000 burst arrivals; the
  overprovisioned aggregate remains bounded within `271,250..275,002` and dropped iterations are
  exactly `0`; phase tags have no independent upper bound because wall-clock boundary attribution can
  move requests between adjacent phases while the locked aggregate remains bounded;
- the aggregate and each low-cardinality `steady` / `transition` / `burst` phase independently meet
  the same latency and error thresholds.

WebSocket:

- exactly 10,000 sessions and 10,000 protocol-ready samples;
- upgrade, full-duration hold and protocol-ready failure rates each `< 0.5%`;
- an upgrade is not counted as a held session, and a held transport without the versioned ready
  envelope fails closed;
- service-side snapshots must also prove accepted delta `10,000`, rejected delta `0`, final current
  connections `0`, and an actual simultaneous peak of exactly `10,000`.

Runner evidence uses schema version 3. Raw service/tool logs, k6 summaries, seed identity, representative
`EXPLAIN (ANALYZE, BUFFERS)` plans, per-stage process exit codes, PostgreSQL shutdown status and evidence
validator results are all retained. Early aborts remain `runStatus=aborted`; a completed pass requires
every stage and validator exit to be zero. PostgreSQL must end with `pg_ctl status=3`,
`pg_isready=2`, and verified temporary-data removal.

## Current evidence boundary

`reports/performance/production-smoke-real-pg-ws-smoke-20260808-r3/` is the latest focused PASS: fresh
PostgreSQL 17.10, all three migrations, exact 100/100k data, production Fastify/Indexer startup, 60/60
HTTP 2xx responses at 20 RPS, and 20/20 WebSockets upgraded, protocol-ready and held for three seconds.
This is a smoke result, not a commercial load result.

The only formal production-composition schema-v3 full run is
`reports/performance/full-production-schema3-20260808T1450Z/`; it is preserved as **FAIL / aborted**.
The API completed 269,682 requests with no response, 5xx or transport errors, but dropped 319 planned
iterations and missed both latency gates (`p95=332.99 ms`, `p99=751.55 ms`). A runner defect also
started WebSocket work after the API failure; the run was stopped and its manifest retains
`runnerExit=76`, failed API/WS evidence and an unrun chain stage. Consequently it provides no valid
10,000-connection WebSocket PASS.

The checkpoint-controlled short calibration at
`reports/performance/production-smoke-checkpoint10m-calibration-20260808T1516Z/` is also preserved as
**FAIL**: 28,844 dropped arrivals, 21.09% aggregate transport errors, `p95=2.11 s` and `p99=4.16 s`.
The evidence cannot distinguish same-host load-generator/cold-connection and macOS accept-backlog
pressure from single-process API accept-loop capacity, so it is not proof of a PostgreSQL or business
query root cause.

After those failures, the runner was made stage-fail-closed, the local fixture seed was explicitly
checkpointed before timing, and the future API profile was changed to the single persistent VU pool
described above. Syntax checks, fixtures, unit tests and real `k6 inspect` parsing verify that source
shape without starting another load. No post-change local full has run, so the retained schema-v3
candidate remains **FAIL**. It is no longer sufficient for formal closure: the current commercial gate
is schema-v4 and remains **NOT RUN** until three distinct hosts complete the overlapping SUT/load/chain
windows, all raw stages and telemetry/reorg validators return zero, and the collected bundle verifies
against the offline Ed25519 public key. The older deterministic-harness failure in
`reports/performance/full-20260808T013000Z-final/` also remains historical evidence and must not be
relabelled.

All results are local. They do not prove deployed API/load-balancer capacity, Arbitrum sequencer/RPC
behavior, production PostgreSQL sizing, CDN behavior, or multi-region failover. Arbitrum Sepolia remains a
low-rate functional smoke target, never a 50 tx/s load target.
