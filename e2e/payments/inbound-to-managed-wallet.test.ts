import { beforeAll, expect, test } from "bun:test";
import { authenticate } from "../../src/client.ts";
import { assertBalanceHolds, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { simulateInbound } from "../../src/api/payments.ts";
import { inboundNetwork } from "../../src/inbound.ts";
import { turnkeyCredentials } from "../../src/setup/turnkey.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Account, MockedRiskStatus, RiskStatus } from "../../src/types.ts";
import { findOrCreateManagedWallet } from "../preflight.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const TIMEOUT_MS = 15 * 60_000;
const PAYMENT_TIMEOUT_MS = 5 * 60_000;
const BALANCE_HOLD_MS = 30_000;
// simulate-inbound always sends exactly 1 USDC.
const INBOUND_AMOUNT = 1;
const network = inboundNetwork();
const turnkey = turnkeyCredentials();

// Each scenario has its own wallet, used by nothing else, so the balance only
// moves by its own inbound. They run one at a time: both sends come from the
// platform's single playground wallet, which doesn't queue nonces.
const scenarios: {
  sender: string;
  walletName: string;
  mockedRiskStatus: MockedRiskStatus;
  finalRiskStatus: RiskStatus;
}[] = [
  {
    sender: "an automatically approved sender",
    walletName: "E2E inbound, auto-approved",
    mockedRiskStatus: "automatically_approved",
    finalRiskStatus: "automatically_approved",
  },
  {
    sender: "a sender held for review and approved",
    walletName: "E2E inbound, manual review",
    mockedRiskStatus: "awaiting_decision",
    finalRiskStatus: "manually_approved",
  },
];

const wallets = new Map<string, Account>();

beforeAll(async () => {
  await authenticate();
  for (const { walletName } of scenarios) {
    wallets.set(walletName, await findOrCreateManagedWallet(walletName, turnkey));
  }
});

const plusInbound = (balance: string) => (parseFloat(balance) + INBOUND_AMOUNT).toFixed(6);

test.each(scenarios)(
  "USDC from $sender is credited to a managed wallet and completes",
  async ({ walletName, mockedRiskStatus, finalRiskStatus }) => {
    const wallet = wallets.get(walletName)!;
    const balance = { accountId: wallet.id, currency: "USDC", network };
    const credited = plusInbound(await getAvailableBalance(balance));

    const paymentId = await simulateInbound({ toAccountId: wallet.id, mockedRiskStatus, network });
    // Inbound credits the wallet at detection, whatever the risk verdict.
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
    expect(payment.actual.to.network).toBe(network);
    expect(payment.actual.to.currency).toBe("USDC");
    expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(INBOUND_AMOUNT);
    // Neither finality nor the review moves the balance again.
    await assertBalanceHolds({ ...balance, amount: credited, holdMs: BALANCE_HOLD_MS });
  },
  TIMEOUT_MS,
);
