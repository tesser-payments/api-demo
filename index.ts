import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, post } from "./src/client.ts";
import { pRetry, AbortError, retryOpts } from "./src/retry.ts";
import type {
  IAccount,
  CounterpartyListResponse,
  TenantListResponse,
  PaginatedResponse,
  IPayment,
} from "@tesser-payments/types";

const sep = () => pc.dim("─".repeat(60));

// ---------------------------------------------------------------------------
// Step 1: Authenticate
// ---------------------------------------------------------------------------
async function step1_authenticate(): Promise<void> {
  const token = await authenticate();
  console.log(`  Token: ${pc.dim(token.slice(0, 20) + "..." + token.slice(-8))}`);
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

  const counterparties = await get<CounterpartyListResponse>("/v1/entities/counterparties");
  console.log(`  Counterparties: ${pc.bold(String(counterparties.data.length))}`);
  for (const c of counterparties.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(c.id)}  ${c.classification}  ${c.name}`);
  }

  const accounts = await get<PaginatedResponse<IAccount>>("/v1/accounts");
  console.log(`  Accounts:       ${pc.bold(String(accounts.data.length))}`);
  for (const a of accounts.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(a.id)}  type=${a.type}  name=${a.name}`);
  }

  const tenants = await get<TenantListResponse>("/v1/entities/tenants");
  console.log(`  Tenants:        ${pc.bold(String(tenants.data.length))}`);
  for (const t of tenants.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(t.id)}  ${t.name}`);
  }

  const payments = await get<PaginatedResponse<IPayment>>("/v1/payments");
  console.log(`  Payments:       ${pc.bold(String(payments.data.length))}`);
  for (const p of payments.data) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(p.id)}  ${p.direction}  ${p.fromAmount} ${p.fromCurrency} → ${p.toAmount} ${p.toCurrency}`);
  }

  // Find pre-existing org-level fiat bank account (unmanaged, no tenant, no counterparty)
  const fundingBank = accounts.data.find(
    (a) => a.type === "fiat_bank" && a.isManaged === false && !a.tenantId && !a.counterpartyId,
  );
  if (fundingBank) {
    console.log(`  Funding bank:   ${fundingBank.name} ${pc.dim(`(${fundingBank.id})`)}`);
    return fundingBank.id;
  }
  const fallbackId = process.env.FALLBACK_FUNDING_BANK_ACCOUNT_ID;
  if (!fallbackId) {
    throw new Error("No fiat_bank account found and FALLBACK_FUNDING_BANK_ACCOUNT_ID is not set");
  }
  console.log(`  Funding bank:   ${pc.yellow("(fallback)")} ${pc.dim(fallbackId)}`);
  return fallbackId;
}

