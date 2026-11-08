import { beforeAll, expect, test } from "bun:test";
import { authenticate } from "../../src/client.ts";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { createPayment, simulateInbound } from "../../src/api/payments.ts";
import { createWalletWithKotlinSdk, signWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Account, MockedRiskStatus, RiskStatus } from "../../src/types.ts";
import { findOrCreateBeneficiaryWallet, findOrCreateOriginatorBank, requireKotlinSigner } from "../preflight.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const CREATE_TIMEOUT_MS = 2 * 60_000;
const INBOUND_TIMEOUT_MS = 12 * 60_000;
const PAYOUT_TIMEOUT_MS = 11 * 60_000;
const PAYMENT_TIMEOUT_MS = 5 * 60_000;
const BALANCE_HOLD_MS = 30_000;
// Polygon Amoy finalizes within seconds, and the outbound risk-test addresses work on it.
const NETWORK = "POLYGON_AMOY";
// simulate-inbound always sends exactly 1 USDC.
const INBOUND_AMOUNT = 1;
const PAYOUT_AMOUNT = 0.1;
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ORIGINATOR_NAME = "E2E outbound originator";

// Both inbounds come from the platform's single faucet wallet, which doesn't queue
// nonces, and every test moves this run's wallet, so they all run one at a time.
const inbounds: { sender: string; mockedRiskStatus: MockedRiskStatus; finalRiskStatus: RiskStatus }[] = [
  { sender: "an automatically approved sender", mockedRiskStatus: "automatically_approved", finalRiskStatus: "automatically_approved" },
  { sender: "a sender held for review and approved", mockedRiskStatus: "awaiting_decision", finalRiskStatus: "manually_approved" },
];

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

let originatorBankId: string;
const beneficiaryWalletIds = new Map<string, string>();
// Created by the first test; every later test receives into or pays from it.
let runWallet: Account | undefined;

beforeAll(async () => {
  await requireKotlinSigner();
  await authenticate();
  const [bankId, ...walletIds] = await Promise.all([
    findOrCreateOriginatorBank(ORIGINATOR_NAME),
    ...payouts.map(({ walletName, address }) => findOrCreateBeneficiaryWallet({ name: walletName, address })),
  ]);
  originatorBankId = bankId;
  payouts.forEach(({ walletName }, i) => beneficiaryWalletIds.set(walletName, walletIds[i]!));
});

const exactly = (amount: number) => amount.toFixed(6);

function requireRunWallet(): Account {
  if (!runWallet) throw new Error("No wallet to use: the wallet creation test failed");
  return runWallet;
}

test(
  "a managed wallet is created with the Kotlin SDK",
  async () => {
    const name = `E2E outbound ${RUN_ID}`;
    const wallet = await createWalletWithKotlinSdk(name);

    expect(wallet.name).toBe(name);
    expect(wallet.type).toBe("stablecoin_ethereum");
    expect(wallet.is_managed).toBe(true);
    expect(wallet.crypto_wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parseFloat(await getAvailableBalance({ accountId: wallet.id, currency: "USDC", network: NETWORK }))).toBe(0);
    runWallet = wallet;
  },
  CREATE_TIMEOUT_MS,
);

test.each(inbounds)(
  "USDC from $sender is credited to that wallet's new address and completes",
  async ({ mockedRiskStatus, finalRiskStatus }) => {
    const wallet = requireRunWallet();
    const balance = { accountId: wallet.id, currency: "USDC", network: NETWORK };
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

test.each(payouts)(
  "USDC to $beneficiary is paid out from that wallet once its step is signed with the Kotlin SDK",
  async ({ walletName, finalRiskStatus }) => {
    const wallet = requireRunWallet();
    const toAccountId = beneficiaryWalletIds.get(walletName)!;
    const balance = { accountId: wallet.id, currency: "USDC", network: NETWORK };
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
