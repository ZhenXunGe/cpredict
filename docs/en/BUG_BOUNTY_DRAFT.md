# Cpredict Protocol V1 — Public Bug Bounty Draft

Status: complete policy draft, **not live and not funded**. Do not publish it, invite testing, or
represent a reward as available until production scope, treasury funding, triage coverage, legal
terms, and emergency contacts are approved. No contract in the current workspace is deployed.

## 1. Launch prerequisites

All of the following are hard prerequisites:

- two independent audits and fix verification complete against the release source;
- exact in-scope chain IDs, proxy/token dependencies, deployed addresses, frontend/API origins, and
  source tag are final;
- the maximum reward is escrowed or otherwise demonstrably payable;
- 24×7 Critical incident routing, backup responders, Safe signers, and an incident runbook have been
  exercised;
- legal counsel approves safe-harbor, sanctions, tax, privacy, and disclosure language; and
- the platform/triage provider and project agree on severity, proof requirements, duplicate rules,
  payout currency, SLA, and appeal path.

## 2. Proposed in-scope assets

The published program must list addresses, not contract names alone.

| Asset                                                       | Chain/address/source | Status       |
| ----------------------------------------------------------- | -------------------- | ------------ |
| ProtocolConfig/Emergency/Guard/Factory                      | TBD                  | not deployed |
| FullMarketVault/Clone implementation and registered markets | TBD                  | not deployed |
| BondEscrow/FeeVault/FixedPriceMarketplace                   | TBD                  | not deployed |
| SponsorshipPaymaster and EntryPoint deposit policy          | TBD                  | not deployed |
| production SDK/sponsor/indexer/API domains                  | TBD                  | not deployed |

Canonical USDC, Permit2, EntryPoint, Safe, Arbitrum, RPC, Bundler, and external Paymaster code are not
owned by Cpredict. A Cpredict-specific misuse or unsafe integration is in scope; a vulnerability
solely in an upstream system must be reported to that upstream program.

## 3. In-scope impacts

- unauthorized theft, diversion, permanent freezing, or double claim of principal, payouts, bond,
  fees, Marketplace escrow, or Paymaster deposits;
- protocol insolvency or broken conservation/rounding that creates unbacked claims;
- unauthorized terminal transition/outcome, terminal reversal, governance/timelock/emergency role
  escalation, or bypass of an immutable economic snapshot;
- Full/Clone initialization, implementation, storage, or deterministic-deployment compromise;
- cross-chain/cross-function/cross-market signature replay or unauthorized sponsorship;
- permanent denial of an exit path under conditions controlled by Cpredict; and
- a production client/indexer/sponsor flaw that deterministically signs or presents an economically
  different operation from the one the user approved.

## 4. Known/out-of-scope behavior

- a creator choosing a dishonest outcome while exercising the documented creator-settlement trust
  model, without bypassing contract rules;
- Sybil bypass of per-address limits, voluntary C2C trades with insiders, or ordinary transaction
  ordering/price movement without a contract violation;
- Arbitrum sequencer downtime, USDC blacklist/pause/proxy risk, or upstream provider outage by itself;
- findings already listed in the release `KNOWN_ISSUES`/accepted-risk register;
- attacks requiring stolen keys, leaked credentials, social engineering, physical access, or a
  governance majority acting within its disclosed authority;
- UI/metadata content issues without a defined security impact; and
- gas optimizations, best-practice suggestions, or unavailable optional services without fund or
  integrity impact.

Out of scope does not waive payment when an upstream behavior combines with a Cpredict defect to
produce an in-scope impact.

## 5. Research rules

- Use a local fork or private test environment. Never test against public deployed contracts or
  other users without written case-specific authorization.
- No phishing, social engineering, credential attacks, denial-of-service load, spam, privacy breach,
  or accessing/modifying data beyond the minimum needed for the PoC.
- Stop immediately if user funds or confidential data could be affected; preserve evidence and use
  the private reporting channel.
- A report must include impact, affected asset/version, preconditions, deterministic reproduction,
  executable PoC where safe, and suggested remediation. Screenshots or scanner output alone are
  insufficient.
- Do not disclose before written resolution/disclosure approval. Duplicate rewards go to the first
  complete, reproducible report received by the triage system.

## 6. Severity and proposed rewards

Pin the published program to the then-current classification. As of 2026-08-08, Immunefi lists
Vulnerability Severity Classification System v2.3 as current; this draft uses impact-first scoring
and must be reconciled with the platform during onboarding:
https://immunefi.com/severity-classification-systems/

The following is a recommended funding envelope, not an authorized promise:

| Severity |                                                           Proposed payout |
| -------- | ------------------------------------------------------------------------: |
| Critical | 10% of directly affected funds, minimum 50,000 USDC, maximum 500,000 USDC |
| High     |                                                        10,000–40,000 USDC |
| Medium   |                                                         2,500–10,000 USDC |
| Low      |                                                          1,000–2,500 USDC |

Final amounts within a range depend on demonstrated impact, exploitability, affected deployed
value, quality of the report, and whether the exploit is repeatable. The project must not reduce a
valid payout merely because it patched quickly or because an emergency pause limited realized loss.
Rewards are paid in USDC after identity/sanctions/tax checks required by the approved platform and
law; those checks must be disclosed before launch.

## 7. Response and payout SLA

| Stage                               |         Critical |             High |       Medium/Low |
| ----------------------------------- | ---------------: | ---------------: | ---------------: |
| automated/private acknowledgement   |       15 minutes |          4 hours |   1 business day |
| human initial triage                |           1 hour |   1 business day |  3 business days |
| reproducibility/severity decision   |         24 hours |  3 business days | 10 business days |
| status update while unresolved      |   every 24 hours |     every 3 days |     every 7 days |
| target payment after final decision | 10 business days | 15 business days | 20 business days |

Named primary/backup responders and a payout approver are `TBD`. If these SLAs cannot be staffed and
funded, the bounty must not launch.

## 8. Safe harbor and disclosure

The final terms should grant good-faith researchers authorization and a covenant not to pursue legal
action when they follow the rules, while preserving user privacy and applicable law. Emergency
whitehat fund rescue is a separate, higher-risk authority and must not be implied by ordinary bounty
terms. Immunefi describes its Safe Harbor as a legal framework specifically for intervention during
active blackhat exploitation; enable it only after legal review, a destination vault, signer drill,
and reward policy are operational: https://immunefi.com/safe-harbor/

The publication policy must define coordinated disclosure timing, CVE/public-report ownership where
applicable, redaction of user/secrets data, unresolved-risk statements, and circumstances that delay
publication. A fix is not publication approval.
