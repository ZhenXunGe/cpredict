# Public test site implementation contract

The user's B0–B5 plan is the scope. The developer Demo and its v1 APIs remain supported. This document maps the new interfaces to code; it does not claim runtime acceptance.

Authoritative wire validation is `offchain/app-core/src/contracts.ts`. Every raw chain integer is a decimal string, every mutation binds environment + deployment + verified application account. Runtime configurations are parsed before providers or requests are started. No browser configuration contains provider secrets or a database URL.

| Interface | Request and validation | Response / consumer / failure |
| --- | --- | --- |
| GET /v1/me/accounts | Privy Bearer token, server verification | Verified account identities; client never substitutes controller for asset address |
| POST /v1/me/accounts/challenge and POST /v1/me/accounts | Linked wallet + one-use signed control proof | Fixed Kernel 0.3.1 / EP 0.7 / index binding; mismatch rejected |
| POST /v1/operations | Authenticated account, UUID idempotency key, typed business intent, nonce, SDK encoded call/factory data | Durable sanitized operation; same key returns original; different intent conflicts |
| GET /v1/operations and /:id | Subject ownership and environment | Recover original hashes; query outage never turns a successful operation into failure |
| POST /v1/aa/:operationId | Auth + registered operation + permitted SDK JSON-RPC method | Exact canonical SDK call encoding, factory and nonce checked; only one send |
| POST /v1/faucet/claims | Same operation registration, faucet intent only | Same operation record, 1,000 ctUSD per account / 24 hours; public mint itself is unrestricted |
| POST /v1/sponsorship/policy | Expected provider project/chain and existing admitted operation | Strict AND policy; unknown, expired or excessive operation denied |
| /v2/activity/:owner, /v2/entitlements/:owner, /v2/pnl/:owner | Deployment-bound, cursor/filter/snapshot validation | Public confirmed facts, explicit completeness and unknown reasons; stale snapshot => 409 |
| /v2/leaderboards | Published period, frozen market roster, common canonical block | Versioned test-only complete-cost realized PnL, ties, creator exclusions, corrections |
| /v1/ops/reports | Server admin allowlist | Readonly event-time aggregate; no user-fund action |
| GET /v1/ops/feedback | Server admin allowlist | Environment-bound snapshot cursor; filters by feedback or operation ID, immutable original text, no login subject returned |

Errors use `{error:{code,message,operationId?}}`; display stable user copy by code with a generic fallback. SDK/RPC exception bodies are never stored or returned as financial truth. Unconfigured services fail closed. User-facing calls use query cancellation and keys that include full environment/deployment/account identity.

`ops/reports.providerManagement` is null without paired server-only management credentials. Otherwise it reports the fixed ZeroDev project/chain/source, per-endpoint last attempt and successful collection times, requested and retained data windows, classified read errors and 15-minute staleness. Collection runs every five minutes and retains the last successful response in memory on failure. Raw management payloads and credentials have no public route. `mappingStatus` remains `awaiting-real-response-contract`; transport success cannot mark spend known or sponsorship policy verified. Monetary/policy mapping awaits sanitized real responses and the required positive/negative policy checks.

## Shared indexer routes

The existing indexer process and database serve both clients. Legacy `/v1/*` and `/v2/*` retain their chain-only requests, response fields and pagination, even when financial projection is enabled. The public site uses the `/public` namespace: `/public/v2/markets`, `/public/v2/markets/:market`, `/public/v1/listings`, and the activity, entitlements, PnL, leaderboard and sync routes above with `/public` prepended. Every public query requires the matching environment and deployment; a supplied chain must also match. Binding validation is scoped to that namespace. Public pagination is bound to filters and the retained projection snapshot.

Public runtime indexer bases end in `/indexer/public`; the old `/indexer/` proxy and Demo configuration keep their original base. These paths share ingestion and queries, not a second indexer deployment.

## Browser compilation and provider declarations

The user site has its own browser TypeScript/Vite build (`npm run site:check` / `site:build`). Application and imported shared TypeScript remain strict, including exact optional fields and unchecked indexes. `check:offchain` retains NodeNext and full declaration checking for services, the SDK and the legacy Demo; the new browser project is checked separately.

Privy React 3.40.0 and three pinned transitive packages publish incomplete declarations. The user-approved declaration-only repairs are documented in `patches/README.md` and hash-bound by `manifests/sdk-declaration-patches.json`; no SDK runtime file changes. Missing type dependencies are pinned from the official package manifests. Both browser and server builds explicitly apply verified patches after `npm ci --ignore-scripts`. The browser now has `skipLibCheck: false`; `site:check:dependencies` is a required passing gate. Wallet/provider runtime acceptance remains mandatory and separate from declaration compatibility.

## UI specification

Desktop concept: `docs/assets/web-demo/public-site-desktop-concept.png`. Mobile confirmation concept: `docs/assets/web-demo/public-site-mobile-concept.png`. Generated with the built-in imagegen tool and inspected with view_image. These local design references are intentionally covered by the repository's existing visual-artifact ignore rule.

Palette reuses the Demo: cool background #f4f7fb, white surfaces, navy #15233d, blue #1769e0, muted #6d7a90, line #dce4ef, amber #b9700c. Inter/system sans; headings 28–34px desktop / 24px mobile, body 14–16px, controls 14px minimum, line height 1.5. Sidebar 224px, desktop gutter 28px, mobile 16px. Controls 10px radius, modal 18px top corners, no decorative imagery or gradients. Navigation, lists, forms, confirmation dialog and feedback are shared primitives; App composes features rather than owning transaction logic.

Allowed navigation: 市场、我的资产、持仓与权益、交易历史、创作者中心、测试排行榜、账户与帮助; 运营报表 is role gated. Markets heading 探索市场; toolbar 搜索市场、全部状态、创建市场; row labels 市场标题、创建者、结束时间、选项、状态、操作. Test notice is mandatory. Mobile uses an accessible menu and scrollable transaction sheet; login/export use official Privy components.

Required corrections to generated references: all sample rows/dates are design examples only, never production fixtures. Mobile generation invented odds, volume, liquidity and an old date behind the sheet; these are rejected because they conflict with the approved product/data contract. Real pages only show verified values or explicit unknowns. Fee text is derived from the actual operation and protocol economics, not hardcoded from the concept. Gas sponsorship is shown only after admission; provider configuration is not proof of sponsorship success.
