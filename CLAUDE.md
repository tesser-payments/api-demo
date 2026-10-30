# Tesser API Demo

## Project Purpose

Dual-purpose repository:
1. **E2E test suite** for the Tesser API (sandbox environment)
2. **Customer integration reference** — shareable demo for potential customers

## Tech Stack

- **Bun** runtime — use `bun` for everything (`bun test`, `bun run`, `bun install`, `bunx`)
- `Bun.serve()` for HTTP servers — not Express
- `bun:test` for testing — not Jest/Vitest
- Bun auto-loads `.env` and `.env.local` for `bun run` — no dotenv needed. `bun test` does **not** load `.env.local`, so unit tests mock `fetch` and need no credentials
- No Node.js, npm, pnpm, Vite, or Webpack

## Environment Setup

Copy `.env.example` to `.env.local`. Required:

```
TESSER_CLIENT_ID=<your client ID>
TESSER_CLIENT_SECRET=<your client secret>
CIRCLE_API_KEY=<Circle Mint sandbox key>   # unless Circle is already connected
```

Optional: `PAYMENT_NETWORK` (default `STELLAR`), `BENEFICIARY_WALLET_ADDRESS` (must match the network), `ENABLE_VARIANTS` (`A` | `B` | `BOTH`), `DEBUG_MODE`. The README has the full table.

