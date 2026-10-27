import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { ApiError, authenticate, get, getAll, post, DEBUG } from "./src/client.ts";
import { poll, postWithRetry } from "./src/retry.ts";
import type { Account, Deposit, Envelope, Leg, Payment, Step } from "./src/types.ts";
import type {
  CounterpartyListResponse,
  TenantListResponse,
} from "@tesser-payments/types";

const sep = () => pc.dim("─".repeat(60));

// Tags this run's deposits and payments (organization_reference_id).
const RUN_ID = crypto.randomUUID().slice(0, 8);

const CIRCLE_SANDBOX_URL = "https://api-sandbox.circle.com";

// ---------------------------------------------------------------------------
// Payout network and beneficiary address
// ---------------------------------------------------------------------------
// Defaults known to work on sandbox: the Stellar address has a USDC trustline,
// and the EVM address is the documented sandbox risk-test address that is
// always automatically approved.
const DEFAULT_BENEFICIARY_ADDRESS = {
  stablecoin_stellar: "GCE5TKW3KAJJB3DPKXFWRIAKJEVOW6BDFGO6R4NRWS2JSZWRYNB2NKQG",
  stablecoin_ethereum: "0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f",
};

const ADDRESS_FORMAT = {
  stablecoin_stellar: /^G[A-Z2-7]{55}$/,
  stablecoin_ethereum: /^0x[0-9a-fA-F]{40}$/,
};

type WalletType = keyof typeof DEFAULT_BENEFICIARY_ADDRESS;

interface Payout {
  network: string;
  walletType: WalletType;
  address: string;
}

function payoutConfig(): Payout {
  const network = (process.env.PAYMENT_NETWORK || "STELLAR").toUpperCase();
  if (network.startsWith("SOLANA")) {
    throw new Error(`PAYMENT_NETWORK=${network} isn't supported here; use STELLAR or an EVM network`);
  }
  const walletType: WalletType = network.startsWith("STELLAR") ? "stablecoin_stellar" : "stablecoin_ethereum";
  const address = process.env.BENEFICIARY_WALLET_ADDRESS || DEFAULT_BENEFICIARY_ADDRESS[walletType];
  if (!ADDRESS_FORMAT[walletType].test(address)) {
    const family = walletType === "stablecoin_stellar" ? "a Stellar" : "an EVM";
    throw new Error(`BENEFICIARY_WALLET_ADDRESS isn't ${family} address, but PAYMENT_NETWORK=${network}`);
  }
  return { network, walletType, address };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const formatLeg = (leg: Leg) =>
  [leg.amount, leg.currency, leg.network && pc.dim(leg.network)].filter(Boolean).join(" ");

const stepSummary = (steps: Step[]) =>
  steps.map((s) => `step${s.step_sequence}=${s.status}`).join(", ") || "no steps yet";

const toCents = (amount: string) => Math.round(parseFloat(amount) * 100);

function assertNoFailedStep(kind: string, steps: Step[]): void {
  const failed = steps.find((s) => s.status === "failed");
  if (!failed) return;
  const reasons = failed.status_reasons
    ?.map((r) => `${r.error_code}: ${r.error_message}`)
    .join("; ");
  throw new Error(`${kind} step ${failed.step_sequence} failed: ${reasons || "no reason given"}`);
}

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

  try {
    const result = await post<{ success: boolean; masked_value: string }>(
      "/v1/organizations/secrets",
      {
        provider: "CIRCLE_MINT",
        key: "CIRCLE_MINT_API_KEY",
        value: apiKey,
      },
    );
    console.log(`  Success:       ${result.success}`);
    console.log(`  Masked value:  ${result.masked_value}`);
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.hasCode("organizations-0009") || err.message.includes("already configured"))
    ) {
      console.log(pc.dim("  Already configured — continuing"));
      return;
    }
    // The request body carries the key; keep it out of the error output.
    if (err instanceof Error) err.message = err.message.replaceAll(apiKey, "<redacted>");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 1.6: Preflight — Circle is connected and has a linked wire bank
