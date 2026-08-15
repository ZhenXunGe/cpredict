# Questions for Independent Auditors

1. Can any reentrant ERC-1155 receiver or token callback obtain more USDC than its burned or winning
   units, or leave Marketplace accounting inconsistent?
2. Can any path bypass the protocol-Marketplace owner rejection, burn escrowed terminal positions,
   or misattribute proceeds before `returnTerminalListing` restores them to the seller?
3. Are Full and Clone initialization/storage semantics equivalent for all states? Can the
   implementation, deployer or salt domain be hijacked?
4. Does dynamic remaining-pool recomputation preserve exact exhaustion under every claim ordering,
   address split, transfer-before-claim or zero-unit edge, while correctly disclosing that multiple
   later claimants may receive earlier division remainders?
5. Can BondEscrow/FeeVault credit be duplicated, redirected, left unbacked or made to block principal,
   and is returning a zero-participant timeout bond to the creator the only non-stuck policy?
6. Can LaunchExposureGuard under-report active liabilities through partial fills, sync ordering,
   terminal transitions or retirement?
7. Are the Permit2 witness suffixes byte-for-byte canonical, do independent vectors match, and do
   hashes bind every value that changes economic effect across chain, spender, function,
   market/listing and outcome?
8. Does the Paymaster EIP-712 digest match the on-chain parser exactly, including
   `paymasterVerificationGasLimit` and `paymasterPostOpGasLimit` from the packed header? Are
   reservation, spent, validity, policy rotation, service commit uncertainty, postOp and
   EntryPoint-only assumptions safe under v0.8 behavior?
9. Can Timelock bootstrap or role renunciation leave an unexpected proposer, canceller, executor,
   admin, authorized fee caller or factory authority?
10. Are all timestamp boundaries internally consistent, especially equality at close, resolve
    deadline, listing expiry and client deadline?
11. Is any non-standard canonical USDC behavior (pause, blacklist, proxy upgrade, zero-first approval,
    revert/no-return) able to cause silent accounting divergence?
12. Are the current 22,975-byte Full and 23,763-byte Full deployer runtimes safe against
    compiler/metadata configuration drift, and
    is the deployed runtime reproducible from the manifest?
13. Can Factory activation be bypassed, repeated, or committed to wrong code/wiring? Is the expected
    fingerprint independently derived rather than reflexively copied from the candidate Factory?
14. Does arbitrary-depth Indexer rollback find an eventless common ancestor and atomically repair raw,
    registered-market and all derived state in the real PostgreSQL implementation?
15. Which assumptions require an explicit mainnet invariant monitor or operational control rather
    than an on-chain fix?
