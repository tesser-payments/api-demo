# E2E test cases

What each E2E check does and asserts, in plain words. Each case title matches the test's name in the code, so a CI failure leads straight to its entry here. When you change a test, update this file in the same pull request.

The tests only do what an API customer can do: they call the public Tesser API and the Tesser SDK, never the database or the chain directly.

## Where they run

| CI job | What it runs | Network |
|--------|--------------|---------|
| `circle` | The demo, `index.ts` | `PAYMENT_NETWORK` (default `STELLAR`) |
| `managed-wallet` | `payments/managed-wallet.test.ts` | `POLYGON_AMOY` |

CI runs both against staging after each platform deploy from `main`, on every push to `main`, and by hand. Pull requests only typecheck, run the unit tests and build the Kotlin signer. When a job fails, one Slack message lists every failed job with its reason (see the main [README](../README.md#ci--e2e-testing)).

Locally, with `.env.local` filled in:

```bash
bun run build:signer            # first: the managed wallet test signs with it (needs a JDK 17–23)
bun run e2e                     # every file in e2e/
bun test --timeout 300000 --env-file=.env.local ./e2e/payments/managed-wallet.test.ts
```

The managed wallet test also needs `SIGNING_PUBLIC_KEY`, `SIGNING_PRIVATE_KEY` and `SIGNING_ENCLAVE_ID`.

## Circle payout (`index.ts`, CI job `circle`)

A USD wire is minted into USDC through Circle Mint and paid out to a wallet. It runs once per variant: **A** at organization level, **B** under a new tenant (`ENABLE_VARIANTS`).

1. Stores the Circle Mint key and checks that Circle is connected and the Circle account has a linked wire bank.
2. Creates a customer counterparty with a new `CIRCLE_MINT` ledger and a beneficiary counterparty with an unmanaged wallet, then waits until Circle accepts the ledger's compliance.
3. Deposits a random USD amount from the workspace's bank into the ledger as USDC, simulates the wire and waits until every deposit step is `completed`. **Checks** that the ledger holds exactly the deposited amount.
4. Pays 1–2 USDC from the ledger to the wallet, approving the risk review if the payment is held. **Checks** that every payment step is `completed`. A rejection or a failed step fails the run.

`payments/circle-ledger-to-wallet.test.ts` covers the same flow as a test, for both variants, for local runs. CI runs the demo instead.

## Managed wallet (`payments/managed-wallet.test.ts`, CI job `managed-wallet`)

A managed wallet created with the Tesser Kotlin SDK receives USDC and pays it out, with every payment step signed by the SDK as the "Sign a Wallet Step" guide describes. The signer builds against the latest published SDK release, so a release that breaks creating a wallet or signing fails this job.

**Before the cases**, the test:
- signs a throwaway step locally with the Kotlin signer, so a missing build, Java runtime or signing key fails before any payment;
- finds, or creates on first use, the originator `E2E outbound originator` (a business counterparty whose bank account is each payout's `funding_account_id`) and the two beneficiaries' unmanaged wallets.

The cases run in this order, each building on the one before:

| # | Case | What it does | Checks |
|---|------|--------------|--------|
| 1 | a managed wallet is created with the Kotlin SDK | Signs the creation with the SDK and creates `E2E outbound <run id>` | Name, `stablecoin_ethereum`, managed, an EVM address, USDC balance 0 |
| 2 | USDC from an automatically approved sender is credited to that wallet's new address and completes | Sends 1 USDC with `simulate-inbound`, risk `automatically_approved` | Balance +1 exactly once detected, which only happens if the platform watches the new address. The payment is `inbound`, `automatically_approved`, with one `completed` step carrying a transaction hash and `completed_at`, and the right account, network, currency and amount (1). The balance stays put for 30 s |
| 3 | USDC from a sender held for review and approved is credited to that wallet's new address and completes | Same, with risk `awaiting_decision`; the test approves the review | Same checks, ending `manually_approved` |
| 4 | USDC to an automatically approved beneficiary is paid out from that wallet once its step is signed with the Kotlin SDK | Pays 0.1 USDC to `0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f`; signs the step's `unsigned_transaction` with the SDK | The payment is `outbound`, funded by the originator's bank, `automatically_approved`, with one `completed` step carrying a transaction hash and `completed_at`, and the right accounts, network, currency and amount (0.1). The balance drops by exactly 0.1 (reserved at signing; gas is sponsored) and stays put for 30 s |
| 5 | USDC to a beneficiary held for review and approved is paid out from that wallet once its step is signed with the Kotlin SDK | Pays 0.1 USDC to `0x0a5b2bf3ccfb44c1d22f07eed9553ecba752d4ad`; the test approves the review, then signs | Same checks, ending `manually_approved` |

Each case checks its exact change from the balance it starts with (+1, +1, −0.1, −0.1), compared to all 6 decimals; from the new wallet's 0, that's normally 0 → 1 → 2 → 1.9 → 1.8. Every run leaves 1.8 test USDC in its wallet. Both inbounds come from the platform's single faucet wallet, which doesn't queue nonces, which is why all cases run one at a time in this one file. The beneficiary addresses are the documented sandbox risk-test addresses; each always gets the same risk verdict.

## Not covered

On purpose, so these gaps are decisions rather than surprises:

- **Rejections** (`automatically_rejected`, `manually_rejected`) and other failure paths. The E2E proves the happy paths; failure paths belong in the platform's own tests.
- **Other networks.** The Circle payout runs on `PAYMENT_NETWORK` and the managed wallet test on Polygon Amoy only; Ethereum Sepolia, Base Sepolia and Tempo aren't exercised.
- **The TypeScript and Java SDKs.** Only the Kotlin SDK signs.
- **Webhooks.** The tests poll the API instead.
- **Withdrawals, rebalances and the Travel Rule.**
