import pc from "picocolors";
import { authenticate, get, getAll, DEBUG } from "./src/client.ts";
import {
  createCircleLedger,
  createUnmanagedWallet,
  findOrCreateFundingBank,
  waitForBalance,
  waitForLedgerCompliance,
} from "./src/api/accounts.ts";
import { findCircleMasterLedger, findCircleWireBank, storeCircleKey } from "./src/setup/circle.ts";
import { createDeposit, simulateWire, waitForDepositCompletion, waitForDepositPlan } from "./src/api/deposits.ts";
import {
  createBusinessCounterparty,
  createIndividualCounterparty,
  createTenant,
} from "./src/api/entities.ts";
import { createPayment } from "./src/api/payments.ts";
import { payoutConfig, type Payout } from "./src/payout.ts";
import { stepSummary, waitForPayment } from "./src/steps.ts";
import type { Account, Leg, Payment } from "./src/types.ts";
import type {
  CounterpartyListResponse,
  TenantListResponse,
} from "@tesser-payments/types";

const sep = () => pc.dim("─".repeat(60));

// Tags this run's deposits and payments (organization_reference_id).
const RUN_ID = crypto.randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const formatLeg = (leg: Leg) =>
  [leg.amount, leg.currency, leg.network && pc.dim(leg.network)].filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Step 1: Authenticate
// ---------------------------------------------------------------------------
async function step1_authenticate(): Promise<void> {
  const token = await authenticate();
  console.log(`  Token: ${pc.dim(token.slice(0, 20) + "..." + token.slice(-8))}`);
}

// ---------------------------------------------------------------------------
// Step 1.5: Store Circle Mint API key in organization vault
// ---------------------------------------------------------------------------
async function step1_5_storeCircleMintKey(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.log(pc.yellow("  ⚠️  CIRCLE_API_KEY not set — skipping vault storage"));
    return;
  }

  const maskedKey = await storeCircleKey(apiKey);
  if (!maskedKey) {
    console.log(pc.dim("  Already configured — continuing"));
    return;
  }
  console.log(`  Masked value:  ${maskedKey}`);
}

// ---------------------------------------------------------------------------
// Step 1.6: Preflight — Circle is connected and has a linked wire bank
// ---------------------------------------------------------------------------
// Both are set up outside the Tesser API. Without them the flow fails late and
// opaquely: ledger creation returns a 502, or the deposit is never planned.
async function step1_6_preflight(): Promise<void> {
  const master = await findCircleMasterLedger();
  console.log(`  Circle master ledger: ${master.name} ${pc.dim(`(${master.id})`)}`);

  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.log(pc.yellow("  ⚠️  CIRCLE_API_KEY not set — can't check the Circle wire bank"));
    return;
  }
  const bank = await findCircleWireBank(apiKey);
  console.log(`  Circle wire bank:     ${bank.description ?? bank.id} ${pc.dim(`(${bank.status})`)}`);
}

