# Tesser API Demo

## Project Purpose

Dual-purpose repository:
1. **E2E test suite** for the Tesser API (sandbox environment)
2. **Customer integration reference** — shareable demo for potential customers

## Tech Stack

- **Bun** runtime — for executing code and managing packages (`bun run`, `bun install`, `bunx`). Not used as the test runner.
- `Bun.serve()` for HTTP servers — not Express
- **Vitest** for testing — not `bun:test`, Jest, or Mocha. Run via `bunx vitest` (or `bun run test`).
- Bun auto-loads `.env` — no dotenv needed
- No npm, pnpm, Webpack

## Environment Setup

Required `.env` variables:

```
TESSER_CLIENT_ID=<your client ID>
TESSER_CLIENT_SECRET=<your client secret>
```

| Constant | Value |
|----------|-------|
| Base URL (sandbox) | `https://sandbox.tesserx.co` |
| Base URL (production) | `https://api.tesser.xyz` |
| Auth URL | `https://auth.tesser.xyz/oauth/token` |

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

Usage: `Authorization: Bearer <access_token>`

## API Endpoints

All paths relative to base URL.

### Accounts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/accounts` | List accounts (filter by type, tenant, counterparty) |
| POST | `/v1/accounts/banks` | Create fiat bank account |
| POST | `/v1/accounts/wallets` | Create stablecoin wallet |
| POST | `/v1/accounts/ledgers` | Create ledger account (CIRCLE_MINT or KRAKEN) |
| GET | `/v1/accounts/{id}` | Get account |
| PATCH | `/v1/accounts/{id}` | Update account |

### Entities

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/entities/counterparties` | List counterparties |
| POST | `/v1/entities/counterparties` | Create counterparty (individual or business) |
| GET | `/v1/entities/counterparties/{id}` | Get counterparty |
| GET | `/v1/entities/tenants` | List tenants |
| POST | `/v1/entities/tenants` | Create tenant |
| GET | `/v1/entities/tenants/{id}` | Get tenant |

### Payments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/payments` | List payments (date filtering, pagination) |
| POST | `/v1/payments` | Create payment |
| GET | `/v1/payments/{paymentId}` | Get payment |
| PATCH | `/v1/payments/{paymentId}` | Update payment account assignments |
| POST | `/v1/payments/{paymentId}/review` | Submit risk review decision (`{ is_approved: boolean }`) |

### Treasury

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/treasury/deposits` | Create deposit |
| GET | `/v1/treasury/deposits/{id}` | Get deposit |
| POST | `/v1/treasury/withdrawals` | Create withdrawal |
| GET | `/v1/treasury/withdrawals/{id}` | Get withdrawal |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/currencies` | List available currencies |
| GET | `/v1/networks` | List available networks |
| POST | `/v1/keys` | Create API key |
| GET | `/v1/keys` | List API keys |
| GET | `/v1/keys/{id}` | Get API key |
| DELETE | `/v1/keys/{id}` | Delete API key |
| GET | `/v1/health` | Health check (no auth required) |

## Key Data Models & Enums

### Account Types
`fiat_bank` · `stablecoin_ethereum` · `stablecoin_solana` · `stablecoin_stellar` · `ledger`

### Ledger Providers
`CIRCLE_MINT` · `KRAKEN`

### Account Management
`managed` (provisioned by Tesser) · `unmanaged` (provisioned by third party)

### Counterparty Classification
`individual` · `business`

### Payment Direction
`inbound` · `outbound` · `internal`

### Risk Status
`unchecked` → `awaiting_decision` → `auto_approved` | `manually_approved` | `auto_rejected` | `manually_rejected`

### Balance Status
`unreserved` → `awaiting_funds` → `reserved`

### Step Type
`transfer` · `swap`

### Step Status
`created` → `signature_requested` → `signed` → `submitted` → `confirmed` → `finalized` → `completed` | `failed`
- `signature_requested` / `signed` only fire for self-custodial steps that need a local signature
- `finalized` = block finality (terminal for crypto-only steps)
- `completed` = funds delivered (terminal when there's a fiat-conversion leg)

### Provider Key
`alfred` · `circle_mint`

### Supported Networks
`ETHEREUM` · `POLYGON` · `STELLAR` · `SOLANA`

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
`created` → `signature_requested` → `signed` → `submitted` → `confirmed` → `finalized`/`completed` (or `failed`)
- `signature_requested` / `signed` only fire for self-custodial steps that need a local signature
- `finalized` = block finality (crypto-only steps stop here; `finalized_at` is set, `completed_at` stays null)
- `completed` = funds delivered (fires when there's a fiat-conversion leg; `completed_at` is set)
- When polling, treat either `finalized_at` or `completed_at` being non-null as terminal success

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
| `payment.*` | `quote_created`, `steps_created`, `balance_updated`, `risk_updated` |
| `step.*` | `signature_requested`, `signed`, `submitted`, `confirmed`, `finalized`, `completed`, `failed` |
| `deposit.*` | `created`, `submitted`, `confirmed` |
| `withdrawal.*` | `created`, `submitted`, `confirmed` |

## Sensitive Data

- Bank account numbers are encrypted — never returned unless `?include_secure=true`
- Secure fields (addresses, DOB, national IDs, legal entity identifiers) are masked by default

## Error Codes

### Payment-Specific

| Code | Message |
|------|---------|
| `payments-0001` | from_network must equal to_network |
| `payments-0002` | Invalid from_amount or to_amount |
| `payments-0003` | Invalid currency — use `/v1/currencies` |
| `payments-0004` | X_account_id is not a valid account ID |
| `payments-0005` | X_account_id is not a valid counterparty ID |
| `payments-0006` | source_account_id is not a valid source account ID |
| `payments-0007` | Signature is malformed or signed with incorrect key |
| `payments-0008` | Signed transaction does not match details |
| `payments-0009` | Legal Entity Identifier required for business originators of fiat payouts |

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