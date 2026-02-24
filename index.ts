import { faker } from "@faker-js/faker";
import { authenticate, get, post } from "./src/client.ts";
import type {
  IAccount,
  CounterpartyListResponse,
  TenantListResponse,
  PaginatedResponse,
  IPayment,
} from "@tesser-payments/types";

// ---------------------------------------------------------------------------
// Step 1: Authenticate
// ---------------------------------------------------------------------------
async function step1_authenticate(): Promise<void> {
  const token = await authenticate();
  console.log(`  Token: ${token.slice(0, 20)}...${token.slice(-8)}`);
}

// ---------------------------------------------------------------------------
// Step 2: Display current state (all list endpoints)
// ---------------------------------------------------------------------------
async function step2_displayCurrentState(): Promise<void> {
  const currencies = await get<{ data: { name: string; key: string; decimals: number; network: string | null }[] }>("/v1/currencies");
  console.log(`  Currencies:     ${currencies.data.length}`);
  for (const c of currencies.data) {
    console.log(`    - ${c.key} (${c.name})`);
  }

  const networks = await get<{ data: { name: string; key: string }[] }>("/v1/networks");
  console.log(`  Networks:       ${networks.data.length}`);
  for (const n of networks.data) {
    console.log(`    - ${n.key} (${n.name})`);
  }

  const counterparties = await get<CounterpartyListResponse>("/v1/entities/counterparties");
  console.log(`  Counterparties: ${counterparties.data.length}`);
  for (const c of counterparties.data) {
    console.log(`    - ${c.id}  ${c.classification}  ${c.name}`);
  }

  const accounts = await get<PaginatedResponse<IAccount>>("/v1/accounts");
  console.log(`  Accounts:       ${accounts.data.length}`);
  for (const a of accounts.data) {
    console.log(`    - ${a.id}  type=${a.type}  name=${a.name}`);
  }

  const tenants = await get<TenantListResponse>("/v1/entities/tenants");
  console.log(`  Tenants:        ${tenants.data.length}`);
  for (const t of tenants.data) {
    console.log(`    - ${t.id}  ${t.name}`);
  }

  const payments = await get<PaginatedResponse<IPayment>>("/v1/payments");
  console.log(`  Payments:       ${payments.data.length}`);
  for (const p of payments.data) {
    console.log(`    - ${p.id}  ${p.direction}  ${p.fromAmount} ${p.fromCurrency} → ${p.toAmount} ${p.toCurrency}`);
  }
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
  bankAccountId: string;
  bankName: string;
}> {
  // 1. Create customer counterparty (business — owns ledger + bank)
  const customerName = faker.company.name();
  const customer = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "business",
      businessLegalName: customerName,
      businessAddressCountry: "US",
      businessStreetAddress1: faker.location.streetAddress(),
      businessCity: faker.location.city(),
      businessState: faker.location.state({ abbreviated: true }),
      businessPostalCode: faker.location.zipCode(),
      businessLegalEntityIdentifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
      ...(tenantId && { tenantId }),
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
      individualFirstName: firstName,
      individualLastName: lastName,
      individualAddressCountry: "US",
      individualStreetAddress1: faker.location.streetAddress(),
      individualCity: faker.location.city(),
      individualState: faker.location.state({ abbreviated: true }),
      individualPostalCode: faker.location.zipCode(),
    };
  } else {
    beneficiaryName = faker.company.name();
    beneficiaryPayload = {
      classification: "business",
      businessLegalName: beneficiaryName,
      businessAddressCountry: "US",
      businessStreetAddress1: faker.location.streetAddress(),
      businessCity: faker.location.city(),
      businessState: faker.location.state({ abbreviated: true }),
      businessPostalCode: faker.location.zipCode(),
    };
  }

  const beneficiary = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    { ...beneficiaryPayload, ...(tenantId && { tenantId }) },
  );
  const beneficiaryCounterpartyId = beneficiary.data.id;

  // 3. Create ledger account (Circle Mint funding source — customer)
  const ledgerName = `${customerName}'s Ledger`;
  const ledger = await post<{ data: { id: string } }>("/v1/accounts/ledgers", {
    name: ledgerName,
    provider: "CIRCLE_MINT",
    counterpartyId: customerCounterpartyId,
  });
  const ledgerAccountId = ledger.data.id;

  // 4. Create unmanaged recipient wallet (beneficiary)
  const walletName = `${beneficiaryName}'s Wallet`;
  const wallet = await post<{ data: { id: string } }>(
    "/v1/accounts/wallets",
    {
      name: walletName,
      type: "stablecoin_stellar",
      isManaged: false,
      walletAddress: "G" + faker.string.fromCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 55),
      counterpartyId: beneficiaryCounterpartyId,
    },
  );
  const walletAccountId = wallet.data.id;

  // 5. Create unmanaged fiat bank account (customer)
  const bankName = faker.helpers.arrayElement([
    "Chase Checking",
    "Wells Fargo Checking",
    "BofA Checking",
    "Citi Savings",
    "US Bank Checking",
    "PNC Checking",
  ]);
  const bank = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name: bankName,
    bankName: bankName.split(" ")[0],
    bankCodeType: "ROUTING",
    bankIdentifierCode: faker.finance.routingNumber(),
    bankAccountNumber: faker.finance.accountNumber(),
  });
  const bankAccountId = bank.data.id;

  return {
    customerCounterpartyId, customerCounterpartyName: customerName,
    beneficiaryCounterpartyId, beneficiaryCounterpartyName: beneficiaryName,
    ledgerAccountId, ledgerName, walletAccountId, walletName, bankAccountId, bankName,
  };
}

