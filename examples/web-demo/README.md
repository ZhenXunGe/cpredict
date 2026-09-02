# Cpredict Arbitrum Sepolia Web Demo

This is a Chinese, trust-first developer console for validating and interacting with the Cpredict V1
contracts on Arbitrum Sepolia (`chainId=421614`). It is not the consumer prediction-market product,
an admin console, a signer service, or deployment evidence.

## Run

```sh
npm run demo:dev
```

Open `http://127.0.0.1:4177`. The development server proxies:

- `/rpc` to the public Arbitrum Sepolia RPC;
- `/indexer` to a local Cpredict Indexer on `127.0.0.1:8787`;
- `/evidence` to an optional local canonical-evidence uploader on `127.0.0.1:8790`.

To run the local UI against an existing remote Web Demo stack, set the optional server-side origin:

```sh
CPREDICT_DEMO_REMOTE_ORIGIN=https://101.32.241.211 npm run demo:dev
```

For a persistent local default, put the same assignment in the repository-root `.env.local`; Vite
loads `CPREDICT_DEMO_*` from that ignored file, while an explicit shell value still takes precedence.

Remote mode proxies `/runtime-config.json`, `/deployment/*`, `/rpc`, `/indexer/*` and `/metadata/*`
to that HTTPS origin without rewriting their paths. The value must be an HTTPS origin without a
path, query, fragment or embedded credentials. It intentionally has no `VITE_` prefix: Vite reads it
only while configuring the development server, and it is never injected into browser code. Any
remote Basic Auth challenge is passed through the local proxy; do not put credentials in the URL or
in a browser-exposed environment variable. `/evidence` remains local and disabled unless the loaded
runtime explicitly enables uploads.

This switch only changes `server.proxy`. It does not modify the checked-in runtime config, Compose,
Nginx, deployment manifests, preview server or production build output. Leaving the variable unset
preserves the local targets above.

The source `index.html` and production build keep a strict CSP without `unsafe-inline` or
`unsafe-eval`. Vite injects development CSS through inline style elements, so the Vite-only HTML
transform adds `style-src 'unsafe-inline'` while `npm run demo:dev` is running. It never changes the
production build. Use `npm run demo:build && npm run demo:preview` for production-CSP visual QA.

For production, deploy `npm run demo:build` output behind TLS and configure the same three paths at
the edge. Apply and runtime-verify every header in `security-headers.conf`. Do not expose RPC/API
credentials in `runtime-config.json`; every browser-delivered value is public.

## Runtime trust states

- `VERIFIED`: `FINALIZED_VERIFIED` manifest passes the repository JSON Schema and every configured
  runtime codehash plus critical Factory/Marketplace/USDC wiring check passes at the manifest's
  finalized reference block.
- `DEBUG`: session-only custom addresses have code and critical wiring, but are not bound to the
  signed deployment manifest. The warning never disappears.
- `LOCKED`: any config, manifest, chain, codehash, wiring, network or wallet prerequisite fails.

Writes require a connected EIP-6963/injected wallet on Arbitrum Sepolia and `VERIFIED` or explicit
`DEBUG`. The wallet is never asked for a private key. Account changes force reconnect so Creator and
trader roles cannot be silently mixed.

## Supported flows

- manifest, chainId, runtime codehash, Factory activation/fingerprint and dependency wiring;
- market Vault read snapshot and ERC-1155/USDC account snapshot;
- Full/Clone market creation with immutable review and exact fee+bond approval, available both as a
  standalone action and automatically before create when the current allowance is insufficient;
- allowance and Permit2 primary buy with bounded witness/deadline/slippage and automatic exact
  token approval when the selected path needs it;
- ERC-1155 escrow approval, fixed-price listing, allowance fill and cancel; create/fill buttons
  perform the required approval first while preserving the standalone approval controls;
- canonical settlement evidence upload adapter, creator resolve/void and timeout void;
- winner, early-bird, principal refund and timeout-bonus claims;
- local receipt/activity log with allowlisted Arbiscan links.

AA/Paymaster is deliberately read-only. Governance/emergency writes and arbitrary ABI/calldata are
not exposed. Metadata and `resolutionSourceURI` are displayed as escaped text only and are never
fetched or rendered.

## Three-wallet acceptance walkthrough

Use three disposable browser accounts with no valuable assets:

1. `A / Creator`: create a Full market, capture MarketCreated, later resolve or creator-void.
2. `B / Trader`: allowance buy outcome 0, create and partially sell a listing; the primary buttons
   request any missing bounded authorization before the requested action.
3. `C / Counterparty`: Permit2 buy outcome 1, fill the listing, then execute the applicable claim or
   refund after terminal state.

Every role switch requires selecting/reconnecting the account. Use the activity log and explorer
receipt, not a toast, as transaction proof.

## Visual acceptance source

Generated concepts and browser screenshots may be kept under these ignored local-only paths during
visual QA:

- `docs/assets/web-demo/overview-desktop.png`
- `docs/assets/web-demo/market-desktop.png`
- `docs/assets/web-demo/mobile.png`

They are intentionally excluded from the security-scanned source delivery; the application never
depends on them. The durable fidelity ledger is `reports/web-demo/QA.md`: white/navy/blue/amber/green palette; persistent desktop sidebar; sticky top trust
status; four compact overview cards; right-hand address inspector; event log; desktop market buy card
with Allowance/Permit2 tabs; mobile two-column status cards and bottom navigation. The concepts are
never used as runtime page backgrounds.

## Verification

```sh
npm run check:offchain
npm run demo:test
npm run demo:build
```

The authoritative deployment directory currently says `BLOCKED_NOT_DEPLOYED`; therefore the default
Demo truthfully starts in `LOCKED`. Runtime verification requires an authorized Arbitrum Sepolia
deployment and a real final manifest at `/deployment/final.json`.
