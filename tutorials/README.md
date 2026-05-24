# Tutorials

Concrete, copy-pasteable walkthroughs of each Tesser how-to. Each file is a single specific variant — no optional inputs, no branching, no parameterization. Read top-to-bottom or run end-to-end.

## How tutorials relate to `examples/`

`examples/<flow>.ts` contains the *general* form of a flow: one function that handles every variant (with/without counterparty, with/without tenant, etc.). The tutorials here pick one specific variant and inline the relevant code so a customer can read the API call surface without having to ignore branching.

If the platform contract changes (e.g., a new required field), the assertions in `tests/tutorials.test.ts` will fail and surface the drift. Update both the tutorial and its parent example together.

## State sharing

Some tutorials need the output of earlier tutorials. Instead of asking customers to copy IDs between terminal commands, each tutorial reads and writes `tutorials/.state.json` (gitignored). Tutorial 01 is the chain's entry point — running it wipes the file clean, so re-running 01 always starts a fresh sequence.

Standalone customer workflow:

```sh
bun run tutorials/01-create-a-counterparty.ts
bun run tutorials/02-create-a-ledger.ts
# (later tutorials...)
```

The test suite (`tests/tutorials.test.ts`) runs them in numeric order in a single process and asserts on the resources each one creates.

## Tutorials

| # | Tutorial | Summary | Docs |
|---|---|---|---|
| 01 | [`01-create-a-counterparty.ts`](./01-create-a-counterparty.ts) | Creates a US-based business counterparty via `POST /v1/entities/counterparties`. Writes `counterpartyId` to `.state.json`. | [Counterparties overview](https://docs.tesser.xyz/) (see Entities / Counterparties section) |
| 02 | [`02-create-a-ledger.ts`](./02-create-a-ledger.ts) | Registers the Circle Mint API key in the org vault (idempotent), then `POST /v1/accounts/ledgers` to create a Circle Mint ledger tied to the counterparty from tutorial 01. Waits for `metadata.circle_mint.circle_compliance_state === "ACCEPTED"` before returning. Writes `ledgerAccountId` to `.state.json`. | Source flow: [Deposit funds via a liquidity provider](https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider) (the ledger-creation portion) |
| 03 | [`03-deposit-via-LP.ts`](./03-deposit-via-LP.ts) | Finds-or-creates an org-level fiat bank as the funding source, then `POST /v1/treasury/deposits` (USD → USDC into the ledger from tutorial 02). Simulates the wire (sandbox-only) and polls the deposit until `actual.to.amount` populates. Writes `depositId` to `.state.json`. | [Deposit funds via a liquidity provider](https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider) |
| 04 | [`04-payout-stellar.ts`](./04-payout-stellar.ts) | Creates an individual beneficiary counterparty and a self-custodial Stellar wallet for them, then `POST /v1/payments` (USDC from the ledger funded in tutorial 03 → recipient wallet). Retries while Circle risk-approves the new wallet, then polls until terminal. Reads `BENEFICIARY_WALLET_ADDRESS_STELLAR` from env. Writes `paymentId` to `.state.json`. | [Create a stablecoin payout](https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-stablecoin-payout) |

## Prerequisites

Same as the rest of the repo:

- `TESSER_CLIENT_ID`, `TESSER_CLIENT_SECRET` in `.env`
- `CIRCLE_API_KEY` in `.env` (needed by tutorial 02 onward)
- `BENEFICIARY_WALLET_ADDRESS_STELLAR` in `.env` (only needed by tutorial 04 — a Stellar account with an active USDC trustline)

See the [top-level README](../README.md#environment-variables) for the full env-var list.

## Adding a new tutorial

1. Pick the next numeric prefix (`03-...`).
2. Inline the API calls; no optional params, no `if/else`.
3. Read prior state via `loadState()` from `./state.ts`. Save outputs via `saveState({ key: value })`.
4. Export an async `tutorial()` function and add an `if (import.meta.main)` block so the file is both importable from tests and runnable standalone.
5. Import the new tutorial in `tests/tutorials.test.ts` and add assertions on the resources it creates.
6. Add a row to the table above with a link to the corresponding doc page.
