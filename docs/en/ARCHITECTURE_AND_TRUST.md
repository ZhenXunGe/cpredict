# Architecture, State Machines and Trust Assumptions

Each market owns one USDC principal balance and one ERC-1155 outcome namespace. Primary purchases
mint units 1:1 with six-decimal USDC atomic units. Secondary transfers cannot alter principal or
outcome supply. Full markets deploy complete bytecode through a Factory-bound CREATE2 deployer;
Clone markets delegate to one permanently fixed implementation and have a lower hard cap.

The market lifecycle is OPEN → RESOLVED, VOIDED_CREATOR or VOIDED_TIMEOUT. Close is timestamp-derived,
not a keeper-owned state. The creator alone may resolve during `[closeAt, closeAt+24h)` and may void
only while `now < closeAt+24h`. At the exact deadline both creator terminal methods are closed and
anyone may timeout-void, so the authority windows do not overlap. Terminal states are irreversible and
claims do not expire. A zero-supply winning outcome cannot be resolved.

The Factory is inactive after deployment. Governance may activate it only once, after checking that
all required dependencies have runtime code, governance/factory/token wiring is exact, the standalone
Clone implementation is pristine, and a chain/address/runtime-codehash dependency fingerprint equals
an independently reviewed deployment-manifest value. Market creation fails closed before activation.

Governance is intended to be a 4/6 Safe behind a Timelock. It can adjust bounded defaults for future
markets, manage authorized protocol callers, raise/retire the launch guard and manage Paymaster
policy. It cannot change a market, a result or a principal recipient. A 2/6 Emergency Safe can only
activate selected new-risk pauses for at most seven days once per governance epoch. Cancel,
transfer, claim and refund are not pausable.

External trust assumptions include Base L2/sequencer, canonical USDC, Permit2, EntryPoint, Safe
signers, the creator's result honesty, sponsor KMS/backend and RPC/indexer availability. The creator
can deliberately choose a dishonest outcome; V1 protects custody and disclosure, not truth. Sybil
limits and post-close insider C2C trading are also residual product risks.

The Marketplace holds only active listing shares. Seller proceeds are sent atomically and fee
amounts enter a fixed FeeVault with immutable historical beneficiary credit. BondEscrow failure
cannot block principal: timeout refunds establish bonus units first, and permissionless bond funding
may happen later. If a timed-out market has zero primary principal, there are no bonus units or valid
beneficiaries; the bond is credited back to the creator instead of funding an unclaimable pool.
