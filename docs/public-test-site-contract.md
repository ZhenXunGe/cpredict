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

Errors use `{error:{code,message,operationId?}}`; display stable user copy by code with a generic fallback. SDK/RPC exception bodies are never stored or returned as financial truth. Unconfigured services fail closed. User-facing calls use query cancellation and keys that include full environment/deployment/account identity.

## Browser compilation and provider declarations

The user site has its own browser TypeScript/Vite build (`npm run site:check` / `site:build`). Application and imported shared TypeScript remain strict, including exact optional fields and unchecked indexes. `check:offchain` retains NodeNext and full declaration checking for services, the SDK and the legacy Demo; the new browser project is checked separately.

Privy React 3.40.0 publishes declarations referencing missing internal names and optional cross-chain types. The inspected official 3.20.0 tarball contains the same declaration-generation defect, so a downgrade does not resolve it and is not installed. The browser project uses `skipLibCheck` for third-party declaration files only, without replacing Privy APIs with local ambient declarations. `site:check:dependencies` explicitly exposes this upstream limitation; it is not a passing gate. Wallet/provider runtime acceptance remains mandatory. This is an implementation-time compatibility finding, not evidence that provider flows have passed.

## UI specification

Desktop concept: `docs/assets/web-demo/public-site-desktop-concept.png`. Mobile confirmation concept: `docs/assets/web-demo/public-site-mobile-concept.png`. Generated with the built-in imagegen tool and inspected with view_image. These local design references are intentionally covered by the repository's existing visual-artifact ignore rule.

Palette reuses the Demo: cool background #f4f7fb, white surfaces, navy #15233d, blue #1769e0, muted #6d7a90, line #dce4ef, amber #b9700c. Inter/system sans; headings 28–34px desktop / 24px mobile, body 14–16px, controls 14px minimum, line height 1.5. Sidebar 224px, desktop gutter 28px, mobile 16px. Controls 10px radius, modal 18px top corners, no decorative imagery or gradients. Navigation, lists, forms, confirmation dialog and feedback are shared primitives; App composes features rather than owning transaction logic.

Allowed navigation: 市场、我的资产、持仓与权益、交易历史、创作者中心、测试排行榜、账户与帮助; 运营报表 is role gated. Markets heading 探索市场; toolbar 搜索市场、全部状态、创建市场; row labels 市场标题、创建者、结束时间、选项、状态、操作. Test notice is mandatory. Mobile uses an accessible menu and scrollable transaction sheet; login/export use official Privy components.

Required corrections to generated references: all sample rows/dates are design examples only, never production fixtures. Mobile generation invented odds, volume, liquidity and an old date behind the sheet; these are rejected because they conflict with the approved product/data contract. Real pages only show verified values or explicit unknowns. Fee text is derived from the actual operation and protocol economics, not hardcoded from the concept. Gas sponsorship is shown only after admission; provider configuration is not proof of sponsorship success.
