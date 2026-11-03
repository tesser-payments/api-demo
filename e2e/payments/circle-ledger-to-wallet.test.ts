import { beforeAll, expect, test } from "bun:test";
import { authenticate } from "../../src/client.ts";
import {
  createCircleLedger,
  createUnmanagedWallet,
  findOrCreateFundingBank,
  waitForBalance,
  waitForLedgerCompliance,
} from "../../src/api/accounts.ts";
import { createDeposit, simulateWire, waitForDepositCompletion, waitForDepositPlan } from "../../src/api/deposits.ts";
import { createBusinessCounterparty, createIndividualCounterparty, createTenant } from "../../src/api/entities.ts";
import { createPayment } from "../../src/api/payments.ts";
import { payoutConfig } from "../../src/payout.ts";
import { waitForPayment } from "../../src/steps.ts";
import { prepareCircle } from "../preflight.ts";

// Covers a 35 min ledger compliance wait when Circle is slow to accept.
const TIMEOUT_MS = 50 * 60_000;
const RUN_ID = crypto.randomUUID().slice(0, 8);
const payout = payoutConfig();

const randomAmount = (min: number, max: number) => (min + Math.random() * (max - min)).toFixed(2);

let fundingBankId: string;

beforeAll(async () => {
  await authenticate();
  await prepareCircle();
  fundingBankId = (await findOrCreateFundingBank()).id;
});

test.each(["org", "tenant"] as const)(
  "%s level: a USD wire into a Circle ledger is paid out as USDC to an unmanaged wallet",
  async (level) => {
    const reference = `e2e-${RUN_ID}-${level}`;
    let tenantId: string | undefined;
    if (level === "tenant") tenantId = (await createTenant()).id;

    const customer = await createBusinessCounterparty({ tenantId });
    const beneficiary = await createIndividualCounterparty({ tenantId });
    const ledgerAccountId = await createCircleLedger({ counterpartyId: customer.id, name: `${customer.name}'s Ledger` });
    const walletAccountId = await createUnmanagedWallet({
      counterpartyId: beneficiary.id,
      name: `${beneficiary.name}'s Wallet`,
      payout,
    });
    await waitForLedgerCompliance({ ledgerAccountId, counterpartyId: customer.id });

    const depositAmount = randomAmount(90, 110);
    const depositId = await createDeposit({
      fromAccountId: fundingBankId,
      toAccountId: ledgerAccountId,
      amount: depositAmount,
      fromCurrency: "USD",
      toCurrency: "USDC",
      reference: `${reference}-deposit`,
    });
    await waitForDepositPlan(depositId);
    await simulateWire(depositId);
    await waitForDepositCompletion(depositId);
    await waitForBalance({ accountId: ledgerAccountId, currency: "USDC", amount: depositAmount });

    const paymentId = await createPayment({
      fromAccountId: ledgerAccountId,
      toAccountId: walletAccountId,
      amount: randomAmount(1, 2),
      currency: "USDC",
      network: payout.network,
      reference: `${reference}-payment`,
    });
    const payment = await waitForPayment(paymentId, {
      decide: async () => true,
      reason: "Approved by the E2E run",
    });

    expect(payment.steps.map((s) => s.status)).toEqual(payment.steps.map(() => "completed"));
  },
  TIMEOUT_MS,
);
