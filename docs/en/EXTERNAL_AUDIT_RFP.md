# Cpredict Protocol V1 — Independent Security Review RFP

Status: procurement-ready draft; no reviewer has been retained, scheduled, or paid. This document
does not authorize an engagement. The protocol remains prohibited from holding real funds until
both independent reviews and their fix verification are complete.

## 1. Review objective

The primary objective is to determine whether an untrusted user, market creator, governance
member, keeper, paymaster client, token receiver, or integrated dependency can:

1. steal, strand, double-spend, dilute, or make user principal insolvent;
2. bypass immutable terminal outcomes, claim more than its economic entitlement, or redirect a
   historical fee/bond credit;
3. break Full/Clone equivalence, initialize a clone incorrectly, or substitute implementation;
4. replay Permit2 or ERC-4337 authorization, drain the Paymaster deposit, or evade sponsorship
   budgets;
5. make an emergency control prevent withdrawal/refund, or obtain an authority not declared in the
   privilege matrix; or
6. cause an integration failure that the client represents as a successful economic operation.

The worst credible outcome is permanent loss or freezing of all principal in one or more markets.
Availability and gas findings are secondary unless they impair an exit path or make accounting
unsafe.

## 2. Frozen review input

The final statement of work must replace every `TBD` below and attach the immutable input bundle.

| Field                         | Required value                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Git repository                | `git@github.com:ZhenXunGe/cpredict.git`                                                                                |
| Product authority             | `product-framework.md` v0.21, 31,449 bytes, SHA-256 `5a76a9e0d98691ccc20a1faa37b1607a1d4afd2ca5b17563641cad707ff9aca4` |
| Review commit and signed tag  | `TBD — current workspace is intentionally uncommitted`                                                                 |
| Source manifest SHA-256       | `TBD — regenerate after the audit freeze`                                                                              |
| Solidity source size          | 2,808 physical lines before audit-prep test/report changes                                                             |
| Compiler/build                | Solidity 0.8.36, Cancun, optimizer 200, production `viaIR=true`                                                        |
| Canonical deployment manifest | `TBD — Base Sepolia first; mainnet addresses cannot be assumed`                                                        |
| Review window/person-weeks    | reviewer proposal                                                                                                      |
| Named reviewers and conflicts | reviewer proposal; mandatory disclosure                                                                                |

Normative inputs are `docs/en/AUDIT_SCOPE.md`, `docs/en/ARCHITECTURE_AND_TRUST.md`,
`docs/en/ECONOMIC_SPEC.md`, `docs/en/AUDITOR_QUESTIONS.md`, the Chinese design/traceability set,
`manifests/requirements.lock`, `manifests/dependencies.lock`, generated ABI/storage/selector snapshots, deployment scripts, all
tests, and the final gate reports.

## 3. Two-round independence rule

- **Round 1 — comprehensive assessment:** manual design and code review plus reviewer-authored
  exploit tests/invariants. It must cover contracts, economic/accounting assumptions, deployment
  and privileged bootstrap, Permit2, ERC-4337, and security-critical off-chain interfaces.
- **Round 1 fix verification:** the same team retests every accepted patch against a new frozen
  remediation commit and records fixed, partially fixed, acknowledged, or disputed status.
- **Round 2 — independent adversarial review:** a different legal organization with different lead
  reviewers receives the remediated source, the full protocol specification, and the Round 1 report.
  It must independently reproduce the threat model and may be a staffed review or a managed audit
  competition with explicit senior triage.
- **Round 2 fix verification:** the Round 2 reviewer retests its findings. Any code change after this
  point invalidates the reviewed hash unless both reviewers confirm the delta is out of scope or
  perform a scoped differential review.

Shared ownership, shared lead reviewers, undisclosed subcontracting, or treating a tool scan as one
of the two reviews fails the independence requirement.

## 4. Mandatory review work