// ---------------------------------------------------------------------------
// Step 2: Display current state (all list endpoints)
// ---------------------------------------------------------------------------
async function step2_displayCurrentState(): Promise<string> {
  const currencies = await get<{ data: { name: string; key: string; decimals: number; network: string | null }[] }>("/v1/currencies");
  console.log(`  Currencies:     ${pc.bold(String(currencies.data.length))}`);
  for (const c of currencies.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(c.key)} ${pc.dim(`(${c.name})`)}`);
  }

  const networks = await get<{ data: { name: string; key: string }[] }>("/v1/networks");
  console.log(`  Networks:       ${pc.bold(String(networks.data.length))}`);
  for (const n of networks.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(n.key)} ${pc.dim(`(${n.name})`)}`);
  }

  const allCounterparties = await getAll<CounterpartyListResponse["data"][number]>("/v1/entities/counterparties");
  console.log(`  Counterparties: ${pc.bold(String(allCounterparties.length))}`);
  for (const c of allCounterparties) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(c.id)}  ${c.classification}  ${c.name}`);
  }

  const allAccounts = await getAll<Account>("/v1/accounts");
  console.log(`  Accounts:       ${pc.bold(String(allAccounts.length))}`);
  for (const a of allAccounts) {
    const cp = a.counterparty_id ? pc.dim(a.counterparty_id.slice(0, 8)) : pc.dim("none");
    const assets = a.assets?.length
      ? a.assets.map((x) => `${x.available_balance} ${x.currency}`).join(", ")
      : pc.dim("(none)");
    const managed = !!a.is_managed ? "managed" : "unmanaged";
    console.log(`    ${pc.dim("·")} ${pc.cyan(a.id)}  ${a.name}  ${a.type}  ${managed}  cp=${cp}  ${assets}`);
  }

  const allTenants = await getAll<TenantListResponse["data"][number]>("/v1/entities/tenants");
  console.log(`  Tenants:        ${pc.bold(String(allTenants.length))}`);
  for (const t of allTenants) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(t.id)}  ${t.name}`);
  }

  const allPayments = await getAll<Payment>("/v1/payments");
  console.log(`  Payments:       ${pc.bold(String(allPayments.length))}`);
  for (const p of allPayments) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(p.id)}  ${p.direction}  ${formatLeg(p.desired.from)} → ${formatLeg(p.desired.to)}`);
  }

  const fundingBank = await findOrCreateFundingBank();
  const created = fundingBank.created ? `${pc.yellow("(created)")} ` : "";
  console.log(`  Funding bank:   ${created}${fundingBank.name} ${pc.dim(`(${fundingBank.id})`)}`);
  return fundingBank.id;
}

// ---------------------------------------------------------------------------
// Step 3: Create counterparty, ledger account, and recipient wallet
// ---------------------------------------------------------------------------
async function step3_setupEntities(payout: Payout, tenantId?: string): Promise<VariantEntities> {
  // The customer owns the ledger; the beneficiary, an individual or a business, owns the wallet.
  const customer = await createBusinessCounterparty({ tenantId });
  const beneficiary =
    Math.random() > 0.5
      ? await createIndividualCounterparty({ tenantId })
      : await createBusinessCounterparty({ tenantId });

  const ledgerName = `${customer.name}'s Ledger`;
  const ledgerAccountId = await createCircleLedger({ counterpartyId: customer.id, name: ledgerName });

  const walletName = `${beneficiary.name}'s Wallet`;
  const walletAccountId = await createUnmanagedWallet({ counterpartyId: beneficiary.id, name: walletName, payout });

  return {
    customerCounterpartyId: customer.id, customerCounterpartyName: customer.name,
    beneficiaryCounterpartyId: beneficiary.id, beneficiaryCounterpartyName: beneficiary.name,
    ledgerAccountId, ledgerName, walletAccountId, walletName,
  };
}

// ---------------------------------------------------------------------------
// Step 3b: Wait for the ledger's Circle compliance to be accepted
// ---------------------------------------------------------------------------
async function step3b_waitForCompliance(ledgerAccountId: string, counterpartyId: string): Promise<void> {
  const start = Date.now();
  await waitForLedgerCompliance({ ledgerAccountId, counterpartyId });
  console.log(pc.green(`  Compliance accepted after ${Math.round((Date.now() - start) / 1000)}s`));
}

// ---------------------------------------------------------------------------
// Step 4: Create deposit (USD → USDC into ledger account)
// ---------------------------------------------------------------------------
async function step4_createDeposit(
  fromAccountId: string,
  toAccountId: string,
  amount: string,
  reference: string,
): Promise<string> {
  return createDeposit({ fromAccountId, toAccountId, amount, fromCurrency: "USD", toCurrency: "USDC", reference });
}

// ---------------------------------------------------------------------------
// Step 4b: Wait for the deposit to be planned
// ---------------------------------------------------------------------------
async function step4b_waitForDepositPlan(depositId: string): Promise<void> {
  const steps = await waitForDepositPlan(depositId);
  console.log(`  Planned: ${stepSummary(steps)}`);
}

