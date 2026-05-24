/**
 * Hand-transcribed expected webhook event sequences, sourced from
 * docs.tesser.xyz. Drift between docs and platform surfaces as a test
 * failure — when that happens, re-read the doc, decide whether the doc
 * or the platform is wrong, and update accordingly. Never update these
 * constants to match observed behavior without consulting the doc.
 */

/**
 * Source: https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider
 * Scenario: Ledger deposit at Circle Mint (this example's flow).
 * Last verified: 2026-05-20
 */
export const EXPECTED_DEPOSIT_LP = {
  types: [
    "deposit.quote_created",
    "step.completed",
    "step.completed",
    "deposit.updated",
  ] as const,
  terminal: {
    desired: {
      from: { currency: "USD" },
      to: { currency: "USDC" },
    },
    // estimated populated after quote; actual populated once steps complete.
  },
} as const;

/**
 * Sources:
 *   - https://docs.tesser.xyz/webhooks/payment-updates (event catalog)
 *   - https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-stablecoin-payout
 * Scenario: USDC ledger (custodian) → USDC self-custodial Stellar wallet,
 * single-step POST with full account info (no two-step PATCH).
 *
 * Notes vs the docs:
 *   - Docs' payout how-to page omits `payment.created`. The webhook-updates
 *     page confirms `payment.created` fires immediately after the POST.
 *   - For Stellar (instant-finality), `step.confirmed` is collapsed into
 *     `step.completed`. No separate `step.confirmed` event arrives.
 *   - No terminal `payment.updated` event arrives for this crypto-only
 *     flow. Docs are ambiguous; observed behavior is authoritative until
 *     docs are updated.
 *
 * Last verified: 2026-05-20
 */
export const EXPECTED_STABLECOIN_PAYOUT = {
  types: [
    "payment.created",
    "payment.quote_created",
    "payment.risk_updated",
    "payment.balance_updated",
    "step.submitted",
    "step.completed",
  ] as const,
  terminal: {
    desired: {
      from: { currency: "USDC" },
      to: { currency: "USDC" },
    },
    // estimated populated after quote; actual populated once steps complete.
  },
} as const;