1. Verify every requirement and declared deviation against code and tests.
2. Recalculate all principal, rake, early-bird, winner, refund, timeout-bonus, fee, and C2C
   conservation rules, including last-claimant rounding and split-address strategies.
3. Exercise adversarial ERC-1155 callbacks, malicious/failing USDC behavior, direct token transfers,
   listing races, terminal escrow return, and duplicate/late settlement.
4. Differentially review Full and EIP-1167 Clone initialization, storage, runtime codehash, CREATE2
   salts, and Factory atomicity.
5. Review governance/Timelock/Safe bootstrap, EmergencyController epoch limits, Guard retirement,
   role revocation, deployment scripts, and irreversible configuration.
6. Independently derive Permit2 witness and Paymaster EIP-712 hashes and test replay boundaries.
7. Inspect Foundry unit/fuzz/invariant harness quality, mutation survivors, formal properties,
   static-analysis triage, gas/size headroom, and missing branches—not only percentage totals.
8. Review SDK/indexer/worker/sponsor-service assumptions that can cause signature, decimal, finality,
   replay, or false-success failures.
9. Produce concrete exploit PoCs for all Critical/High findings and regression tests for every
   confirmed finding where technically possible.

## 5. Required deliverables

- scope, commit, compiler/settings, exclusions, reviewer names, person-weeks, methods, and tools;
- executive and technical reports with severity, likelihood, impact, exploit preconditions, PoC,
  affected lines, remediation guidance, and residual risk;
- a machine-readable finding register with stable IDs and remediation status;
- new tests, invariants, detectors, or harnesses created during the engagement;
- live readout and engineering Q&A;
- fix-verification addendum tied to the remediation commit; and
- permission to publish the final report, with confidential operational data redacted only by
  mutual agreement.

Severity must prioritize direct user-fund loss/freeze and protocol insolvency. A finding cannot be
closed solely because the launch cap is small; the cap may reduce realized exposure but does not
remove the defect.

## 6. Exit criteria

The review lane is complete only when:

- two independent final reports and two fix-verification addenda identify exact reviewed commits;
- no unresolved Critical or High remains;
- every Medium is fixed or has explicit written risk acceptance, compensating controls, expiry, and
  accountable owner;
- all audit-created regression tests are in the repository and applicable local gates pass;
- the final deployable bytecode is reproducible from the reviewed source manifest; and
- any post-review delta has a reviewer-approved differential scope.

These are necessary but not sufficient for launch: Base Sepolia E2E/canary, operational drills,
legal review, and a funded public bounty remain separate release gates.

## 7. Vendor qualification and selection record

Request comparable proposals from at least three qualified teams and score named personnel rather
than brand alone. Minimum evidence: recent public EVM/accounting reviews, ERC-1155/Permit2/4337 or
equivalent integration depth, senior reviewer availability, independence/conflict disclosure,
fix-review terms, and ability to leave reusable tests.

Official starting points (not endorsements or existing engagements):

- Trail of Bits blockchain assessment: https://trailofbits.com/services/blockchain/
- OpenZeppelin security audits: https://www.openzeppelin.com/security-audits
- Cantina/Spearbit security reviews: https://cantina.xyz/solutions/spearbit/smart-contract-security-reviews
- Sherlock protocol audits: https://docs.sherlock.xyz/audits/protocols

| Decision                             | Owner            | Due                       | Evidence                       |
| ------------------------------------ | ---------------- | ------------------------- | ------------------------------ |
| budget ceiling and payment authority | TBD              | before outreach           | signed procurement approval    |
| Round 1 provider and named team      | TBD              | after proposal comparison | scorecard + SOW                |
| Round 2 provider/competition         | TBD              | before Round 1 ends       | independence declaration + SOW |
| disclosure policy                    | TBD              | before signing            | legal/security approval        |
| freeze commit/tag authorization      | repository owner | before review starts      | signed tag + manifest          |
