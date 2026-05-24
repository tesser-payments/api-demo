// Stablecoin payout flow: runs the example and asserts terminal state +
// webhook event sequence. One exported entry point per test case so the
// matrix in `tests/flows.test.ts` stays a thin loop over variants.

import { expect } from "vitest";
import { type WebhookSubscription } from "../../src/webhooks.ts";
import {
  run as deposit,
} from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import {
  run as payout,
  meta as payoutMeta,
  resolveWalletAddress,
  type StablecoinPayoutResult,
} from "../../examples/create-a-stablecoin-payout.ts";
import { EXPECTED_STABLECOIN_PAYOUT } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";
import { countByType } from "./webhook-fixture.ts";

export { payoutMeta as meta, resolveWalletAddress };

export interface PayoutNetwork {
  /** Network key, e.g. "STELLAR" or "POLYGON_AMOY". */
  key: string;
  /** Human-readable name. */
  name: string;
}

export async function runPayoutVariant(
  network: PayoutNetwork,
  sub: WebhookSubscription,
): Promise<void> {
  const ledgerAccountId = await ensureFundedLedger(network);

  const result = await payout({
    ledgerAccountId,
    amount: "0.01",
    network: network.key,
  });

  const events = await sub.scopedTo(result.paymentId).collectAll({
    expectedTypes: EXPECTED_STABLECOIN_PAYOUT.types,
    timeoutMs: 10 * 60 * 1000,
  });

  expect(countByType(events.map((e) => e.type))).toEqual(
    countByType(EXPECTED_STABLECOIN_PAYOUT.types),
  );
  expect(events.filter((e) => !e.signatureValid)).toEqual([]);
  assertPaymentTerminal(result);
}

async function ensureFundedLedger(network: PayoutNetwork): Promise<string> {
  const existing = sharedState.findFundedLedger({
    provider: "CIRCLE_MINT",
    currency: "USDC",
  });
  if (existing) {
    sharedState.markReused(
      `payout / Circle / ${network.key}`,
      "ledger",
      existing.id,
      undefined,
      {
        provider: "CIRCLE_MINT",
        currency: "USDC",
        network: network.key,
        // operationKind+id are filled in by the caller after payment
        // creation; mark-reused fires before the payment, so we leave
        // these unset here.
      },
    );
    return existing.id;
  }
  // No funded ledger in the pool yet — fund one inline.
  const funded = await deposit({ depositAmount: "100.00" });
  sharedState.registerLedger(
    {
      id: funded.ledgerAccountId,
      provider: "CIRCLE_MINT",
      currency: "USDC",
      hasBalance: true,
      counterpartyId: funded.counterpartyId ?? undefined,
      createdBy: `payout / Circle / ${network.key} (inline fund)`,
    },
    `deposit ${funded.depositId}`,
    {
      operationKind: "deposit",
      operationId: funded.depositId,
      operationSummary: "100 USD → USDC",
    },
  );
  return funded.ledgerAccountId;
}

// Payment terminal contract (verified empirically against sandbox).
// Note: docs claim `estimated` populates, but the Stellar payout path
// leaves estimated.{from,to}.* null at terminal — only desired and
// actual carry values. Asserted accordingly.
function assertPaymentTerminal(result: StablecoinPayoutResult): void {
  expect(result.payment.desired).toMatchObject(
    EXPECTED_STABLECOIN_PAYOUT.terminal.desired,
  );
  expect(result.payment.direction).toBe("outbound");
  expect(result.payment.expires_at).toEqual(expect.any(String));
  expect(result.payment.risk_status).toBe("auto_approved");
  expect(result.payment.balance_status).toBe("reserved");

  expect(result.payment.steps).toHaveLength(1);
  const step = result.payment.steps?.[0]!;
  expect(step.status).toBe("completed");
  expect(step.provider_key).toBe("circle_mint");
  expect(step.step_type).toBe("transfer");
  expect(step.completed_at).toEqual(expect.any(String));
  expect(step.status_reasons ?? []).toEqual([]);
  // On-chain transfer — transaction_hash populated.
  expect(step.transaction_hash).toEqual(expect.any(String));
  expect(step.transaction_hash?.length).toBeGreaterThan(0);
  // Circle Mint charges a provider fee; one entry in fees array.
  expect((step.fees ?? []).length).toBeGreaterThanOrEqual(1);

  // Same-currency outbound: actual.from amount equals desired and equals
  // actual.to (no slippage).
  expect(result.payment.actual?.from?.amount).toBe(result.payment.desired?.from?.amount);
  expect(result.payment.actual?.to?.amount).toBe(result.payment.actual?.from?.amount);
  expect(result.payment.actual?.from?.network).toBe(result.payment.desired?.from?.network);
  expect(result.payment.actual?.to?.network).toBe(result.payment.desired?.to?.network);
}
