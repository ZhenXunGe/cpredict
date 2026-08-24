# Local operations drill adapter

`npm run stack:drill` consumes an absolute reviewed adapter and executes the 13 IDs exported by
`REQUIRED_DRILLS`. The adapter exposes `inspect`, `runDrill`, and `resumeDrill`; every drill returns
non-empty hash-bound artifacts below the runner's ignored evidence root. The runner writes the active
drill before execution and only calls `resumeDrill` after interruption.

The output is always `LOCAL_SIMULATION` with `formalOpsEvidence: NOT_RUN`. It deliberately cannot
satisfy `validate-ops-evidence.mjs`. Formal evidence still requires two RPC providers, real monitoring
and alert delivery, KMS attestation, durable artifact URIs, and three independent operator signoffs.
