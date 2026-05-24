# Tesser API Demo

Integration reference + E2E test suite for the [Tesser](https://tesser.xyz) stablecoin payments API.

The repository serves two audiences from one codebase:

1. **Customer reference** — `examples/<flow>.ts` files each implement one how-to from [docs.tesser.xyz](https://docs.tesser.xyz). Each file is self-contained: no test imports, runnable directly via `bun run examples/<flow>.ts`.
2. **Automated test suite** — `tests/flows.test.ts` wraps the examples with webhook-event assertions and DEA overlay checks, asserting on the platform behavior every flow declares.

## Flows currently covered

| Example | Variants tested |
|---------|-----------------|
| `examples/deposit-funds-via-a-liquidity-provider.ts` | workspace · counterparty · tenant · counterparty-in-tenant |
| `examples/create-a-stablecoin-payout.ts` | Stellar (EVM testnet payouts skipped until platform accepts testnet identifiers) |
| `examples/create-a-tenant.ts` | (called by other flows when a tenant is needed) |

Tests run in **random order** (`sequence.shuffle.tests: true`) with a logged `VITEST_SEED` so any failing run can be reproduced with `VITEST_SEED=<seed> bun run test`. An in-process shared-state pool lets one test's resources be reused by a later test in the same run (e.g. payout reuses the deposit test's funded ledger).

## Quick start

```bash
bun install
cp .env.example .env
# Fill in TESSER_*, WEBHOOK_SITE_TOKEN, CIRCLE_API_KEY, BENEFICIARY_WALLET_ADDRESS_STELLAR, etc.
bun run test
```

Run a single example standalone:

```bash
bun run examples/deposit-funds-via-a-liquidity-provider.ts
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TESSER_CLIENT_ID` | Yes | Sandbox API client ID |
| `TESSER_CLIENT_SECRET` | Yes | Sandbox API client secret |
| `TESSER_BASE_URL` | No | API base URL (default: `https://sandbox.tesserx.co`) |
| `TESSER_AUTH_URL` | No | OAuth2 token endpoint |
| `WEBHOOK_SITE_TOKEN` | Yes (tests) | webhook.site token configured as the sandbox app's webhook URL |
| `WEBHOOK_SITE_API_KEY` | Yes if paid token | webhook.site API key (only needed for paid `require_auth=true` tokens) |
| `CIRCLE_API_KEY` | Yes (Circle Mint) | Circle Mint sandbox key — stored in Tesser vault on first run |
| `BENEFICIARY_WALLET_ADDRESS_STELLAR` | One per class | Stellar account with a USDC trustline |
| `BENEFICIARY_WALLET_ADDRESS_EVM` | One per class | 0x… Ethereum/EVM address (covers Polygon Amoy, Base Sepolia, etc.) |
| `BENEFICIARY_WALLET_ADDRESS` | No | Legacy Stellar fallback (used when `_STELLAR` is unset) |
| `DEBUG_MODE` | No | Set to `true` to log all request/response payloads |
| `VITEST_SEED` | No | Pin the random test order to a known seed |

Variants whose env vars are unset (e.g., no `BENEFICIARY_WALLET_ADDRESS_EVM`) skip cleanly with a clear message rather than fail.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run test` | Run the full test suite (unit + flow tests). Prints the planned matrix at the top, results matrix + resource lifecycle at the bottom. |
| `bun run test:watch` | Vitest watch mode |
| `bun run examples/<flow>.ts` | Run one example standalone against sandbox |

## How tests are organized

- `tests/flows.test.ts` — all integration flow tests in one file so vitest can interleave variants across flows (the `sequence.shuffle` only mixes tests within a file)
- `tests/unit/` — unit tests for the webhook subscription primitive
- `tests/helpers/expected-events.ts` — hand-transcribed expected webhook event sequences per flow, sourced from docs.tesser.xyz with `Last verified:` dates
- `tests/setup/seed-and-summary.ts` — global setup; truncates the action log, prints the resource lifecycle on teardown
- `tests/setup/test-plan-reporter.ts` — custom reporter that renders a per-test column-table (doc × provider × currency × network)
- `tests/flow-test.ts` — small helper that registers each flow test with its structured variant metadata
- `tests/shared-state.ts` — in-process resource pool. Resources from previous runs are NOT carried over; each `bun run test` starts empty
- `scripts/run-tests-with-plan.ts` — entry point that runs `vitest list` first to print the planned matrix, then `vitest run`

## CI / E2E testing

`.github/workflows/e2e.yml` runs the suite when the platform repo deploys.

**Triggers:**

- `repository_dispatch` event type `platform-deploy` — fired by `tesser-payments/platform` after a deploy to main
- `workflow_dispatch` — manual trigger from the GitHub Actions tab

### Secrets to configure in this repo

| Secret | Description |
|--------|-------------|
| `TESSER_CLIENT_ID`, `TESSER_CLIENT_SECRET` | Sandbox API credentials |
| `TESSER_BASE_URL`, `TESSER_AUTH_URL` | Sandbox URLs |
| `WEBHOOK_SITE_TOKEN`, `WEBHOOK_SITE_API_KEY` | webhook.site token + API key (the sandbox app must be configured to POST to this URL) |
| `BENEFICIARY_WALLET_ADDRESS_STELLAR` | Stellar wallet with USDC trustline |
| `BENEFICIARY_WALLET_ADDRESS_EVM` | EVM 0x… address (or omit to skip EVM payouts) |
| `BENEFICIARY_WALLET_ADDRESS` | Legacy Stellar fallback |
| `CIRCLE_API_KEY` | Circle Mint sandbox key |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for failure notifications |
| `DEBUG_MODE` | Optional |

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
