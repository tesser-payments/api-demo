import { describe, expect, test } from "bun:test";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { simulateInbound } from "../../src/api/payments.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { MockedRiskStatus, RiskStatus } from "../../src/types.ts";
import {
  BALANCE_HOLD_MS,
  exactly,
  INBOUND_AMOUNT,
  NETWORK,
  PAYMENT_TIMEOUT_MS,
  runWallet,
  usdcOf,
} from "../fixtures/managed-wallet.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const INBOUND_TIMEOUT_MS = 12 * 60_000;

// Every inbound comes from the platform's single faucet wallet, which doesn't queue nonces, so they run one at a time.
const inbounds: { sender: string; mockedRiskStatus: MockedRiskStatus; finalRiskStatus: RiskStatus }[] = [
  { sender: "an automatically approved sender", mockedRiskStatus: "automatically_approved", finalRiskStatus: "automatically_approved" },
  { sender: "a sender held for review and approved", mockedRiskStatus: "awaiting_decision", finalRiskStatus: "manually_approved" },
];

describe("Receive an Inbound Payment to a Wallet", () => {
  test.each(inbounds)(
    "USDC from $sender is credited to that wallet's new address and completes",
    async ({ mockedRiskStatus, finalRiskStatus }) => {
      const wallet = await runWallet();
      const balance = usdcOf(wallet.id);
      const credited = exactly(parseFloat(await getAvailableBalance(balance)) + INBOUND_AMOUNT);

      const paymentId = await simulateInbound({ toAccountId: wallet.id, mockedRiskStatus, network: NETWORK });
      // Credited at detection, whatever the verdict; detected only if the platform watches the new address.
      await waitForBalance({ ...balance, amount: credited });
      const payment = await waitForPayment(paymentId, {
        decide: async () => true,
        reason: "Approved by the E2E run",
        timeoutMs: PAYMENT_TIMEOUT_MS,
      });

      expect(payment.direction).toBe("inbound");
      expect(payment.risk_status).toBe(finalRiskStatus);
      expect(payment.steps.map((s) => s.status)).toEqual(["completed"]);
      const [transfer] = payment.steps;
      expect(transfer?.transaction_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(transfer?.completed_at).toBeTruthy();
      expect(payment.actual.to.account_id).toBe(wallet.id);
      expect(payment.actual.to.network).toBe(NETWORK);
      expect(payment.actual.to.currency).toBe("USDC");
      expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(INBOUND_AMOUNT);
      // Neither finality nor the review moves the balance again.
      await assertBalanceHolds({ ...balance, amount: credited, holdMs: BALANCE_HOLD_MS });
    },
    INBOUND_TIMEOUT_MS,
  );
});