// ---------------------------------------------------------------------------
// Step 5: Simulate deposit via Tesser sandbox endpoint
// ---------------------------------------------------------------------------
async function step5_simulateDeposit(depositId: string): Promise<void> {
  const deposit = await simulateWire(depositId);
  console.log(`  Simulated: ${stepSummary(deposit.steps ?? [])}`);
}

// ---------------------------------------------------------------------------
// Step 5b: Wait for the deposit to complete and check the ledger balance
// ---------------------------------------------------------------------------
async function step5b_waitForDepositCompletion(
  depositId: string,
  ledgerAccountId: string,
  amount: string,
): Promise<void> {
  await waitForDepositCompletion(depositId);
  // The ledger is new for this run, so it should hold exactly the deposit.
  const balance = await waitForBalance({ accountId: ledgerAccountId, currency: "USDC", amount });
  console.log(pc.green(`  Ledger funded: ${balance} USDC`));
}

// ---------------------------------------------------------------------------
// Step 6: Create payment (ledger → recipient wallet)
// ---------------------------------------------------------------------------
async function step6_createPayment(
  ledgerAccountId: string,
  walletAccountId: string,
  amount: string,
  network: string,
  reference: string,
): Promise<string> {
  return createPayment({
    fundingAccountId: ledgerAccountId,
    fromAccountId: ledgerAccountId,
    toAccountId: walletAccountId,
    amount,
    currency: "USDC",
    network,
    reference,
  });
}

// ---------------------------------------------------------------------------
// Step 7: Wait for the payment to complete
// ---------------------------------------------------------------------------
// The E2E approves a payment held for risk review; a rejection or a failed
// step fails the run. Done when every step is completed.
async function step7_waitForPayment(paymentId: string): Promise<Payment> {
  return waitForPayment(paymentId, {
    decide: async () => true,
    reason: "Approved by the api-demo E2E run",
  });
}

// ---------------------------------------------------------------------------
// Run steps 3–7 for a given variant
// ---------------------------------------------------------------------------
interface VariantEntities {
  customerCounterpartyId: string;
  customerCounterpartyName: string;
  beneficiaryCounterpartyId: string;
  beneficiaryCounterpartyName: string;
  ledgerAccountId: string;
  ledgerName: string;
  walletAccountId: string;
  walletName: string;
}

async function runStep3(payout: Payout, tenantId?: string): Promise<VariantEntities> {
  console.log(pc.bold("\n[Step 3] Creating counterparty, ledger, wallet, and bank account..."));
  const entities = await step3_setupEntities(payout, tenantId);
  console.log(`  Customer counterparty:          ${entities.customerCounterpartyName} ${pc.dim(`(${entities.customerCounterpartyId})`)}`);
  console.log(`  Beneficiary counterparty:       ${entities.beneficiaryCounterpartyName} ${pc.dim(`(${entities.beneficiaryCounterpartyId})`)}`);
  console.log(`  Customer ledger (Circle):       ${entities.ledgerName} ${pc.dim(`(${entities.ledgerAccountId})`)}`);
  console.log(`  Beneficiary wallet (unmanaged): ${entities.walletName} ${pc.dim(`(${entities.walletAccountId})`)}`);
  return entities;
}

