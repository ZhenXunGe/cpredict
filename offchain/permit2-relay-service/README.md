# Permit2 buy relay service

This service removes the second wallet prompt from an enabled Permit2 primary buy. The owner still
signs the one-use Permit2 witness; the service then simulates and broadcasts the exact
`buyWithPermit2` call from an operator-funded relayer account.

The service is disabled in the Web Demo runtime by default. Enabling it requires all of the
following:

- the `relay` Compose profile and the `002_permit2_relay_intents.sql` migration;
- a production adapter module exporting `createPermit2RelaySender(config)`;
- a KMS/HSM-backed sender whose address exactly matches `CPREDICT_RELAY_EXPECTED_SENDER`;
- a runtime package generated with `deploy:sync -- ... --permit2-relay`;
- `stack:up -- --relay`; the stack must not be accepted until
  `http://127.0.0.1:8792/readyz` passes locally.

The adapter receives a fully prepared request with explicit chain, target, calldata, gas and
EIP-1559 fee fields. It must send that exact request and must never expose key material to the
service process.

## Failure and replay semantics

The request intent id hashes the complete signed order. A durable Postgres row is reserved before
broadcast, with a second uniqueness boundary on the Permit2 owner and nonce, and the returned
transaction hash is committed after broadcast. A submitted intent
returns the same hash on replay. If the sender call returns without a hash, the row remains
`pending`, the API returns `relay outcome unknown`, and neither the service nor SDK retries it.

The policy accepts only the configured Arbitrum Sepolia chain, Factory, payment token and Permit2;
requires a Factory-registered Vault with matching live wiring; requires the Permit2 amount to equal
the order's maximum payment; caps both deadlines at 15 minutes; simulates the exact calldata from
the configured sender; and rejects gas or fee estimates above the reviewed ceilings.

## Session keys are a separate account model

This relayer does not make Permit2 signatures reusable. Permit2 witnesses bind every order, so an
EOA owner still signs one witness per buy. Popup-free repeated trading requires an ERC-4337 smart
account with a separately scoped session key (or an explicitly chosen EIP-7702 account model), plus
a bundler and deployed account/session validator. Do not store or reuse Permit2 witness signatures
as a substitute.
