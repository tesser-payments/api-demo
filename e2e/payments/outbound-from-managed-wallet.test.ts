import { beforeAll, expect, test } from "bun:test";
import { authenticate } from "../../src/client.ts";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { createPayment, simulateInbound } from "../../src/api/payments.ts";
import { createWalletWithKotlinSdk, signWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Account, RiskStatus } from "../../src/types.ts";
import { findOrCreateBeneficiaryWallet, findOrCreateOriginatorBank, requireKotlinSigner } from "../preflight.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const FUNDING_TIMEOUT_MS = 12 * 60_000;
const PAYOUT_TIMEOUT_MS = 11 * 60_000;
const PAYMENT_TIMEOUT_MS = 5 * 60_000;
const BALANCE_HOLD_MS = 30_000;
const NETWORK = "POLYGON_AMOY";
// simulate-inbound always sends exactly 1 USDC.
const INBOUND_AMOUNT = "1";
const PAYOUT_AMOUNT = "0.1";
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ORIGINATOR_NAME = "E2E outbound originator";

// The documented sandbox risk-test addresses: each always screens to the same verdict.
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

let originatorBankId: string;
const beneficiaryWalletIds = new Map<string, string>();
// Created and funded by the first test; the payouts pay from it, one at a time.
let runWallet: Account | undefined;

beforeAll(async () => {
  await requireKotlinSigner();
  await authenticate();
  originatorBankId = await findOrCreateOriginatorBank(ORIGINATOR_NAME);
  for (const { walletName, address } of scenarios) {
    beneficiaryWalletIds.set(walletName, await findOrCreateBeneficiaryWallet({ name: walletName, address }));
  }
});

const exactly = (amount: number) => amount.toFixed(6);

test(
  "a managed wallet created with the Kotlin SDK is credited by an inbound to its new address",
  async () => {
    const name = `E2E outbound ${RUN_ID}`;
    const wallet = await createWalletWithKotlinSdk(name);
    expect(wallet.name).toBe(name);
    expect(wallet.type).toBe("stablecoin_ethereum");
    expect(wallet.is_managed).toBe(true);
    expect(wallet.crypto_wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const balance = { accountId: wallet.id, currency: "USDC", network: NETWORK };
    expect(parseFloat(await getAvailableBalance(balance))).toBe(0);

    const paymentId = await simulateInbound({ toAccountId: wallet.id, mockedRiskStatus: "automatically_approved", network: NETWORK });
    // Detected only if the platform watches the brand-new address.
    await waitForBalance({ ...balance, amount: exactly(parseFloat(INBOUND_AMOUNT)) });
    const payment = await waitForPayment(paymentId, { timeoutMs: PAYMENT_TIMEOUT_MS });

    expect(payment.direction).toBe("inbound");
    expect(payment.risk_status).toBe("automatically_approved");
    expect(payment.steps.map((s) => s.status)).toEqual(["completed"]);
    expect(payment.actual.to.account_id).toBe(wallet.id);
    expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(parseFloat(INBOUND_AMOUNT));
    await assertBalanceHolds({ ...balance, amount: exactly(parseFloat(INBOUND_AMOUNT)), holdMs: BALANCE_HOLD_MS });
    runWallet = wallet;
  },
  FUNDING_TIMEOUT_MS,
);

test.each(scenarios)(
  "USDC to $beneficiary is paid out from that wallet once its step is signed with the Kotlin SDK",
  async ({ walletName, finalRiskStatus }) => {
    if (!runWallet) throw new Error("No funded wallet to pay from: the wallet creation test failed");
    const toAccountId = beneficiaryWalletIds.get(walletName)!;
    const balance = { accountId: runWallet.id, currency: "USDC", network: NETWORK };
    const debited = exactly(parseFloat(await getAvailableBalance(balance)) - parseFloat(PAYOUT_AMOUNT));

    const paymentId = await createPayment({
      fundingAccountId: originatorBankId,
      fromAccountId: runWallet.id,
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
    expect(payment.actual.from.account_id).toBe(runWallet.id);
    expect(payment.actual.to.account_id).toBe(toAccountId);
    expect(payment.actual.to.network).toBe(NETWORK);
    expect(payment.actual.to.currency).toBe("USDC");
    expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(parseFloat(PAYOUT_AMOUNT));
    // Signing reserved the payout and gas is sponsored, so nothing else leaves the wallet.
    await assertBalanceHolds({ ...balance, amount: debited, holdMs: BALANCE_HOLD_MS });
  },
  PAYOUT_TIMEOUT_MS,
);
