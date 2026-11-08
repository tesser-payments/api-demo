import { beforeAll, expect, test } from "bun:test";
import { authenticate } from "../../src/client.ts";
import { assertBalanceHolds, getAvailableBalance } from "../../src/api/accounts.ts";
import { createPayment } from "../../src/api/payments.ts";
import { signWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { RiskStatus } from "../../src/types.ts";
import {
  findOrCreateBeneficiaryWallet,
  findOrCreateOriginatorBank,
  requireFundedManagedWallet,
  requireKotlinSigner,
} from "../preflight.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const TIMEOUT_MS = 11 * 60_000;
const PAYMENT_TIMEOUT_MS = 5 * 60_000;
const BALANCE_HOLD_MS = 30_000;
const NETWORK = "POLYGON_AMOY";
const PAYOUT_AMOUNT = "0.1";
const RUN_ID = crypto.randomUUID().slice(0, 8);
// Funded by hand; the signing key's Turnkey policy only lets it sign for this wallet.
const SOURCE_WALLET_NAME = "E2E outbound";
const ORIGINATOR_NAME = "E2E outbound originator";

// The documented sandbox risk-test addresses: each always screens to the same verdict.
// Both scenarios pay from the same wallet, so they run one at a time.
const scenarios: {
  beneficiary: string;
  walletName: string;
  address: string;
  finalRiskStatus: RiskStatus;
}[] = [
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

let sourceWalletId: string;
let originatorBankId: string;
const beneficiaryWalletIds = new Map<string, string>();

beforeAll(async () => {
  await requireKotlinSigner();
  await authenticate();
  const runTotal = (parseFloat(PAYOUT_AMOUNT) * scenarios.length).toFixed(6);
  sourceWalletId = (
    await requireFundedManagedWallet({ name: SOURCE_WALLET_NAME, currency: "USDC", network: NETWORK, minimum: runTotal })
  ).id;
  originatorBankId = await findOrCreateOriginatorBank(ORIGINATOR_NAME);
  for (const { walletName, address } of scenarios) {
    beneficiaryWalletIds.set(walletName, await findOrCreateBeneficiaryWallet({ name: walletName, address }));
  }
});

const minusPayout = (balance: string) => (parseFloat(balance) - parseFloat(PAYOUT_AMOUNT)).toFixed(6);

test.each(scenarios)(
  "USDC to $beneficiary is paid out from a managed wallet once its step is signed",
  async ({ walletName, finalRiskStatus }) => {
    const toAccountId = beneficiaryWalletIds.get(walletName)!;
    const balance = { accountId: sourceWalletId, currency: "USDC", network: NETWORK };
    const debited = minusPayout(await getAvailableBalance(balance));

    const paymentId = await createPayment({
      fundingAccountId: originatorBankId,
      fromAccountId: sourceWalletId,
      toAccountId,
      amount: PAYOUT_AMOUNT,
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
    expect(payment.actual.from.account_id).toBe(sourceWalletId);
    expect(payment.actual.to.account_id).toBe(toAccountId);
    expect(payment.actual.to.network).toBe(NETWORK);
    expect(payment.actual.to.currency).toBe("USDC");
    expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(parseFloat(PAYOUT_AMOUNT));
    // Exact to the smallest unit: signing reserved the payout and gas is sponsored, so nothing else leaves.
    expect(parseFloat(await getAvailableBalance(balance)).toFixed(6)).toBe(debited);
    await assertBalanceHolds({ ...balance, amount: debited, holdMs: BALANCE_HOLD_MS });
  },
  TIMEOUT_MS,
);
