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
 * Last verified: 2026-05-18
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