// ---------------------------------------------------------------------------
// Both are set up outside the Tesser API. Without them the flow fails late and
// opaquely: ledger creation returns a 502, or the deposit is never planned.
async function step1_6_preflight(): Promise<void> {
  const ledgers = await getAll<Account>("/v1/accounts?type=ledger");
  const master = ledgers.find((a) => a.provider === "CIRCLE_MINT" && a.created_by === "SYSTEM");
  if (!master) {
    throw new Error(
      "Circle isn't connected to this workspace (no Circle master ledger). Set CIRCLE_API_KEY so step 1.5 can store it.",
    );
  }
  console.log(`  Circle master ledger: ${master.name} ${pc.dim(`(${master.id})`)}`);

  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.log(pc.yellow("  ⚠️  CIRCLE_API_KEY not set — can't check the Circle wire bank"));
    return;
  }

  const url = `${CIRCLE_SANDBOX_URL}/v1/businessAccount/banks/wires`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status})\n  Response: ${await res.text()}`);
  }
  const { data: banks = [] } = (await res.json()) as {
    data?: { id: string; status: string; description?: string }[];
  };

  // The platform uses the first wire bank Circle lists.
  const bank = banks[0];
  if (!bank) {
    throw new Error(
      "The Circle account behind CIRCLE_API_KEY has no linked wire bank, so deposits can't be planned. " +
        "Link one in Circle (sandbox: POST /v1/businessAccount/banks/wires).",
    );
  }
  if (bank.status !== "complete") {
    throw new Error(`The Circle wire bank ${bank.id} is "${bank.status}", not "complete", so deposits can't be planned yet.`);
  }
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

  // Find pre-existing org-level fiat bank account (unmanaged, no tenant, no counterparty)
  const fundingBank = allAccounts.find(
    (a) => a.type === "fiat_bank" && !a.is_managed && !a.tenant_id && !a.counterparty_id,
  );
  if (fundingBank) {
    console.log(`  Funding bank:   ${fundingBank.name} ${pc.dim(`(${fundingBank.id})`)}`);
    return fundingBank.id;
  }
  const newBank = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name: "Depositing Bank",
    bank_name: "Hancock Whitney Bank",
    bank_code_type: "ROUTING",
    bank_identifier_code: "065400153",
    bank_account_number: "000999999991",
    tenant_id: null,
    counterparty_id: null,
    bank_swift_code: "BARCGB22",
  });
  console.log(`  Funding bank:   ${pc.yellow("(created)")} Depositing Bank ${pc.dim(`(${newBank.data.id})`)}`);
  return newBank.data.id;
}

// ---------------------------------------------------------------------------
// Step 3: Create counterparty, ledger account, and recipient wallet
// ---------------------------------------------------------------------------
async function step3_setupEntities(payout: Payout, tenantId?: string): Promise<VariantEntities> {
  // 1. Create customer counterparty (business — owns ledger + bank)
  const customerName = faker.company.name();
  const customer = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "business",
      business_legal_name: customerName,
      business_dba: customerName,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
      ...(tenantId && { tenant_id: tenantId }),
    },
  );
  const customerCounterpartyId = customer.data.id;

  // 2. Create beneficiary counterparty (individual or business — owns wallet)
  const isIndividual = Math.random() > 0.5;
  let beneficiaryName: string;
  let beneficiaryPayload: Record<string, unknown>;

  if (isIndividual) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    beneficiaryName = `${firstName} ${lastName}`;
    beneficiaryPayload = {
      classification: "individual",
      individual_first_name: firstName,
      individual_last_name: lastName,
      individual_address_country: "US",
      individual_street_address1: faker.location.streetAddress(),
      individual_city: faker.location.city(),
      individual_state: faker.location.state({ abbreviated: true }),
      individual_postal_code: faker.location.zipCode(),
    };
  } else {
    beneficiaryName = faker.company.name();
    beneficiaryPayload = {
      classification: "business",
      business_legal_name: beneficiaryName,
      business_dba: beneficiaryName,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
    };
  }

  const beneficiary = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    { ...beneficiaryPayload, ...(tenantId && { tenant_id: tenantId }) },
  );
  const beneficiaryCounterpartyId = beneficiary.data.id;

  // 3. Create ledger account (Circle Mint funding source — customer)
  const ledgerName = `${customerName}'s Ledger`;
  const ledger = await post<{ data: { id: string } }>("/v1/accounts/ledgers", {
    name: ledgerName,
    provider: "CIRCLE_MINT",
    counterparty_id: customerCounterpartyId,
  });
  const ledgerAccountId = ledger.data.id;

  // 4. Create unmanaged recipient wallet (beneficiary). A Stellar address must
  // have a USDC trustline to receive USDC.
  const walletName = `${beneficiaryName}'s Wallet`;
  const wallet = await post<{ data: { id: string } }>(
    "/v1/accounts/wallets",
    {
      name: walletName,
      type: payout.walletType,
      is_managed: false,
      wallet_address: payout.address,
      counterparty_id: beneficiaryCounterpartyId,
    },
  );
  const walletAccountId = wallet.data.id;

  return {
    customerCounterpartyId, customerCounterpartyName: customerName,
    beneficiaryCounterpartyId, beneficiaryCounterpartyName: beneficiaryName,
    ledgerAccountId, ledgerName, walletAccountId, walletName,
  };
}