| Constant | Value |
|----------|-------|
| Base URL (sandbox) | `https://sandbox.tesserx.co` |
| Base URL (production) | `https://api.tesser.xyz` |
| Auth URL | `https://auth.tesser.xyz/oauth/token` |
| Auth URL (sandbox, the code's default) | `https://dev-awqy75wdabpsnsvu.us.auth0.com/oauth/token` |

## How This Repo Works

Read this before changing code. `README.md` explains the flow for humans; this section is for implementing.

### The flow (`index.ts`)

One function per step, run per variant (A = org-level, B = under a new tenant):

1. Authenticate → 1.5 store the Circle key → 1.6 preflight (Circle master ledger exists, Circle wire bank is `complete`)
2. List current state; find or create the workspace `fiat_bank`
3. Create customer counterparty + `CIRCLE_MINT` ledger, beneficiary counterparty + unmanaged wallet → 3b wait for ledger compliance
4. Create deposit (`fiat_bank` USD → ledger USDC) → 4b wait until it has steps
5. Simulate the wire (sandbox only) → 5b wait until every deposit step is `completed`, then check the ledger holds exactly the deposit
6. Create payment ledger → wallet on `PAYMENT_NETWORK` (retries `payments-3017`)
7. `waitForPayment`: approve a risk review once, done when every step is `completed`

`payoutConfig()` validates `PAYMENT_NETWORK` and the address before any API call.

### Repository map

| Path | What it holds |
|------|---------------|
| `index.ts` | The E2E flow above |
| `src/client.ts` | `authenticate`, `get`, `getAll` (follows pagination), `post` (optional `Idempotency-Key`), `patch`. Non-2xx throws `ApiError` (`status`, `errorCodes`, `hasCode(...)`); a failed `fetch` throws `NetworkError` |
| `src/retry.ts` | `isTransient`, `retryOpts`, `postWithRetry`, `poll` (defaults: 60 attempts, 10 s apart) |
| `src/steps.ts` | `stepSummary`, `assertNoFailedStep`, `waitForPayment` |
| `src/types.ts` | snake_case wire types for accounts, deposits, payments, steps |
| `src/*.test.ts` | `bun:test` unit tests; `fetch` is mocked |
| `scripts/` | Helper scripts (listed in the README); they reuse `src/` |
| `.github/workflows/e2e.yml` | CI: typecheck, unit tests, then `index.ts` on sandbox |
| `tasks/` | Planning notes (`todo.md`, `lessons.md`); not part of the shipped code |

### Rules for new code

- **Wire types:** read responses through `src/types.ts` (snake_case, from the OpenAPI schema). `@tesser-payments/types` is camelCase and doesn't match what the API returns. Add fields to `src/types.ts` when you start reading them.
- **Creates that must not happen twice** (deposits, simulate, payments, reviews): use `postWithRetry(label, path, body, { retryOn?, attempts? })`. It sets an `Idempotency-Key`, keeps it across transient retries, and renews it after a `retryOn` code, because the platform replays a cached 4xx for the same key.
- **Retry only what can recover:** network errors, 5xx, 429 and `idempotency-0001` (see `isTransient`), plus a named not-ready code via `retryOn`. Never add blanket retries: any other 4xx must fail on the first attempt.
- **Waiting for async state:** use `poll(label, check, { timeoutMs, intervalMs?, timeoutHint })`. `check` returns `undefined` to keep waiting, a value to finish, or throws to stop. Give every wait an explicit limit and a `timeoutHint` naming the likely cause.
- **Payments:** wait with `waitForPayment(id, { decide?, reason? })`. Success is every step `completed`; a `failed` step or a `*_rejected` risk status throws.
- **Deposits:** give each deposit its own random amount; Circle matches a simulated wire to its deposit by exact amount. Tag deposits and payments with `organization_reference_id` (`e2e-<RUN_ID>-<variant>-…`).
- **Fail before calling the API** on bad configuration (see `payoutConfig`).
- **Secrets:** never print secret values. `DEBUG_MODE` logs request bodies (including the Circle key) and the auth response. Step 1.5 redacts the key from its error. CI logs of this public repo are public.
- **Public repo:** keep internal ids, organization names and private URLs out of commits and code.

### Environment prerequisites (per Tesser organization)

The flow only passes when the organization's Circle setup is complete. None of this can be done through the Tesser API:

1. **Circle key stored** (`POST /v1/organizations/secrets`, step 1.5). Storing it also creates the Circle master ledger and a Circle webhook subscription.
2. **A Circle wire bank** linked and `complete` (Circle `GET /v1/businessAccount/banks/wires`). Without it the deposit is never planned (step 4b times out).
3. **A confirmed Circle webhook subscription** to `https://sandbox.tesserx.co/v1/webhooks/circle/<organizationId>` (Circle `GET /v1/notifications/subscriptions`). Without it Circle settles the wire but Tesser never hears, and step 5b times out. This broke CI on 2026-10-30.
   - The organization id isn't in any API response. Get it from the sandbox DB (`workspaces.organization_id` for the workspace), or run the platform CLI `circle-subscribe-webhook --org-id <workspace id>`, which looks it up.
   - Several organizations can share one Circle key; each needs its own subscription in that Circle account.

### Platform behaviour to design around

- Only Circle's `deposits` webhook completes a Circle deposit. Nothing polls Circle, and a missed webhook is never recovered.
- If the platform can't create the virtual account (no wire bank), the deposit stays at `steps: []` with no error.
- The simulate response shows the deposit as it was **before** the simulation.
- Ledger compliance usually passes in about 10 s; after its first few checks the platform only rechecks every 30 min.
- The platform caches deterministic 4xx responses per `Idempotency-Key`; 5xx, 401, 403, 429 and validation errors aren't cached.

### Verifying a change

1. `bunx tsc --noEmit` and `bun test`
2. `ENABLE_VARIANTS=BOTH bun run index.ts` on sandbox (about 2.5 min on Stellar)
3. If the payout path changed: `PAYMENT_NETWORK=ETHEREUM_SEPOLIA BENEFICIARY_WALLET_ADDRESS= ENABLE_VARIANTS=A bun run index.ts` (about 4 min), and the review and rejection paths with the EVM risk-test addresses
4. If retries changed: an invalid request must fail on its first attempt, in under a second

Each run creates new counterparties, ledgers and wallets in the sandbox workspace; that's expected.

### Extending

- **A new step:** add a `stepN_…` function in `index.ts`, call it from `runSteps4Through7` (or `main` for one-off setup), and build it from the helpers above.
- **A new payout network:** add its wallet type, default address and address format to `payoutConfig`, update `.env.example` and the README, and verify a live run before making it a default.
- **A new script:** put it in `scripts/`, import from `../src/`, and list it in the README.

## Tesser Platform Overview

Stablecoin payments and treasury management API.

**Resource hierarchy:** Organization → Workspace → Tenant → Counterparty → Account → Quote → Payment → Deposit/Withdrawal → Transfer

**Shield wallets** protect treasury from direct external exposure. Outbound: Treasury → Shield → External. Inbound: External → Shield → Treasury.

**Live networks:** Polygon (USDC, USDT). Coming soon: Ethereum, Stellar, Solana.

## Authentication

OAuth2 `client_credentials` grant. Tokens last 24 hours — no refresh tokens, just re-request.

```
POST https://auth.tesser.xyz/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=<TESSER_CLIENT_ID>
client_secret=<TESSER_CLIENT_SECRET>
audience=https://api.tesser.xyz
grant_type=client_credentials
```

Response: `{ access_token, token_type: "Bearer", expires_in: 86400 }`

The values above are production. On **sandbox**, `src/client.ts` posts to `https://dev-awqy75wdabpsnsvu.us.auth0.com/oauth/token` with `audience=https://sandbox.tesserx.co` (override with `TESSER_AUTH_URL`); tokens also last 86400 s.

Usage: `Authorization: Bearer <access_token>`

## API Endpoints

All paths relative to base URL. Every list endpoint is paginated with `page` and `limit`.

Source: the platform's pinned OpenAPI spec, `apps/backend/openapi.pin.json` (its CI keeps the spec in sync with the code). "Public" means not marked `x-internal`. Checked against platform `main` on 2026-10-30.

### Accounts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/accounts` | List accounts. Filters: `type`, `tenant_id`, `counterparty_id`, `entity_type`, `is_managed`, `compliance_accepted`, `search`, `include_secure` |
| POST | `/v1/accounts/banks` | Create fiat bank account |
| POST | `/v1/accounts/wallets` | Create stablecoin wallet (`type`: `stablecoin_ethereum` \| `stablecoin_solana` \| `stablecoin_stellar`; `is_managed`, `wallet_address`) |
| POST | `/v1/accounts/ledgers` | Create ledger account (`provider`: `CIRCLE_MINT` or `OPENFX`) |
| POST | `/v1/accounts/generic` | Create generic account (`generic_account_number`) |
| GET | `/v1/accounts/{id}` | Get account |
| PATCH | `/v1/accounts/{id}` | Rename account (`{ name }` only; a generic account's number can't change) |
| POST | `/v1/accounts/{id}/onchain-addresses` | Get or provision a ledger's on-chain deposit address (`{ network?, currency: "USDC" }`). Don't send funds to it directly |

### Entities

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/entities/counterparties` | List counterparties. Filters: `classification`, `search`, `include_secure` |
| POST | `/v1/entities/counterparties` | Create counterparty (individual or business) |
| GET | `/v1/entities/counterparties/{id}` | Get counterparty |
| GET | `/v1/entities/tenants` | List tenants. Filters: `search`, `include_secure` |
| POST | `/v1/entities/tenants` | Create tenant |
| GET | `/v1/entities/tenants/{id}` | Get tenant |

### Payments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/payments` | List payments. Filters: `start_date`, `end_date`, `direction` (`inbound` \| `outbound`) |
| POST | `/v1/payments` | Create payment (`{ organization_reference_id?, payment_info?, funding_account_id?, desired: { from, to } }`) |
| GET | `/v1/payments/{paymentId}` | Get payment |
| PATCH | `/v1/payments/{paymentId}` | Update the payment's accounts (`{ funding_account_id, desired, organization_reference_id?, payment_info? }`) |
| POST | `/v1/payments/{paymentId}/review` | Submit risk review decision (`{ is_approved: boolean, reason?: string }`) |
| POST | `/v1/payments/{paymentId}/steps/{stepId}/sign` | Sign a self-custodial step (`{ signature }`) |
| POST | `/v1/payments/simulate-inbound` | Sandbox only: simulate an inbound payment with a chosen `mocked_risk_status` |
| POST | `/v1/payments/simulate-travel-rule-inbound` | Sandbox only: simulate an inbound travel-rule exchange with a counterparty VASP |

### Treasury

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/treasury/deposits` | List deposits. Filters: `ids`, `to_account_id` |
| POST | `/v1/treasury/deposits` | Create deposit (`{ organization_reference_id?, desired: { from, to } }`) |
| GET | `/v1/treasury/deposits/{id}` | Get deposit |
| GET | `/v1/treasury/deposits/{id}/instructions` | Get the deposit's funding instructions |
| POST | `/v1/treasury/deposits/{id}/simulate` | Sandbox only: fund a planned deposit. Circle deposits send a mock wire and complete asynchronously |
| GET | `/v1/treasury/withdrawals` | List withdrawals |
| POST | `/v1/treasury/withdrawals` | Create withdrawal (`{ organization_reference_id?, desired }`) |
| GET | `/v1/treasury/withdrawals/{id}` | Get withdrawal |
| POST | `/v1/treasury/withdrawals/{id}/steps/{stepId}/sign` | Sign a withdrawal step (`{ signature }`) |
| GET | `/v1/treasury/rebalances` | List rebalances |
| POST | `/v1/treasury/rebalances` | Create rebalance between managed accounts (`{ organization_reference_id?, desired }`) |
| GET | `/v1/treasury/rebalances/{id}` | Get rebalance |
| POST | `/v1/treasury/rebalances/{id}/steps/{stepId}/sign` | Sign a rebalance step (`{ signature }`) |

### Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/currencies` | List available currencies |
| GET | `/v1/networks` | List available networks |

### Internal (exist, not in the public docs)

These are marked `x-internal`. Don't present them to customers as part of the public API.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/organizations/secrets` | Store a provider secret, e.g. the Circle key (step 1.5). Also registers the Circle webhook subscription |
| POST | `/v1/webhooks/circle/{organizationId}` | Where Circle sends notifications for one organization |
| POST, GET | `/v1/keys` | Create, list API keys |
| GET, DELETE | `/v1/keys/{id}` | Get, delete an API key |
| PUT | `/v1/keys/{id}/revoke` | Revoke an API key |
| POST, GET | `/v1/keys/{id}/certificates` | Register, list client certificates |
| DELETE | `/v1/keys/{id}/certificates/{certId}` | Revoke a client certificate |
| GET | `/v1/health` | Health check (no auth required) |

## Key Data Models & Enums

### Account Types
`fiat_bank` · `stablecoin_ethereum` · `stablecoin_solana` · `stablecoin_stellar` · `ledger` · `generic`

### Ledger Providers
Create accepts `CIRCLE_MINT` · `OPENFX`. Account responses can also show `KRAKEN` or `ZUBA`.

### Account Management
`managed` (provisioned by Tesser) · `unmanaged` (provisioned by third party)

### Counterparty Classification
`individual` · `business`

### Payment Direction
`inbound` · `outbound` · `internal`

### Risk Status
`unchecked` → `automatically_approved` | `automatically_rejected` | `awaiting_decision` → `manually_approved` | `manually_rejected`

### Balance Status
`unreserved` → `awaiting_funds` → `reserved`

### Step Type
`transfer` · `swap`

### Step Status
`created` → `signature_requested` → `signed` → `submitted` → `confirmed` → `completed` | `failed`
- `signature_requested` / `signed` only fire for self-custodial steps that need a local signature
- `completed` and `failed` are the only terminal statuses; there is no `finalized` status or `finalized_at` field

### Provider Key
`alfred` · `circle_mint`

### Supported Networks
`ETHEREUM` · `POLYGON` · `STELLAR` · `SOLANA`

**Sandbox:** `/v1/networks` lists `BASE_SEPOLIA` · `ETHEREUM_SEPOLIA` · `POLYGON_AMOY` · `STELLAR_TESTNET` · `TEMPO_MODERATO`, but payments take `STELLAR` (not `STELLAR_TESTNET`) and `ETHEREUM_SEPOLIA`; both are verified end-to-end. The E2E pays out on `PAYMENT_NETWORK` (default `STELLAR`).

Sandbox EVM risk-test addresses: `0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f` → `automatically_approved` · `0x0a5b2bf3ccfb44c1d22f07eed9553ecba752d4ad` → `awaiting_decision` · `0xac4cc4b68ea24bbfaac8fd127b67ed445accce22` → `automatically_rejected`

### Bank Code Types
`SWIFT` · `BIC` · `IBAN` · `ROUTING` · `SORT_CODE`

## Payment Workflow

### Planning Phase
1. Create payment — obtains quote with locked exchange rate
2. Risk screening — wallet screened on 152 factors across ownership, counterparty, behavioral, and indirect categories
3. Balance check — reserve funds or enqueue if insufficient

### Risk Auto-decisioning
- Low/Medium risk → auto-approved
- High risk → requires manual review via `POST /v1/payments/{id}/review`
- Severe risk → auto-rejected

### Execution Phase
1. Balance reserved
2. Signing authorization (if self-custodial)
3. Steps execute (may run in parallel):
   - **On-network transfer** — stablecoins on same network
   - **Cross-network bridge** — assets between networks
   - **Token swap** — convert between tokens
   - **Fiat conversion** — stablecoin to fiat off-ramp

### Step Status Progression
`created` → `signature_requested` → `signed` → `submitted` → `confirmed` → `completed` (or `failed`)
- `signature_requested` / `signed` only fire for self-custodial steps that need a local signature
- When polling, a payment succeeded when **every** step is `completed`. Fail on any `failed` step (its `status_reasons` is `[{ error_code, error_message }]`) or a `*_rejected` risk status
- `awaiting_decision` waits for `POST /v1/payments/{id}/review` until the payment expires

### Deposit Flow (Circle Mint)
USD wire from a `fiat_bank` account → Circle → USDC minted into a `CIRCLE_MINT` ledger. All of it is asynchronous:
1. **Ledger compliance**: a new ledger can't take deposits (`treasury-3103`) until Circle accepts it. Filter `GET /v1/accounts?type=ledger&compliance_accepted=true` to wait. Usually about 10 s; the platform rechecks every 30 min after its first few checks
2. **Planning**: `POST /v1/treasury/deposits` returns with `steps: []`; planning fills them in a few seconds later. Simulating before that fails with `treasury-3101`. If the Circle account has no linked wire bank, the deposit is never planned and the API gives no reason
3. **Simulate** (sandbox): `POST /v1/treasury/deposits/{id}/simulate` sends a Circle mock wire. Circle matches the wire to the deposit by exact amount, so concurrent deposits need distinct amounts
4. **Settlement**: Circle confirms by webhook; the deposit is done when every step is `completed` and the ledger shows the USDC

A ledger used as `funding_account_id` pays out through Circle. A payment to a new wallet fails with `payments-3017` until Circle activates the recipient (about 40 s); retry it with a fresh `Idempotency-Key`, because the platform replays a cached 4xx response for the same key

### Payment Expiration
All payments have `expires_at`. Expired payments require creating a new payment (risk/compliance checks must be re-initiated).

## Webhooks

**Envelope:**
```json
{
  "id": "string",
  "type": "scope.action",
  "created_at": "ISO 8601",
  "data": { "object": { ... } }
}
```

**Signature:** Ed25519 signature in `X-Tesser-Signature` header (Base64-encoded), computed over raw UTF-8 JSON body.

**Verification:**
```ts
import { createPublicKey, verify } from "node:crypto";
import { WEBHOOK_PUBLIC_KEY } from "@tesser-payments/types";

function verifyWebhook(rawBody: string, signature: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(WEBHOOK_PUBLIC_KEY, "base64"),
    type: "spki",
    format: "der",
  });
  return verify(null, Buffer.from(rawBody, "utf8"), key, Buffer.from(signature, "base64"));
}
```

### Event Types

| Scope | Events |
|-------|--------|
| `payment.*` | `created`, `quote_created`, `steps_created`, `balance_updated`, `risk_updated`, `updated` |
| `step.*` | `signature_requested`, `signed`, `submitted`, `confirmed`, `completed`, `failed`, `updated` |
| `deposit.*` | `quote_created`, `steps_created`, `updated` |
| `withdrawal.*` | `quote_created`, `steps_created`, `balance_updated`, `updated` |
| `rebalance.*` | `quote_created`, `balance_updated`, `updated`, `expired` |

## Sensitive Data

- Bank account numbers are encrypted — never returned unless `?include_secure=true`
- Secure fields (addresses, DOB, national IDs, legal entity identifiers) are masked by default

## Error Codes

Errors come back as `{ "errors": [{ "error_code", "error_message" }] }`. Codes are defined in the platform's `packages/types/src/errors/domains/*.errors.ts`; check there before relying on one.

A request that fails validation returns `<domain>-1001` (e.g. `payments-1001`), one entry per invalid field, with the field named in the message. The platform's global exception filter builds this code, so it can clash with a code of the same number in the errors file.

### Payment-Specific (common)

| Code | Message |
|------|---------|
| `payments-3000` | from_network must equal to_network |
| `payments-3001` | Invalid from_amount or to_amount |
| `payments-3004` / `payments-3005` | from_network / to_network is required for crypto-to-crypto payments |
| `payments-3007` / `payments-3008` | Invalid from_currency / to_currency |
| `payments-3009` / `payments-3010` / `payments-3011` | funding_account_id / to_account_id / from_account_id not found |
| `payments-3017` | to_account has not yet been risk approved by the custodian |
| `payments-3018` | from_account_id and to_account_id are both managed; use `/v1/treasury/rebalances` |
| `payments-3065` | Signature is invalid or could not be verified |
| `payments-3066` | Signed transaction does not match the payment details |
| `payments-3099` | funding_account_id must belong to a counterparty or tenant |

### Codes the E2E handles

| Code | Meaning | Handling |
|------|---------|----------|
| `treasury-3101` | The deposit has no provider step yet, e.g. simulated before planning | Wait for the deposit to have steps |
| `treasury-3103` | Circle compliance not yet accepted for the ledger | Wait for `compliance_accepted=true` |
| `payments-3017` | `to_account` not yet risk approved by the custodian (Circle recipient inactive) | Retry with a new `Idempotency-Key` |
| `idempotency-0001` | A request with this `Idempotency-Key` is still processing | Retry with the same key |
| `organizations-0009` | Circle key already configured | Continue |

### Standard HTTP
`400` Bad Request · `401` Unauthorized · `403` Forbidden · `404` Not Found · `429` Rate Limited · `500` Internal Server Error

## Documentation

- Docs (LLM-friendly): `https://docs.tesser.xyz/llms.txt`
- OpenAPI schema: `https://docs.tesser.xyz/api/v1/schema.json`
- Main docs: `https://docs.tesser.xyz/`

## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One tack per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.