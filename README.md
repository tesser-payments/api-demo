# Tesser API Demo

Integration reference for the [Tesser](https://tesser.xyz) stablecoin payments API. Run this demo against the sandbox to see a complete payment flow end-to-end: a USD wire is minted into USDC through Circle Mint, and the USDC is paid out to a wallet on Stellar (default) or an EVM testnet.

## What this demo does

1. **Authenticate**: obtain an OAuth2 access token via client credentials.
2. **Connect Circle and check it** (steps 1.5 and 1.6): store the Circle Mint API key in the organization vault, then check that Circle is connected and that the Circle account has a linked wire bank.
3. **Display current state** (step 2): list currencies, networks, counterparties, accounts, tenants and payments, and find or create the workspace's funding bank account.
4. **Create entities** (step 3): a customer counterparty with a Circle Mint ledger account, and a beneficiary counterparty with an unmanaged wallet. A fresh ledger is created for every run.
5. **Wait for ledger compliance** (step 3b): Circle must accept the ledger before it can take deposits.
6. **Create a deposit** (steps 4 and 4b): USD from the funding bank into the ledger as USDC, then wait for the platform to plan it.
7. **Simulate the wire** (steps 5 and 5b): Tesser's sandbox simulate endpoint sends a mock wire through Circle. The run waits for the deposit to complete and checks that the ledger holds exactly the deposited amount.
8. **Create a payment** (step 6): send USDC from the ledger to the beneficiary wallet.
9. **Wait for the payment** (step 7): approve a risk review if one is requested, and wait until every step is `completed`.

The demo supports two variants: **org-level** (variant A, no tenant) and **tenant-level** (variant B), controlled with `ENABLE_VARIANTS`.

A run takes about 2 minutes per variant on Stellar. It exits with code 1 on the first failure and prints the request, the response and the error codes.

## Prerequisites

- **Tesser sandbox API credentials** (`TESSER_CLIENT_ID` and `TESSER_CLIENT_SECRET`).
- **A Circle Mint sandbox account** with an API key (`CIRCLE_API_KEY`) and **a linked wire bank** in status `complete`.
  - The platform needs it to set up the Circle deposit instructions. Without one, the deposit is never planned and the API gives no reason.
  - The wire bank can't be created through the Tesser API. Create it in Circle sandbox with `POST /v1/businessAccount/banks/wires` (see Circle's docs). Step 1.6 checks for it.

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
| `CIRCLE_API_KEY` | Yes, unless Circle is already connected | Circle Mint sandbox API key. Stored in the Tesser vault and used for the wire-bank check |
| `TESSER_BASE_URL` | No | API base URL (default: `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | No | OAuth2 token endpoint URL (default: the sandbox token endpoint) |
| `PAYMENT_NETWORK` | No | Payout network: `STELLAR` (default) or an EVM testnet such as `ETHEREUM_SEPOLIA`. Solana isn't supported here |
| `BENEFICIARY_WALLET_ADDRESS` | No | Payout address. It must match `PAYMENT_NETWORK`. Defaults to a known-good address for the network (see [Payout networks](#payout-networks)) |
| `ENABLE_VARIANTS` | No | `A`, `B`, or `BOTH` (default: `BOTH`) |
| `DEBUG_MODE` | No | Set to `true` to log all request and response payloads. They include secrets such as the Circle key and the access token, so don't share the output |
| `TESSER_FROM_ACCOUNT_ID` | No | Source account for the helper scripts |
| `TESSER_TO_ACCOUNT_ID` | No | Destination account for `tesser-payment-test.ts` |
| `TESSER_REBALANCE_ID` | No | Rebalance to fetch with `get-rebalance.ts` |
| `TESSER_MCP_URL` | No | MCP server URL for `mcp-networks.ts` (default: the sandbox URL) |
| `CIRCLE_FROM_WALLET_ID` | No | Circle wallet ID, the source for `circle-payment-test.ts` |
| `CIRCLE_TO_WALLET_ID` | No | Circle recipient ID, the destination for `circle-payment-test.ts` |

## Payout networks

The payout runs on Stellar by default. To pay out on an EVM testnet, set `PAYMENT_NETWORK` and an EVM address, or leave the address empty to use the default:

```bash
PAYMENT_NETWORK=ETHEREUM_SEPOLIA \
BENEFICIARY_WALLET_ADDRESS=0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f \
bun run index.ts
```

The run stops before any API call if the address doesn't match the network.

| Network | Default address | Notes |
|---------|-----------------|-------|
| `STELLAR` | `GCE5TKW3KAJJB3DPKXFWRIAKJEVOW6BDFGO6R4NRWS2JSZWRYNB2NKQG` | A Stellar address must have a USDC trustline. The payout completes in about 20 seconds |
| `ETHEREUM_SEPOLIA` | `0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f` | The payout completes in about 2.5 minutes |

Other EVM testnets (`BASE_SEPOLIA`, `POLYGON_AMOY`) use the same wallet type but haven't been tested with this demo.

On EVM networks, these sandbox addresses always get the same risk decision, so you can exercise each path:

| Address | Risk status | What the run does |
|---------|-------------|-------------------|
| `0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f` | `automatically_approved` | Pays out |
| `0x0a5b2bf3ccfb44c1d22f07eed9553ecba752d4ad` | `awaiting_decision` | Approves the review, then pays out |
| `0xac4cc4b68ea24bbfaac8fd127b67ed445accce22` | `automatically_rejected` | Fails |

## Scripts

| Script | Description |
|--------|-------------|
| `bun run index.ts` | Full E2E flow |
| `bun run scripts/get-accounts.ts` | List all accounts with pagination debug output |
| `bun run scripts/get-account.ts` | Get the account `TESSER_FROM_ACCOUNT_ID` |
| `bun run scripts/get-currencies-networks.ts` | List currencies and networks, with request and response details |
| `bun run scripts/get-rebalance.ts` | Get the rebalance `TESSER_REBALANCE_ID` |
| `bun run scripts/create-circle-mint-key.ts` | Store `CIRCLE_API_KEY` in the organization vault |
| `bun run scripts/tesser-payment-test.ts` | Pay 1–2 USDC between two existing accounts on `PAYMENT_NETWORK` |
| `bun run scripts/new-beneficiary-payment.ts` | Create a beneficiary with the wallet address you enter, and pay it from `TESSER_FROM_ACCOUNT_ID`. Asks before approving a risk review |
| `bun run scripts/retry-payment.ts` | Create a payment from a request body (JS object literal) read from stdin, and wait for it |
| `bun run scripts/circle-payment-test.ts` | Direct Circle sandbox payout test |
| `bun run scripts/mcp-networks.ts` | List networks through the Tesser MCP server |

## How it works

**Payment statuses.** A payment is done when every step is `completed`. Steps move through `created`, `submitted` and `confirmed`, and end in `completed` or `failed`. The risk status starts at `unchecked` and becomes `automatically_approved`, `awaiting_decision` (then `manually_approved` or `manually_rejected`), or `automatically_rejected`. The E2E approves a payment held for review, and fails on a rejection or a failed step.

**Async steps.** Several steps finish in the background, so the demo waits for each one with its own time limit and says what it was waiting for if the limit is reached:

| Wait | Limit | Typical |
|------|-------|---------|
| Ledger compliance | 35 min | About 10 s. The platform rechecks every 30 min after its first few checks |
| Deposit planning | 2 min | A few seconds |
| Deposit settlement | 10 min | Under a minute |
| Payment | 10 min | 20 s on Stellar, 2.5 min on Sepolia |

**Retries.** Only transient errors are retried: network errors, 5xx, 429, and `idempotency-0001` (the same request is still being processed). Any other 4xx fails at once. Deposit, simulate and payment requests carry an `Idempotency-Key`, so a retry can't create a second deposit, wire or payment. A payment to a new wallet is also retried on `payments-3017` until Circle activates the recipient, which took about 40 s in testing.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Step 1.6: "Circle isn't connected to this workspace" | No Circle key stored for the workspace | Set `CIRCLE_API_KEY` |
| Step 1.6: "has no linked wire bank" | The Circle account has no wire bank | Link one in Circle sandbox (see [Prerequisites](#prerequisites)) |
| Step 4b times out | The deposit was never planned, usually because of the wire bank | Check the Circle wire bank status |
| Step 5b times out | Circle never confirmed the mock wire | Check the Circle webhook subscription for this environment |
| "BENEFICIARY_WALLET_ADDRESS isn't a Stellar address" (or "an EVM") | The address doesn't match `PAYMENT_NETWORK` | Change one of them, or clear the address |

## Development

```bash
bun test            # unit tests for the retry and polling helpers
bunx tsc --noEmit   # typecheck
```

---

## CI / E2E testing

This repo also serves as an automated E2E test suite. The workflow (`.github/workflows/e2e.yml`) typechecks, runs the unit tests, then runs `index.ts` against sandbox.

**Triggers:**

- `repository_dispatch` (`platform-deploy`): fired by `tesser-payments/platform` after its backend deploy from `main` succeeds.
- `workflow_dispatch`: manual trigger from the GitHub Actions tab.

The E2E runs against sandbox, which is promoted from `main` separately. A run fired by a platform merge tests the sandbox release that is live at the time, not necessarily the code that was just merged.

### Secrets and variables to configure in this repo (`api-demo`)

| Secret | Description |
|--------|-------------|
| `TESSER_CLIENT_ID` | Tesser sandbox API client ID |
| `TESSER_CLIENT_SECRET` | Tesser sandbox API client secret |
| `TESSER_BASE_URL` | Tesser sandbox base URL (e.g. `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | Auth token endpoint URL |
| `CIRCLE_API_KEY` | Circle Mint sandbox API key |
| `BENEFICIARY_WALLET_ADDRESS` | Optional. Must match `PAYMENT_NETWORK` |
| `ENABLE_VARIANTS` | Optional. `A`, `B`, or `BOTH` |
| `DEBUG_MODE` | Optional. Logs every request and response |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for failure notifications |

| Variable | Description |
|----------|-------------|
| `PAYMENT_NETWORK` | Optional. Payout network (default `STELLAR`) |

To switch CI to an EVM network, set the `PAYMENT_NETWORK` variable and either set `BENEFICIARY_WALLET_ADDRESS` to an EVM address or delete that secret.

### Platform repo setup (`tesser-payments/platform`)

1. Create a **fine-grained GitHub PAT** scoped to `tesser-payments/api-demo` with **Contents: Read and write** permission.
2. Add it as the `API_DEMO_PAT` secret in `tesser-payments/platform`.
3. `.github/workflows/trigger-api-demo.yml` in the platform repo dispatches the event:

   ```yaml
   name: Trigger API Demo E2E

   on:
     workflow_run:
       workflows: ["Deploy Backend Services to AWS"]
       types: [completed]
       branches: [main]

   jobs:
     trigger:
       runs-on: ubuntu-latest
       if: ${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main' }}
       steps:
         - name: Dispatch to api-demo
           uses: peter-evans/repository-dispatch@v3
           with:
             token: ${{ secrets.API_DEMO_PAT }}
             repository: tesser-payments/api-demo
             event-type: platform-deploy
   ```