// ---------------------------------------------------------------------------
// Step 3: Create counterparty, ledger account, and recipient wallet
// ---------------------------------------------------------------------------
async function step3_setupEntities(tenantId?: string): Promise<{
  customerCounterpartyId: string;
  customerCounterpartyName: string;
  beneficiaryCounterpartyId: string;
  beneficiaryCounterpartyName: string;
  ledgerAccountId: string;
  ledgerName: string;
  walletAccountId: string;
  walletName: string;
}> {
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

  // 4. Create unmanaged recipient wallet (beneficiary)
  const walletName = `${beneficiaryName}'s Wallet`;
  const wallet = await post<{ data: { id: string } }>(
    "/v1/accounts/wallets",
    {
      name: walletName,
      type: "stablecoin_stellar",
      is_managed: false,
      wallet_address: process.env.BENEFICIARY_WALLET_ADDRESS || "G" + faker.string.fromCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 55),
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
// Step 4: Create deposit (USD → USDC into ledger account)
// ---------------------------------------------------------------------------
async function step4_createDeposit(
  fromAccountId: string,
  toAccountId: string,
  amount: string,
): Promise<{ depositId: string; instructions: Record<string, unknown> }> {
  const deposit = await pRetry(
    () =>
      post<{ data: { id: string } }>("/v1/treasury/deposits", {
        from_currency: "USD",
        to_currency: "USDC",
        from_amount: amount,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
      }),
    retryOpts("Deposit"),
  );

  const depositId = deposit.data.id;

  const instructions = await pRetry(
    () =>
      get<{ data: Record<string, unknown> }>(
        `/v1/treasury/deposits/${depositId}/instructions`,
      ),
    retryOpts("Instructions"),
  );

  console.log("  Deposit instructions:", JSON.stringify(instructions.data, null, 2));
  return { depositId, instructions: instructions.data };
}

// ---------------------------------------------------------------------------
// Step 5: Simulate deposit via Circle sandbox mock wire
// ---------------------------------------------------------------------------
async function step5_simulateDeposit(instructions: Record<string, unknown>, amount: string): Promise<void> {
  const circleApiKey = process.env.CIRCLE_API_KEY;
  if (!circleApiKey) throw new Error("CIRCLE_API_KEY is not set");

  const toAccount = (instructions.to_account ?? instructions.toAccount) as Record<string, unknown>;
  const trackingRef = toAccount.tracking_reference ?? toAccount.trackingRef ?? (toAccount.metadata as Record<string, unknown>)?.trackingRef;
  const accountNumber = toAccount.bank_account_number ?? toAccount.accountNumber;
  const body = {
    trackingRef,
    amount: { amount, currency: "USD" },
    beneficiaryBank: { accountNumber },
  };
  console.log("  Mock wire request:", JSON.stringify(body, null, 2));

  const res = await fetch("https://api-sandbox.circle.com/v1/mocks/payments/wire", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${circleApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Circle mock wire failed (${res.status})\n  Response: ${text}`);
  }

  const json = await res.json();
  console.log("  Mock wire response:", JSON.stringify(json, null, 2));
}

// ---------------------------------------------------------------------------
// Step 6: Create payment (ledger → recipient wallet, 0.01 USDC)
// ---------------------------------------------------------------------------
async function step6_createPayment(
  fundingAccountId: string,
  fromAccountId: string,
  toAccountId: string,
  amount: string,
): Promise<string> {
  const resolvedToAccountId = process.env.BENEFICIARY_ACCOUNT_ID || toAccountId;
  if (process.env.BENEFICIARY_ACCOUNT_ID) {
    console.log(`  Using BENEFICIARY_ACCOUNT_ID: ${pc.cyan(resolvedToAccountId)}`);
  }

  const payment = await pRetry(
    () =>
      post<{ data: { id: string } }>("/v1/payments", {
        direction: "outbound",
        funding_account_id: fundingAccountId,
        from_account_id: fromAccountId,
        to_account_id: resolvedToAccountId,
        from_amount: amount,
        from_currency: "USDC",
        to_currency: "USDC",
        to_network: "STELLAR",
      }),
    retryOpts("Payment"),
  );
  return payment.data.id;
}

// ---------------------------------------------------------------------------
// Step 7: Poll payment until complete
// ---------------------------------------------------------------------------
async function step7_pollPaymentCompletion(paymentId: string): Promise<void> {
  await pRetry(
    async () => {
      const payment = await get<{ data: IPayment }>(`/v1/payments/${paymentId}`);
      const steps = payment.data.steps ?? [];

      const failedStep = steps.find((s) => s.status === "failed");
      if (failedStep) {
        throw new AbortError(
          `Step ${failedStep.stepSequence} failed: ${failedStep.statusReasons}`,
        );
      }

      const stepStatuses = steps
        .map((s) => `step${s.stepSequence}=${s.status}`)
        .join(", ");
      console.log(pc.yellow(`  Poll: ${stepStatuses}`));

      if (steps.length >= 1 && steps[0]?.finalizedAt) {
        console.log(pc.green(`  First step finalized at ${steps[0]!.finalizedAt}`));
        return;
      }

      throw new Error("Payment not yet finalized");
    },
    retryOpts("Poll"),
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

async function runStep3(tenantId?: string): Promise<VariantEntities> {
  console.log(pc.bold("\n[Step 3] Creating counterparty, ledger, wallet, and bank account..."));
  const entities = await step3_setupEntities(tenantId);
  console.log(`  Customer counterparty:          ${entities.customerCounterpartyName} ${pc.dim(`(${entities.customerCounterpartyId})`)}`);
  console.log(`  Beneficiary counterparty:       ${entities.beneficiaryCounterpartyName} ${pc.dim(`(${entities.beneficiaryCounterpartyId})`)}`);
  console.log(`  Customer ledger (Circle):       ${entities.ledgerName} ${pc.dim(`(${entities.ledgerAccountId})`)}`);
  console.log(`  Beneficiary wallet (unmanaged): ${entities.walletName} ${pc.dim(`(${entities.walletAccountId})`)}`);
  return entities;
}

async function runSteps4Through7(
  entities: VariantEntities,
  bankAccountId: string,
  depositAmount: string,
  paymentAmount: string,
): Promise<void> {
  const { ledgerAccountId, walletAccountId } = entities;

  console.log(pc.bold(`\n[Step 4] Creating deposit (${depositAmount} USD → USDC)...`));
  const { depositId, instructions } = await step4_createDeposit(bankAccountId, ledgerAccountId, depositAmount);
  console.log(`  Deposit ID: ${pc.cyan(depositId)}`);

  console.log(pc.bold("\n[Step 5] Simulating deposit via Circle mock wire..."));
  await step5_simulateDeposit(instructions, depositAmount);

  console.log(pc.bold(`\n[Step 6] Creating payment (${paymentAmount} USDC)...`));
  // const paymentId = await step6_createPayment(
  //   bankAccountId,
  //   ledgerAccountId,
  //   walletAccountId,
  //   paymentAmount,
  // );

  const paymentId = await step6_createPayment(
    bankAccountId,
    "3ee1e340-bbb9-413c-831b-30c2b8d11a53",
    "9329f4e2-bc2a-4cdf-9220-42ee881b444a",
    "1.03",
  );
  console.log(`  Payment ID: ${pc.cyan(paymentId)}`);

  console.log(pc.bold("\n[Step 7] Polling payment until complete..."));
  await step7_pollPaymentCompletion(paymentId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(sep());
  console.log(pc.bold("  Tesser API E2E Demo"));
  console.log(sep());

  console.log(pc.bold("\n[Step 1] Authenticating..."));
  await step1_authenticate();

  console.log(pc.bold("\n[Step 2] Fetching current state..."));
  const bankAccountId = await step2_displayCurrentState();

  const depositAmount = (90 + Math.random() * 20).toFixed(2);
  const paymentAmount = (1 + Math.random()).toFixed(2);
  console.log(`\n  Deposit amount: ${pc.cyan(`${depositAmount} USD`)}`);
  console.log(`  Payment amount: ${pc.cyan(`${paymentAmount} USDC`)}`);

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
    variantA = await runStep3();
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
        business_legal_entity_identifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
      },
    );
    const tenantId = tenant.data.tenant.id;
    console.log(`  Tenant: ${tenantName} ${pc.dim(`(${tenantId})`)}`);

    variantB = await runStep3(tenantId);
  }

  // --- Run steps 4–7 for each variant ---
  if (runA && variantA) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant A: Steps 4–7")));
    console.log(sep());
    await runSteps4Through7(variantA, bankAccountId, depositAmount, paymentAmount);
  }

  if (runB && variantB) {
    console.log(`\n${sep()}`);
    console.log(pc.bold(pc.magenta("  Variant B: Steps 4–7")));
    console.log(sep());
    await runSteps4Through7(variantB, bankAccountId, depositAmount, paymentAmount);
  }

  console.log(`\n${sep()}`);
  console.log(pc.bold(pc.green("  Demo complete")));
  console.log(sep());
}

main().catch((err) => {
  console.error(pc.red(`\nDemo failed: ${err.message}`));
  process.exit(1);
});