// ---------------------------------------------------------------------------
// Step 3b: Wait for the ledger's Circle compliance to be accepted
// ---------------------------------------------------------------------------
// Deposits into the ledger are rejected (treasury-3103) until then. The
// platform checks after 10s, retries 5 times 30s apart, then every 30 min.
async function step3b_waitForCompliance(ledgerAccountId: string, counterpartyId: string): Promise<void> {
  const start = Date.now();
  await poll(
    "Ledger compliance",
    async () => {
      const res = await get<{ data: Account[] }>(
        `/v1/accounts?type=ledger&counterparty_id=${counterpartyId}&compliance_accepted=true`,
      );
      return res.data.some((a) => a.id === ledgerAccountId) ? true : undefined;
    },
    {
      timeoutMs: 35 * 60_000,
      timeoutHint: "Circle compliance is still PENDING; after its first checks the platform only rechecks every 30 min",
    },
  );
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
  const deposit = await postWithRetry<Envelope<Deposit>>("Deposit", "/v1/treasury/deposits", {
    organization_reference_id: reference,
    desired: {
      from: {
        account_id: fromAccountId,
        amount,
        currency: "USD",
      },
      to: {
        account_id: toAccountId,
        currency: "USDC",
      },
    },
  });
  return deposit.data.id;
}

// ---------------------------------------------------------------------------
// Step 4b: Wait for the deposit to be planned
// ---------------------------------------------------------------------------
// Planning runs asynchronously; until it does, the deposit has no steps and
// simulate fails with treasury-3101.
async function step4b_waitForDepositPlan(depositId: string): Promise<void> {
  const steps = await poll(
    "Deposit planning",
    async () => {
      const { data } = await get<Envelope<Deposit>>(`/v1/treasury/deposits/${depositId}`);
      const steps = data.steps ?? [];
      assertNoFailedStep("Deposit", steps);
      return steps.length > 0 ? steps : undefined;
    },
    {
      timeoutMs: 2 * 60_000,
      intervalMs: 5_000,
      timeoutHint:
        "The deposit was never planned and the API gives no reason. The usual cause is a Circle account with no linked wire bank",
    },
  );
  console.log(`  Planned: ${stepSummary(steps)}`);
}

// ---------------------------------------------------------------------------
// Step 5: Simulate deposit via Tesser sandbox endpoint
// ---------------------------------------------------------------------------
async function step5_simulateDeposit(depositId: string): Promise<void> {
  // Idempotency-Key: a retried simulate must not send the mock wire twice.
  const res = await postWithRetry<Envelope<Deposit>>(
    "Simulate",
    `/v1/treasury/deposits/${depositId}/simulate`,
    {},
  );
  console.log(`  Simulated: ${stepSummary(res.data.steps ?? [])}`);
}

