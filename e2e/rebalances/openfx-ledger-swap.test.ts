import { beforeAll, describe, expect, test } from "bun:test";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { createLedgerSwap, getRebalance } from "../../src/api/rebalances.ts";
import { waitForRebalance } from "../../src/steps.ts";
import type { Account } from "../../src/types.ts";
import { BALANCE_HOLD_MS, exactly, ledgerAsset, openfxAccounts, RUN_ID } from "../fixtures/openfx-ledger.ts";

// Above OpenFX's minimum trade size, USD 100.
const SWAP_AMOUNT = 110;
const SWAP_WAIT_MS = 10 * 60_000;
// Above the create's 5 min of retries, the wait and the balance checks.
const SWAP_TIMEOUT_MS = 18 * 60_000;

let ledger: Account;

beforeAll(async () => {
  ({ ledger } = await openfxAccounts());
});

describe("Rebalance Funds", () => {
  test(
    "USD is swapped to USDC inside the workspace's OpenFX ledger",
    async () => {
      const usd = ledgerAsset(ledger.id, "USD");
      const usdc = ledgerAsset(ledger.id, "USDC");
      const [usdBalance, usdcBalance] = await Promise.all([getAvailableBalance(usd), getAvailableBalance(usdc)]);
      if (parseFloat(usdBalance) < SWAP_AMOUNT) {
        throw new Error(`The OpenFX ledger holds ${usdBalance} USD, less than the ${SWAP_AMOUNT} USD to swap; fund it in the OpenFX sandbox`);
      }

      const created = await createLedgerSwap({
        ledgerId: ledger.id,
        amount: String(SWAP_AMOUNT),
        fromCurrency: "USD",
        toCurrency: "USDC",
        reference: `e2e-${RUN_ID}-ledger-swap`,
      });
      expect(created.direction).toBe("rebalance");
      expect(created.balance_status).toBe("unreserved");
      expect(created.steps).toEqual([]);
      expect(created.desired.from.account_id).toBe(ledger.id);
      expect(created.desired.to.account_id).toBe(ledger.id);
      expect(parseFloat(created.desired.from.amount ?? "0")).toBe(SWAP_AMOUNT);

      await waitForRebalance(created.id, { timeoutMs: SWAP_WAIT_MS });
      const rebalance = await getRebalance(created.id);

      expect(rebalance.balance_status).toBe("reserved");
      expect(rebalance.balance_reserved_at).toBeTruthy();
      expect(rebalance.steps.map((s) => `${s.step_type}:${s.status}`)).toEqual(["swap:completed"]);
      const [swap] = rebalance.steps;
      expect(swap?.provider_key).toBe("openfx");
      expect(swap?.transaction_hash ?? null).toBeNull();
      expect(swap?.completed_at).toBeTruthy();

      const { from, to } = rebalance.actual;
      expect([from.account_id, to.account_id]).toEqual([ledger.id, ledger.id]);
      expect([from.network, to.network]).toEqual([null, null]);
      expect([from.currency, to.currency]).toEqual(["USD", "USDC"]);
      expect(parseFloat(from.amount ?? "0")).toBe(SWAP_AMOUNT);
      const swapped = parseFloat(to.amount ?? "0");
      expect(swapped).toBeGreaterThan(0);

      const usdAfter = exactly(parseFloat(usdBalance) - SWAP_AMOUNT);
      const usdcAfter = exactly(parseFloat(usdcBalance) + swapped);
      await Promise.all([
        waitForBalance({ ...usd, amount: usdAfter, falling: true }),
        waitForBalance({ ...usdc, amount: usdcAfter }),
      ]);
      await Promise.all([
        assertBalanceHolds({ ...usd, amount: usdAfter, holdMs: BALANCE_HOLD_MS }),
        assertBalanceHolds({ ...usdc, amount: usdcAfter, holdMs: BALANCE_HOLD_MS }),
      ]);
    },
    SWAP_TIMEOUT_MS,
  );
});
