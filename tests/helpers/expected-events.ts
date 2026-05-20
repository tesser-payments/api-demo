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
 * Source: https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-stablecoin-payout
 * Scenario: USDC ledger → self-custodial wallet, single-step POST with full
 * account information (no two-step PATCH). The `payment.updated` after PATCH
 * is omitted.
 * Last verified: 2026-05-20
 */
export const EXPECTED_STABLECOIN_PAYOUT = {
  types: [
    "payment.quote_created",
    "payment.risk_updated",
    "payment.balance_updated",
    "step.submitted",
    "step.confirmed",
    "step.completed",
    "payment.updated",
  ] as const,
  terminal: {
    desired: {
      from: { currency: "USDC" },
      to: { currency: "USDC" },
    },
    // estimated populated after quote; actual populated once steps complete.
  },
} as const;
