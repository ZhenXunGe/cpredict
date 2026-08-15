# Release provenance and SBOM closure

Date: 2026-08-12

Status: **tooling statically verified; release intentionally blocked**.

## Implemented

- Deterministic SPDX 2.3 JSON SBOM with a fixed timestamp and an input-derived namespace.
- Complete inventory of all 172 non-root `package-lock.json` package instances, including exact version, declared license, resolved URL and SHA-512 integrity converted to hexadecimal.
- Locked Solidity dependencies and project-local build/security/load/PostgreSQL/skill tooling. The
  deterministic inventory contains 216 packages total: the Cpredict root package, 172 npm package
  instances and 43 Solidity/tool records.
- Deterministic `manifests/licenses.json` and `manifests/third-party-notices.md`.
- Explicit source-license scope for Permit2, its Solmate test-deployment closure, and Account Abstraction interfaces. `licenseConcluded` remains `NOASSERTION`; these artifacts are an inventory, not legal advice.
- Source-manifest inventory now includes `README.md`, `LICENSE`, `.gitignore`, the PostgreSQL lock, SBOM/license/notices, and release provenance schemas/configuration.
- Release bundle manifest schema v2 binds the signed annotated tag and HEAD commit, source manifest, requirements manifest, release gate index and SPDX SBOM.
- A fixed 22-gate local release policy. Every index entry must reference exactly `reports/release/gates/<gate-id>.json`; each result record binds the exact gate ID, fixed command, fixed runner identity, `FULL` profile, zero exit code, `PASS`, final source-manifest SHA-256, and role/path/SHA-256 inventory for its raw evidence.
- Security results additionally validate the pinned tool identity, exact security gate (including `mutation-full` rather than the fee-vault campaign), accepted tool exit, validator exit, input snapshot and every original output artifact. Coverage, gas, PostgreSQL, API/WebSocket load and deployment-tooling records have dedicated machine-readable semantic checks, including zero-skip requirements and commercial load thresholds.
- `FAIL`, `BLOCKED`, `NOT_RUN`, smoke profiles, wrong commands/runners/tools, unknown/missing/duplicate gates, broad or stale result references, duplicate evidence, stale source-manifest binding, stale nested evidence and unsafe/symlink evidence paths are rejected.
- `README.md`, `LICENSE`, SBOM, license inventory and third-party notices are mandatory archive payloads.
- `.github/workflows/release-audit.yml` now runs the fixed 22-gate policy, records evidence outside the checkout, aggregates only fresh same-source PASS records, reproduces generated artifacts on a GitHub-hosted signer, and uses the pinned `actions/attest` v4.2.1 commit for a custom OIDC attestation. The signed-tag workflow requires exactly one `Release-Audit-Run` trailer, verifies the run/commit/workflow, downloads the external artifact, runs `gh attestation verify` plus the strict local predicate verifier, and supplies `--attested-gates-root` to both bundle build and recheck. Real GitHub OIDC/CI is still **NOT RUN**.

## Self-reference boundary

`manifests/source-manifest.json` cannot hash itself. `manifests/release-gates.json` also cannot be part of the source manifest because it contains `sourceManifestSha256`. The release gate policy/schema and SBOM outputs are source-manifest inputs; the release gate evidence index is instead independently hashed by `RELEASE-BUNDLE.json`. The signed tag still binds the complete committed checkout. Result records and their nested evidence bind the final source-manifest digest, avoiding HEAD/self-reference cycles while the bundle continues to bind the signed tag HEAD.

## License evidence boundary

- NPM licenses come from exact `package-lock.json` package metadata.
- Solidity source dependency licenses and actual imported/deployed-test source scope are explicit policy data checked by unit tests.
- Tool lock records that do not publish license metadata in the repository lock are retained as `NOASSERTION`, not guessed.
- Account Abstraction's repository `LICENSE` is GPL-3.0, while the actual imported interface files declare SPDX MIT. Both facts are recorded; no compatibility conclusion is made.

## Verification performed

- `npm run test:sbom`: 3/3 pass.
- `npm run check:sbom`: pass, byte-identical regeneration.
- `npm run test:release-tools`: 39/39 pass, including workflow wiring, production runner/aggregate and semantic release-gate negative cases.
- `npm run test:load-tools`: 16/16 pass.
- `npm run test:deployment-tools`: 18/18 pass.
- Node syntax checks for the changed SBOM/release scripts: pass.
- Ruby/Psych parse of all four GitHub Actions workflows: pass.
- JSON parse of provenance manifests/schemas: pass.
- `npm run check:artifacts`: regenerated and rechecked after this implementation batch; current result is recorded by the final source-manifest gate.
- `npm run check:release-gates`: blocked as intended because `manifests/release-gates.json` is absent.

## Intentional release blocker

`manifests/release-gates.json` is deliberately not committed or generated locally while the required runtime/security gates are incomplete. It is an external audit-run artifact created only after all 22 gates pass and then attested by GitHub OIDC. `npm run check:release-gates` without a verified external evidence root therefore exits nonzero. No real release bundle, audit commit, signed tag or publication is represented as complete.

Current blockers include incomplete Echidna x86_64 lifecycle corroboration, the schema-v4 distributed commercial load remaining NOT RUN, commercial economics remaining 7/7 NOT_VERIFIED, and the aborted full mutation campaign. SBOM/provenance tooling PASS does not change those results. Release remains blocked until all 22 gates pass on one commit, the real GitHub audit workflow/OIDC attestation succeeds, and a signed tag binds that exact audit run. No trusted runner attestation is claimed here.
