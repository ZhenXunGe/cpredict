# Economic Specification and Invariants

Let `P` be total principal and `B=10,000`:

```text
R = floor(P * creatorRakeBps / B)
Q = floor(R * protocolShareBps / B)
E = earlyEnabled ? floor((R-Q) * earlyBirdShareBps / B) : 0
C = R-Q-E
W = P-R
```

The identity `W+C+Q+E=P` is exact. Winner, early-bird and timeout-bonus distributions use a dynamic
remaining-units/remaining-pool algorithm. Each claim rounds against the then-current pool and units;
the claim consuming all remaining units drains the pool. Remainders from earlier divisions therefore
change later ratios and can be allocated to multiple later claimants, not only the final claimant.
Ordering, transfers and address splitting can change individual atomic-unit allocation, but every
pool is exhausted exactly without overpayment and aggregate value cannot increase.

Creator void and timeout void refund one USDC atomic unit per burned share unit to the current
holder. Timeout refund also fixes an equal amount of bonus eligibility at the refund address; the
later bond bonus uses the same remaining-pool method. Early-bird score belongs to the original
primary buyer and is unaffected by ERC-1155 transfers. If timeout occurs with `P=0`, no bonus units
exist and the bond is credited to the creator rather than funding an unclaimable zero-denominator pool.

For C2C:

```text
gross = floor(units * unitPrice / 1e6)
platformFee = floor(gross * platformFeeBps / B)
creatorFee = floor(gross * creatorFeeBps / B)
sellerProceeds = gross-platformFee-creatorFee
```

Required invariants: Vault assets cover all user liabilities; market principal is isolated; supply,
mint, burn and refunds conserve units; winner sum is W; early sum is E; refund sum is P; timeout
bonus sum is the slashed bond; all rake components sum to R; C2C seller plus fees equals gross; C2C
does not change principal/supply; guard reported exposure is conservative; governance cannot receive
principal; pauses do not impair exits; terminal state is irreversible; signatures cannot replay.