// ---------------------------------------------------------------------------
// Step 4: Create deposit (USD → USDC into ledger account)
// ---------------------------------------------------------------------------
async function step4_createDeposit(
  fromAccountId: string,
  toAccountId: string,
): Promise<string> {
  throw new Error("TODO: implement step4_createDeposit");

}

// ---------------------------------------------------------------------------
// Step 5: Wait for user to confirm manual deposit
// ---------------------------------------------------------------------------
async function step5_waitForDeposit(): Promise<void> {
  // TODO: prompt user to press any key after depositing funds manually
  throw new Error("TODO: implement step5_waitForDeposit");
}

// ---------------------------------------------------------------------------
// Step 6: Create payment (ledger → recipient wallet, 0.01 USDC)
// ---------------------------------------------------------------------------
async function step6_createPayment(
  fromAccountId: string,
  toAccountId: string,
): Promise<string> {
  // TODO: POST /v1/payments
  // {
  //   direction: "outbound",
  //   from_account_id: fromAccountId,
  //   to_account_id: toAccountId,
  //   from_amount: "0.01",
  //   from_currency: "USDC",
  //   from_network: "POLYGON",
  //   to_currency: "USDC",
  //   to_network: "POLYGON",
  // }
  // Return the payment ID
  throw new Error("TODO: implement step6_createPayment");
}

// ---------------------------------------------------------------------------
// Step 7: Poll payment until complete
// ---------------------------------------------------------------------------
async function step7_pollPaymentCompletion(paymentId: string): Promise<void> {
  // TODO: GET /v1/payments/{paymentId} in a loop
  // Check step statuses — stop when all steps are "completed" or any is "failed"
  // Log status on each poll iteration
  throw new Error("TODO: implement step7_pollPaymentCompletion");
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
  bankAccountId: string;
  bankName: string;
}

async function runStep3(tenantId?: string): Promise<VariantEntities> {
  console.log("\n[Step 3] Creating counterparty, ledger, wallet, and bank account...");
  const entities = await step3_setupEntities(tenantId);
  console.log(`  Customer counterparty:          ${entities.customerCounterpartyName} (${entities.customerCounterpartyId})`);
  console.log(`  Beneficiary counterparty:       ${entities.beneficiaryCounterpartyName} (${entities.beneficiaryCounterpartyId})`);
  console.log(`  Customer ledger (Circle):       ${entities.ledgerName} (${entities.ledgerAccountId})`);
  console.log(`  Beneficiary wallet (unmanaged): ${entities.walletName} (${entities.walletAccountId})`);
  console.log(`  Funding bank (unmanaged):       ${entities.bankName} (${entities.bankAccountId})`);
  return entities;
}

async function runSteps4Through7(entities: VariantEntities): Promise<void> {
  const { ledgerAccountId, walletAccountId, bankAccountId } = entities;

  console.log("\n[Step 4] Creating deposit (1000 USD → USDC)...");
  const depositId = await step4_createDeposit(bankAccountId, ledgerAccountId);
  console.log(`  Deposit ID: ${depositId}`);

  console.log("\n[Step 5] Waiting for manual deposit...");
  await step5_waitForDeposit();

  console.log("\n[Step 6] Creating payment (0.01 USDC)...");
  const paymentId = await step6_createPayment(
    ledgerAccountId,
    walletAccountId,
  );
  console.log(`  Payment ID: ${paymentId}`);

  console.log("\n[Step 7] Polling payment until complete...");
  await step7_pollPaymentCompletion(paymentId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Tesser API E2E Demo ===\n");

  console.log("[Step 1] Authenticating...");
  await step1_authenticate();

  console.log("\n[Step 2] Fetching current state...");
  await step2_displayCurrentState();

  // --- Variant A: Org-level (no tenant) ---
  console.log("\n=== Variant A: Org-level ===");
  const variantA = await runStep3();

  // --- Variant B: Tenant-level ---
  console.log("\n=== Variant B: Tenant-level ===");

  console.log("\n[Tenant] Creating tenant...");
  const tenantName = faker.company.name();
  const tenant = await post<{ data: { tenant: { id: string } } }>(
    "/v1/entities/tenants",
    {
      businessLegalName: tenantName,
      businessAddressCountry: "US",
    },
  );
  const tenantId = tenant.data.tenant.id;
  console.log(`  Tenant: ${tenantName} (${tenantId})`);

  const variantB = await runStep3(tenantId);

  // --- Run steps 4–7 for each variant ---
  console.log("\n=== Variant A: Steps 4–7 ===");
  await runSteps4Through7(variantA);

  console.log("\n=== Variant B: Steps 4–7 ===");
  await runSteps4Through7(variantB);

  console.log("\n=== Demo complete ===");
}

main().catch((err) => {
  console.error("\nDemo failed:", err.message);
  process.exit(1);
});