// ---------------------------------------------------------------------------
// Step 5b: Wait for the deposit to complete and check the ledger balance
// ---------------------------------------------------------------------------
// Circle settles the simulated wire asynchronously via webhook.
async function step5b_waitForDepositCompletion(
  depositId: string,
  ledgerAccountId: string,
  amount: string,
): Promise<void> {
  let last = "";
  await poll(
    "Deposit settlement",
    async () => {
      const { data } = await get<Envelope<Deposit>>(`/v1/treasury/deposits/${depositId}`);
      const steps = data.steps ?? [];
      assertNoFailedStep("Deposit", steps);
      const summary = stepSummary(steps);
      if (summary !== last) console.log(pc.yellow(`  Deposit: ${summary}`));
      last = summary;
      return steps.length > 0 && steps.every((s) => s.status === "completed") ? true : undefined;
    },
    {
      timeoutMs: 10 * 60_000,
      timeoutHint: "Circle settles the simulated wire by webhook; check the Circle webhook subscription for this environment",
    },
  );

  // The ledger is new for this run, so it should hold exactly the deposit.
  const balance = await poll(
    "Ledger balance",
    async () => {
      const { data } = await get<Envelope<Account>>(`/v1/accounts/${ledgerAccountId}`);
      const available = data.assets?.find((a) => a.currency === "USDC")?.available_balance ?? "0";
      if (toCents(available) > toCents(amount)) {
        throw new Error(`Ledger holds ${available} USDC, more than the ${amount} deposited`);
      }
      return toCents(available) === toCents(amount) ? available : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 5_000, timeoutHint: `expected ${amount} USDC in the ledger` },
  );
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
  const payment = await postWithRetry<Envelope<Payment>>(
    "Payment",
    "/v1/payments",
    {
      organization_reference_id: reference,
      // The funding account must belong to a counterparty or tenant; the
      // counterparty's own ledger qualifies.
      funding_account_id: ledgerAccountId,
      desired: {
        from: {
          account_id: ledgerAccountId,
          amount,
          currency: "USDC",
          network,
        },
        to: {
          account_id: walletAccountId,
          currency: "USDC",
          network,
        },
      },
    },
    // payments-3017: the beneficiary's Circle recipient isn't active yet
    { retryOn: ["payments-3017"], attempts: 30 },
  );
  return payment.data.id;
}

// ---------------------------------------------------------------------------
// Step 7: Wait for the payment to complete
// ---------------------------------------------------------------------------
// Approves a payment held for risk review once, and fails fast on a risk
// rejection or a failed step. Done when every step is completed.
async function step7_waitForPayment(paymentId: string): Promise<Payment> {
  const reviewKey = crypto.randomUUID();
  let reviewed = false;
  let last = "";
  return poll(
    "Payment",
    async () => {
      const { data: payment } = await get<Envelope<Payment>>(`/v1/payments/${paymentId}`);
      const summary = `risk=${payment.risk_status ?? "-"}  balance=${payment.balance_status ?? "-"}  ${stepSummary(payment.steps)}`;
      if (summary !== last) console.log(pc.yellow(`  ${summary}`));
      last = summary;

      if (payment.risk_status === "automatically_rejected" || payment.risk_status === "manually_rejected") {
        throw new Error(`Payment ${paymentId} was rejected by risk screening (${payment.risk_status})`);
      }
      if (payment.risk_status === "awaiting_decision" && !reviewed) {
        await post(
          `/v1/payments/${paymentId}/review`,
          { is_approved: true, reason: "Approved by the api-demo E2E run" },
          { idempotencyKey: reviewKey },
        );
        reviewed = true;
        console.log(pc.dim("  Risk review: approved"));
        return undefined;
      }

      assertNoFailedStep("Payment", payment.steps);
      const done = payment.steps.length > 0 && payment.steps.every((s) => s.status === "completed");
      return done ? payment : undefined;
    },
    { timeoutMs: 10 * 60_000 },
  );
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
    const tenantName = faker.company.name();
    const tenant = await post<{ data: { tenant: { id: string } } }>(
      "/v1/entities/tenants",
      {
        business_legal_name: tenantName,
        business_dba: tenantName,
        business_address_country: "US",
        business_street_address1: faker.location.streetAddress(),
        business_city: faker.location.city(),
        business_state: faker.location.state({ abbreviated: true }),
        business_postal_code: faker.location.zipCode(),
        business_legal_entity_identifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
      },
    );
    const tenantId = tenant.data.tenant.id;
    console.log(`  Tenant: ${tenantName} ${pc.dim(`(${tenantId})`)}`);

    variantB = await runStep3(payout, tenantId);
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
