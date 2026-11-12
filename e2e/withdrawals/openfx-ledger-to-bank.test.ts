import { beforeAll, describe, expect, test } from "bun:test";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { createLedgerWithdrawal, getWithdrawal } from "../../src/api/withdrawals.ts";
import { waitForWithdrawal } from "../../src/steps.ts";
import type { Account } from "../../src/types.ts";
import { BALANCE_HOLD_MS, exactly, ledgerAsset, openfxAccounts, RUN_ID } from "../fixtures/openfx-ledger.ts";

// Above OpenFX's minimum trade size, and below what the ledger swap adds each run.
const WITHDRAWAL_AMOUNT = 105;
// The bank transfer settles when OpenFX's withdrawal webhook arrives.
const WITHDRAWAL_WAIT_MS = 30 * 60_000;
const WITHDRAWAL_TIMEOUT_MS = 32 * 60_000;

let ledger: Account;
let bank: Account;

beforeAll(async () => {
  ({ ledger, bank } = await openfxAccounts());
});

describe("Withdraw Funds via a Liquidity Provider", () => {
  test(
    "USDC is withdrawn from the workspace's OpenFX ledger to its bank account as USD",
    async () => {
      const usdc = ledgerAsset(ledger.id, "USDC");
      const usd = ledgerAsset(ledger.id, "USD");
      const [usdcBalance, usdBalance] = await Promise.all([getAvailableBalance(usdc), getAvailableBalance(usd)]);
      if (parseFloat(usdcBalance) < WITHDRAWAL_AMOUNT) {
        throw new Error(
          `The OpenFX ledger holds ${usdcBalance} USDC, less than the ${WITHDRAWAL_AMOUNT} USDC to withdraw; run e2e/rebalances/openfx-ledger-swap.test.ts first`,
        );
      }

      const created = await createLedgerWithdrawal({
        ledgerId: ledger.id,
        bankAccountId: bank.id,
        amount: String(WITHDRAWAL_AMOUNT),
        fromCurrency: "USDC",
        toCurrency: "USD",
        reference: `e2e-${RUN_ID}-withdrawal`,
      });
      expect(created.direction).toBe("outbound");
      expect(created.balance_status).toBe("unreserved");
      expect(created.steps).toEqual([]);
      expect(created.desired.from.account_id).toBe(ledger.id);
      expect(created.desired.to.account_id).toBe(bank.id);
      expect(parseFloat(created.desired.from.amount ?? "0")).toBe(WITHDRAWAL_AMOUNT);

      await waitForWithdrawal(created.id, { timeoutMs: WITHDRAWAL_WAIT_MS });
      const withdrawal = await getWithdrawal(created.id);

      expect(withdrawal.balance_status).toBe("reserved");
      expect(withdrawal.balance_reserved_at).toBeTruthy();
      expect(withdrawal.steps.map((s) => `${s.step_type}:${s.status}`)).toEqual(["swap:completed", "transfer:completed"]);
      const [swap, transfer] = withdrawal.steps;
      for (const step of [swap, transfer]) {
        expect(step?.provider_key).toBe("openfx");
        expect(step?.transaction_hash).toBeNull();
        expect(step?.completed_at).toBeTruthy();
      }
      expect([swap?.actual.from.account_id, swap?.actual.to.account_id]).toEqual([ledger.id, ledger.id]);
      expect([swap?.actual.from.currency, swap?.actual.to.currency]).toEqual(["USDC", "USD"]);
      expect([transfer?.actual.from.account_id, transfer?.actual.to.account_id]).toEqual([ledger.id, bank.id]);
      expect([transfer?.actual.from.currency, transfer?.actual.to.currency]).toEqual(["USD", "USD"]);
      // The bank transfer pays out exactly what the swap produced.
      const redeemed = parseFloat(swap?.actual.to.amount ?? "0");
      expect(redeemed).toBeGreaterThan(0);
      expect(parseFloat(transfer?.actual.from.amount ?? "0")).toBe(redeemed);

      const { from, to } = withdrawal.actual;
      expect([from.account_id, from.currency, from.network]).toEqual([ledger.id, "USDC", null]);
      expect([to.account_id, to.currency, to.network]).toEqual([bank.id, "USD", null]);
      expect(parseFloat(from.amount ?? "0")).toBe(WITHDRAWAL_AMOUNT);
      expect(parseFloat(to.amount ?? "0")).toBe(parseFloat(transfer?.actual.to.amount ?? "0"));

      // The redeemed USD passes through the ledger, so only the USDC leaves it.
      const usdcAfter = exactly(parseFloat(usdcBalance) - WITHDRAWAL_AMOUNT);
      await waitForBalance({ ...usdc, amount: usdcAfter });
      await Promise.all([
        assertBalanceHolds({ ...usdc, amount: usdcAfter, holdMs: BALANCE_HOLD_MS }),
        assertBalanceHolds({ ...usd, amount: exactly(parseFloat(usdBalance)), holdMs: BALANCE_HOLD_MS }),
      ]);
    },
    WITHDRAWAL_TIMEOUT_MS,
  );
});
