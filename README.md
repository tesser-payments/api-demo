# Tesser API Demo

Integration reference for the [Tesser](https://tesser.xyz) stablecoin payments API. Run this demo against the sandbox to see a complete payment flow end-to-end — from authentication through deposit funding to an outbound stablecoin payment on Stellar.

## What this demo does

1. **Authenticate** — obtain an OAuth2 access token via client credentials
2. **Display current state** — list currencies, networks, counterparties, accounts, tenants, and payments
3. **Create entities** — set up a customer counterparty, beneficiary counterparty, Circle Mint ledger account, and Stellar wallet
4. **Create deposit** — initiate a USD → USDC deposit into the ledger account
5. **Simulate funding** — use Circle's sandbox mock wire endpoint to fund the deposit
6. **Create payment** — send USDC from the ledger to the beneficiary wallet on Stellar
7. **Poll payment** — wait for the first payment step to finalize on-chain

The demo supports two variants: **org-level** (no tenant) and **tenant-level**, controlled via the `ENABLE_VARIANTS` env var.

## Quick start

1. Install dependencies:

   ```bash
   bun install
   ```

2. Copy the environment template and fill in your credentials:

   ```bash
   cp .env.example .env.local
   ```

3. Run the demo:

   ```bash
   bun run index.ts
   ```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TESSER_CLIENT_ID` | Yes | Tesser sandbox API client ID |
| `TESSER_CLIENT_SECRET` | Yes | Tesser sandbox API client secret |
| `TESSER_BASE_URL` | No | API base URL (default: `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | No | OAuth2 token endpoint URL |
| `FALLBACK_FUNDING_BANK_ACCOUNT_ID` | No | Bank account ID to use if none is returned by the API |
| `CIRCLE_API_KEY` | No | Circle sandbox API key (required for deposit simulation) |
| `BENEFICIARY_WALLET_ADDRESS` | No | Stellar wallet address for the beneficiary (random if unset) |
| `DEBUG_MODE` | No | Set to `1` to log all request/response payloads |
| `ENABLE_VARIANTS` | No | `A`, `B`, or `BOTH` (default: `BOTH`) |

## Scripts

| Script | Description |
|--------|-------------|
| `bun run index.ts` | Full 7-step demo flow |
| `bun run retry-payment.ts` | Retry a failed payment — paste the request body (JS object literal) via stdin |

## How it works

The demo authenticates via OAuth2 `client_credentials`, then creates the entities needed for a payment: a **customer counterparty** (business) with a **Circle Mint ledger account**, and a **beneficiary counterparty** with an **unmanaged Stellar wallet**.

A deposit (USD → USDC) is created and funded through Circle's sandbox mock wire. Once funded, a payment is submitted from the ledger to the wallet. The script polls the payment until the first step reaches `finalized` status (block finality on Stellar).

Retries are built in for deposit creation, instruction fetching, and payment polling (60 attempts at 10-second intervals).

---

## CI / E2E testing

This repo also serves as an automated E2E test suite. The workflow (`.github/workflows/e2e.yml`) runs automatically when `tesser-payments/platform` merges to main, and can be triggered manually from the Actions tab.

**Triggers:**

- `repository_dispatch` — fired by the platform repo after a deploy to main
- `workflow_dispatch` — manual trigger from the GitHub Actions tab

### Secrets to configure in this repo (`api-demo`)

| Secret | Description |
|--------|-------------|
| `TESSER_CLIENT_ID` | Tesser sandbox API client ID |
| `TESSER_CLIENT_SECRET` | Tesser sandbox API client secret |
| `TESSER_BASE_URL` | Tesser sandbox base URL (e.g. `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | Auth token endpoint URL |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for failure notifications |

### Platform repo setup (`tesser-payments/platform`)

1. Create a **fine-grained GitHub PAT** scoped to `tesser-payments/api-demo` with **Contents: Read and write** permission
2. Add it as the `API_DEMO_PAT` secret in `tesser-payments/platform`
3. Create `.github/workflows/trigger-e2e.yml` in the platform repo:

   ```yaml
   name: Trigger API Demo E2E

   on:
     push:
       branches: [main]

   jobs:
     trigger:
       runs-on: ubuntu-latest
       steps:
         - name: Dispatch to api-demo
           uses: peter-evans/repository-dispatch@v3
           with:
             token: ${{ secrets.API_DEMO_PAT }}
             repository: tesser-payments/api-demo
             event-type: platform-deploy
   ```
