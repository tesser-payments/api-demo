# E2E test cases

What each E2E check does and asserts, in plain words. Each case title matches the test's name in the code, so a CI failure leads straight to its entry here. When you change a test, update this file in the same pull request.

The tests only do what an API customer can do: they call the public Tesser API and the Tesser SDK, never the database or the chain directly.

## Layout

One folder per flow, one file per docs page; each file's `describe` is that page's title.

| File | Docs page |
|------|-----------|
| `wallets/create-managed-wallet.test.ts` | [Create an Account: Managed Wallet](https://docs.tesser.xyz/how-tos/create-an-account#managed-wallet) |
| `inbound/simulate-inbound.test.ts` | [Receive an Inbound Payment to a Wallet](https://docs.tesser.xyz/how-tos/receive-an-inbound-payment/receive-an-inbound-payment-to-a-wallet) |
| `payouts/managed-wallet-payout.test.ts` | [Create a Payout (from a Wallet)](https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-payout-from-a-wallet) |
| `rebalances/wallet-to-master-wallet.test.ts` | [Rebalance Funds](https://docs.tesser.xyz/how-tos/manage-your-treasury/rebalance-funds) |
| `rebalances/openfx-ledger-swap.test.ts` | [Rebalance Funds](https://docs.tesser.xyz/how-tos/manage-your-treasury/rebalance-funds) |
| `withdrawals/openfx-ledger-to-bank.test.ts` | [Withdraw Funds via a Liquidity Provider](https://docs.tesser.xyz/how-tos/manage-your-treasury/withdraw-funds-via-a-liquidity-provider) |

`fixtures/` holds what several files share: `managed-wallet.ts` (the run's managed wallet), `openfx-ledger.ts` (the workspace's OpenFX ledger and bank account) and `preflight.ts` (environment checks and find-or-create helpers).

## Where they run

| CI job | What it runs | Network |
|--------|--------------|---------|
| `circle` | The demo, `index.ts` | `PAYMENT_NETWORK` (default `STELLAR`) |
| `managed-wallet` | `bun run e2e`: `wallets/`, `inbound/`, `payouts/`, `rebalances/wallet-to-master-wallet`, in that order | `POLYGON_AMOY` |
| `openfx` | `bun run e2e:openfx`: `rebalances/openfx-ledger-swap`, then `withdrawals/` | None (ledger only) |

The three jobs run in parallel; inside each job the files run one after another. CI runs them against staging after each platform deploy from `main`, on every push to `main`, and by hand. Pull requests only typecheck, run the unit tests and build the Kotlin signer. When a job fails, one Slack message lists every failed job with its reason (see the main [README](../README.md#ci--e2e-testing)).

Locally, with `.env.local` filled in:

```bash
bun run build:signer            # first: the E2E signs with it (needs a JDK 17–23)
bun run e2e                     # every managed wallet flow, in order, as CI runs them
bun run e2e:openfx              # the OpenFX ledger flows
bun test --timeout 300000 --env-file=.env.local ./e2e/payouts   # one flow on its own
```

The managed wallet flows also need `SIGNING_PUBLIC_KEY`, `SIGNING_PRIVATE_KEY` and `SIGNING_ENCLAVE_ID`. Pass folders or files in the order above: `bun test ./e2e` picks its own order, and the creation test's zero balance only holds when it runs first.

## The run's managed wallet

Every managed wallet file uses one wallet per run, `E2E managed wallet <run id>`, created with the Kotlin SDK on first use (`runWallet()` in `fixtures/managed-wallet.ts`). Bun runs all files in one process, so they share it, and a run never creates a second one. Before creating it, the fixture signs a throwaway step locally with the Kotlin signer, so a missing build, Java runtime or signing key fails before any payment.

A file that spends USDC asks for the balance it needs (`fundedRunWallet(minimum)`). In a full run the inbound cases have already funded the wallet, so nothing more is sent. A file run on its own tops the wallet up with automatically approved 1 USDC inbounds first.

## Circle payout (`index.ts`, CI job `circle`)

A USD wire is minted into USDC through Circle Mint and paid out to a wallet. It runs once per variant: **A** at organization level, **B** under a new tenant (`ENABLE_VARIANTS`).

1. Stores the Circle Mint key and checks that Circle is connected and the Circle account has a linked wire bank.
2. Creates a customer counterparty with a new `CIRCLE_MINT` ledger and a beneficiary counterparty with an unmanaged wallet, then waits until Circle accepts the ledger's compliance.
3. Deposits a random USD amount from the workspace's bank into the ledger as USDC, simulates the wire and waits until every deposit step is `completed`. **Checks** that the ledger holds exactly the deposited amount.
4. Pays 1–2 USDC from the ledger to the wallet, approving the risk review if the payment is held. **Checks** that every payment step is `completed`. A rejection or a failed step fails the run.

## Managed wallet flows (CI job `managed-wallet`)

The run's managed wallet, created with the Tesser Kotlin SDK, receives USDC, pays it out and rebalances some to the workspace's master wallet, with every wallet step signed by the SDK as the "Sign a Wallet Step" guide describes. The signer builds against the latest published SDK release, so a release that breaks creating a wallet or signing fails this job.

| File | Case | What it does | Checks |
|------|------|--------------|--------|
| `wallets/create-managed-wallet` | a managed wallet is created with the Kotlin SDK | Signs the creation with the SDK and creates `E2E managed wallet <run id>` | Name, `stablecoin_ethereum`, managed, an EVM address, USDC balance 0 |
| `inbound/simulate-inbound` | USDC from an automatically approved sender is credited to that wallet's new address and completes | Sends 1 USDC with `simulate-inbound`, risk `automatically_approved` | Balance +1 exactly once detected, which only happens if the platform watches the new address. The payment is `inbound`, `automatically_approved`, with one `completed` step carrying a transaction hash and `completed_at`, and the right account, network, currency and amount (1). The balance stays put for 30 s |
| `inbound/simulate-inbound` | USDC from a sender held for review and approved is credited to that wallet's new address and completes | Same, with risk `awaiting_decision`; the test approves the review | Same checks, ending `manually_approved` |
| `payouts/managed-wallet-payout` | USDC to an automatically approved beneficiary is paid out from that wallet once its step is signed with the Kotlin SDK | Pays 0.1 USDC to `0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f`; signs the step's `unsigned_transaction` with the SDK | The payment is `outbound`, funded by the originator's bank, `automatically_approved`, with one `completed` step carrying a transaction hash and `completed_at`, and the right accounts, network, currency and amount (0.1). The balance drops by exactly 0.1 (reserved at signing; gas is sponsored) and stays put for 30 s |
| `payouts/managed-wallet-payout` | USDC to a beneficiary held for review and approved is paid out from that wallet once its step is signed with the Kotlin SDK | Pays 0.1 USDC to `0x0a5b2bf3ccfb44c1d22f07eed9553ecba752d4ad`; the test approves the review, then signs | Same checks, ending `manually_approved` |
| `rebalances/wallet-to-master-wallet` | USDC is rebalanced from that wallet to the workspace's master wallet once its step is signed with the Kotlin SDK | Rebalances 0.5 USDC with `POST /v1/treasury/rebalances`; signs the step's `unsigned_transaction` with the SDK | The create response is a `rebalance`, `unreserved`, with no steps yet. At the end, `GET /v1/treasury/rebalances/{id}` shows it `reserved` with `balance_reserved_at`, one `completed` `transfer` step carrying a transaction hash and `completed_at`, and the right accounts, network, currency and amount (0.5) on both sides. The wallet drops by exactly 0.5 and the master wallet rises by exactly 0.5, so the platform didn't also count the transfer as an inbound; both stay put for 30 s |

**Before its cases**, the payout file finds, or creates on first use, the originator `E2E outbound originator` (a business counterparty whose bank account is each payout's `funding_account_id`) and the two beneficiaries' unmanaged wallets. The rebalance file finds the workspace's master wallet: its oldest managed EVM wallet with no tenant or counterparty, the one created at signup.

Each case checks its exact change from the balance it starts with (+1, +1, −0.1, −0.1, −0.5), compared to all 6 decimals; in a full run, from the new wallet's 0, that's normally 0 → 1 → 2 → 1.9 → 1.8 → 1.3. Every run leaves 1.3 test USDC in its wallet and adds 0.5 to the master wallet. The rebalance also checks the master wallet's exact balance, so it fails if anything else moves that wallet's USDC on Polygon Amoy during the run. Every inbound comes from the platform's single faucet wallet, which doesn't queue nonces, so every file that sends one stays in this job, where they run one at a time. The beneficiary addresses are the documented sandbox risk-test addresses; each always gets the same risk verdict.

## OpenFX ledger flows (CI job `openfx`)

The workspace's OpenFX ledger swaps USD into USDC, then withdraws USDC to the workspace's bank account as USD. Connecting OpenFX (credentials, webhook, a bank account OpenFX has accepted, a funded USD balance) can't be done through the Tesser API, so the tests use the workspace's OpenFX ledger and its bank account, set up ahead of time, and find both before any create. Each amount is above OpenFX's minimum trade size.

| File | Case | What it does | Checks |
|------|------|--------------|--------|
| `rebalances/openfx-ledger-swap` | USD is swapped to USDC inside the workspace's OpenFX ledger | Rebalances 110 USD to USDC with `POST /v1/treasury/rebalances`, the ledger on both sides and no network | The create response is a `rebalance`, `unreserved`, with no steps yet. At the end it is `reserved`, with one `completed` `swap` step at `openfx` with no transaction hash, and `actual` shows 110 USD out of the ledger and the USDC it bought into the same ledger. The ledger's USD drops by exactly 110 and its USDC rises by exactly what the swap bought; both stay put for 30 s |
| `withdrawals/openfx-ledger-to-bank` | USDC is withdrawn from the workspace's OpenFX ledger to its bank account as USD | Withdraws 105 USDC to the bank account as USD with `POST /v1/treasury/withdrawals` | The create response is `outbound`, `unreserved`, with no steps yet. At the end it is `reserved`, with a `completed` `swap` (USDC to USD in the ledger) and a `completed` `transfer` (the ledger's USD to the bank) at `openfx`, the transfer paying out exactly what the swap redeemed, and `actual` showing 105 USDC from the ledger and the transfer's amount in USD at the bank. The ledger's USDC drops by exactly 105 and its USD ends where it started, since the redeemed USD only passes through; both stay put for 30 s |

Each run spends 110 test USD of the ledger's balance and leaves the few USDC the swap bought beyond the 105 withdrawn. The withdrawal file run on its own needs 105 USDC in the ledger, so it says to run the swap first when there is less.

## Not covered

On purpose, so these gaps are decisions rather than surprises:

- **Rejections** (`automatically_rejected`, `manually_rejected`) and other failure paths. The E2E proves the happy paths; failure paths belong in the platform's own tests.
- **Other networks.** The Circle payout runs on `PAYMENT_NETWORK` and the managed wallet test on Polygon Amoy only; Ethereum Sepolia, Base Sepolia and Tempo aren't exercised.
- **The TypeScript and Java SDKs.** Only the Kotlin SDK signs.
- **Webhooks.** The tests poll the API instead.
- **Withdrawals and ledger rebalances other than OpenFX's**: from a Circle ledger or a wallet, a ledger to a wallet, and between two ledgers.
- **The Travel Rule.**
