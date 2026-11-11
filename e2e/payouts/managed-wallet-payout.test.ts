import { beforeAll, describe, expect, test } from "bun:test";
import { assertBalanceHolds, getAvailableBalance } from "../../src/api/accounts.ts";
import { createPayment } from "../../src/api/payments.ts";
import { signWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Account, RiskStatus } from "../../src/types.ts";
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
import { findOrCreateBeneficiaryWallet, findOrCreateOriginatorBank } from "../fixtures/preflight.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const PAYOUT_TIMEOUT_MS = 11 * 60_000;
const PAYOUT_AMOUNT = 0.1;
const ORIGINATOR_NAME = "E2E outbound originator";

// The documented sandbox risk-test addresses: each always screens to the same verdict.
const payouts: { beneficiary: string; walletName: string; address: string; finalRiskStatus: RiskStatus }[] = [
  {
    beneficiary: "an automatically approved beneficiary",
    walletName: "E2E outbound beneficiary, auto-approved",
    address: "0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f",
    finalRiskStatus: "automatically_approved",
  },
  {
    beneficiary: "a beneficiary held for review and approved",
    walletName: "E2E outbound beneficiary, manual review",
    address: "0x0a5b2bf3ccfb44c1d22f07eed9553ecba752d4ad",
    finalRiskStatus: "manually_approved",
  },
];

let wallet: Account;
let originatorBankId: string;
const beneficiaryWalletIds = new Map<string, string>();

beforeAll(async () => {
  wallet = await fundedRunWallet(payouts.length * PAYOUT_AMOUNT);
  const [bankId, ...walletIds] = await Promise.all([
    findOrCreateOriginatorBank(ORIGINATOR_NAME),
    ...payouts.map(({ walletName, address }) => findOrCreateBeneficiaryWallet({ name: walletName, address })),
  ]);
  originatorBankId = bankId;
  payouts.forEach(({ walletName }, i) => beneficiaryWalletIds.set(walletName, walletIds[i]!));
}, FUNDING_TIMEOUT_MS);

describe("Create a Payout (from a Wallet)", () => {
  test.each(payouts)(
    "USDC to $beneficiary is paid out from that wallet once its step is signed with the Kotlin SDK",
    async ({ walletName, finalRiskStatus }) => {
      const toAccountId = beneficiaryWalletIds.get(walletName)!;
      const balance = usdcOf(wallet.id);
      const debited = exactly(parseFloat(await getAvailableBalance(balance)) - PAYOUT_AMOUNT);

      const paymentId = await createPayment({
        fundingAccountId: originatorBankId,
        fromAccountId: wallet.id,
        toAccountId,
        amount: String(PAYOUT_AMOUNT),
        currency: "USDC",
        network: NETWORK,
        reference: `e2e-${RUN_ID}-outbound-${finalRiskStatus}`,
      });
      const payment = await waitForPayment(paymentId, {
        decide: async () => true,
        reason: "Approved by the E2E run",
        sign: signWithKotlinSdk,
        timeoutMs: PAYMENT_TIMEOUT_MS,
      });

      expect(payment.direction).toBe("outbound");
      expect(payment.funding_account_id).toBe(originatorBankId);
      expect(payment.risk_status).toBe(finalRiskStatus);
      expect(payment.steps.map((s) => s.status)).toEqual(["completed"]);
      const [transfer] = payment.steps;
      expect(transfer?.transaction_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(transfer?.completed_at).toBeTruthy();
      expect(payment.actual.from.account_id).toBe(wallet.id);
      expect(payment.actual.to.account_id).toBe(toAccountId);
      expect(payment.actual.to.network).toBe(NETWORK);
      expect(payment.actual.to.currency).toBe("USDC");
      expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(PAYOUT_AMOUNT);
      // Signing reserved the payout and gas is sponsored, so nothing else leaves the wallet.
      await assertBalanceHolds({ ...balance, amount: debited, holdMs: BALANCE_HOLD_MS });
    },
    PAYOUT_TIMEOUT_MS,
  );
});