async function runSteps4Through7(
  variant: string,
  entities: VariantEntities,
  bankAccountId: string,
  payout: Payout,
): Promise<void> {
  const { ledgerAccountId, walletAccountId, customerCounterpartyId } = entities;
  // Circle matches a simulated wire to its deposit by exact amount, so each
  // deposit gets its own random amount.
  const depositAmount = (90 + Math.random() * 20).toFixed(2);
  const paymentAmount = (1 + Math.random()).toFixed(2);
  const reference = `e2e-${RUN_ID}-${variant}`;

  console.log(pc.bold("\n[Step 3b] Waiting for ledger compliance..."));
  await step3b_waitForCompliance(ledgerAccountId, customerCounterpartyId);

  console.log(pc.bold(`\n[Step 4] Creating deposit (${depositAmount} USD → USDC)...`));
  const depositId = await step4_createDeposit(bankAccountId, ledgerAccountId, depositAmount, `${reference}-deposit`);
  console.log(`  Deposit ID: ${pc.cyan(depositId)}`);

  console.log(pc.bold("\n[Step 4b] Waiting for the deposit to be planned..."));
  await step4b_waitForDepositPlan(depositId);

  console.log(pc.bold("\n[Step 5] Simulating deposit..."));
  await step5_simulateDeposit(depositId);

  console.log(pc.bold("\n[Step 5b] Waiting for the deposit to complete..."));
  console.log(`  Ledger account:  ${pc.cyan(ledgerAccountId)}`);
  await step5b_waitForDepositCompletion(depositId, ledgerAccountId, depositAmount);

  console.log(pc.bold(`\n[Step 6] Creating payment (${paymentAmount} USDC on ${payout.network})...`));
  const paymentId = await step6_createPayment(
    ledgerAccountId,
    walletAccountId,
    paymentAmount,
    payout.network,
    `${reference}-payment`,
  );
  console.log(`  Payment ID: ${pc.cyan(paymentId)}`);

  console.log(pc.bold("\n[Step 7] Waiting for the payment to complete..."));
  const payment = await step7_waitForPayment(paymentId);
  for (const s of payment.steps) {
    console.log(pc.green(`  step${s.step_sequence} completed at ${s.completed_at}  ${pc.dim(s.transaction_hash ?? "")}`));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const payout = payoutConfig();

  console.log(sep());
  console.log(pc.bold("  Tesser API E2E Demo"));
  console.log(sep());
  console.log(`  Debug mode: ${DEBUG ? pc.yellow("ON") : pc.dim("OFF")}`);
  console.log(`  Run ID:     ${pc.cyan(RUN_ID)}`);
  console.log(`  Payout:     USDC on ${pc.cyan(payout.network)} to ${pc.dim(payout.address)}`);

  console.log(pc.bold("\n[Step 1] Authenticating..."));
  await step1_authenticate();

  console.log(pc.bold("\n[Step 1.5] Storing Circle Mint API key in vault..."));
  await step1_5_storeCircleMintKey();

  console.log(pc.bold("\n[Step 1.6] Checking the Circle setup..."));
  await step1_6_preflight();

  console.log(pc.bold("\n[Step 2] Fetching current state..."));
  const bankAccountId = await step2_displayCurrentState();

  const enableVariants = (process.env.ENABLE_VARIANTS || "BOTH").toUpperCase();
  const runA = enableVariants === "A" || enableVariants === "BOTH";
  const runB = enableVariants === "B" || enableVariants === "BOTH";

  let variantA: VariantEntities | undefined;
  let variantB: VariantEntities | undefined;

  // --- Variant A: Org-level (no tenant) ---
  if (runA) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant A: Org-level")));
    console.log(sep());
    variantA = await runStep3(payout);
  }

  // --- Variant B: Tenant-level ---
  if (runB) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant B: Tenant-level")));
    console.log(sep());

    console.log(pc.bold("\n[Tenant] Creating tenant..."));
    const tenant = await createTenant();
    console.log(`  Tenant: ${tenant.name} ${pc.dim(`(${tenant.id})`)}`);

    variantB = await runStep3(payout, tenant.id);
  }

  // --- Run steps 3b–7 for each variant ---
  if (runA && variantA) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant A: Steps 3b–7")));
    console.log(sep());
    await runSteps4Through7("A", variantA, bankAccountId, payout);
  }

  if (runB && variantB) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant B: Steps 3b–7")));
    console.log(sep());
    await runSteps4Through7("B", variantB, bankAccountId, payout);
  }

  console.log(`\n${sep()}`);
  console.log(pc.bold(pc.green("  Demo complete")));
  console.log(sep());
}

main().catch((err) => {
  console.error(pc.red(`\nDemo failed: ${err.message}`));
  process.exit(1);
});
