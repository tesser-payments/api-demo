import { beforeAll, describe, expect, test } from "bun:test";
import { assertBalanceHolds, findMasterWallet, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { createRebalance, getRebalance } from "../../src/api/rebalances.ts";
import { signWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForRebalance } from "../../src/steps.ts";
import type { Account } from "../../src/types.ts";
import {
  BALANCE_HOLD_MS,
  exactly,
  FUNDING_TIMEOUT_MS,
  fundedRunWallet,
  NETWORK,
  PAYMENT_TIMEOUT_MS,
  RUN_ID,
  usdcOf,
} from "../fixtures/managed-wallet.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const REBALANCE_TIMEOUT_MS = 12 * 60_000;
const REBALANCE_AMOUNT = 0.5;

let wallet: Account;
// The workspace's first managed wallet; it only ever receives, so no run has to sign for it.
let masterWallet: Account;

beforeAll(async () => {
  wallet = await fundedRunWallet(REBALANCE_AMOUNT);
  masterWallet = await findMasterWallet();
}, FUNDING_TIMEOUT_MS);

describe("Rebalance Funds", () => {
  test(
    "USDC is rebalanced from that wallet to the workspace's master wallet once its step is signed with the Kotlin SDK",
    async () => {
      const source = usdcOf(wallet.id);
      const destination = usdcOf(masterWallet.id);
      const [sourceBalance, destinationBalance] = await Promise.all([getAvailableBalance(source), getAvailableBalance(destination)]);
      const debited = exactly(parseFloat(sourceBalance) - REBALANCE_AMOUNT);
      const credited = exactly(parseFloat(destinationBalance) + REBALANCE_AMOUNT);

      const created = await createRebalance({
        fromAccountId: wallet.id,
        toAccountId: masterWallet.id,
        amount: String(REBALANCE_AMOUNT),
        currency: "USDC",
        network: NETWORK,
        reference: `e2e-${RUN_ID}-rebalance`,
      });
      expect(created.direction).toBe("rebalance");
      expect(created.balance_status).toBe("unreserved");
      expect(created.balance_reserved_at).toBeNull();
      expect(created.steps).toEqual([]);
      expect(created.desired.from.account_id).toBe(wallet.id);
      expect(created.desired.to.account_id).toBe(masterWallet.id);
      expect(parseFloat(created.desired.from.amount ?? "0")).toBe(REBALANCE_AMOUNT);

      await waitForRebalance(created.id, { sign: signWithKotlinSdk, timeoutMs: PAYMENT_TIMEOUT_MS });
      const rebalance = await getRebalance(created.id);

      // The balance check runs when the signature is accepted.
      expect(rebalance.balance_status).toBe("reserved");
      expect(rebalance.balance_reserved_at).toBeTruthy();
      expect(rebalance.steps.map((s) => `${s.step_type}:${s.status}`)).toEqual(["transfer:completed"]);
      const [transfer] = rebalance.steps;
      expect(transfer?.transaction_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(transfer?.completed_at).toBeTruthy();
      for (const [leg, accountId] of [["from", wallet.id], ["to", masterWallet.id]] as const) {
        expect(rebalance.actual[leg].account_id).toBe(accountId);
        expect(rebalance.actual[leg].network).toBe(NETWORK);
        expect(rebalance.actual[leg].currency).toBe("USDC");
        expect(parseFloat(rebalance.actual[leg].amount ?? "0")).toBe(REBALANCE_AMOUNT);
      }
      // Exactly once on the master wallet: the platform must not also count the transfer as an inbound payment.
      await waitForBalance({ ...destination, amount: credited });
      await Promise.all([
        assertBalanceHolds({ ...source, amount: debited, holdMs: BALANCE_HOLD_MS }),
        assertBalanceHolds({ ...destination, amount: credited, holdMs: BALANCE_HOLD_MS }),
      ]);
    },
    REBALANCE_TIMEOUT_MS,
  );
});
