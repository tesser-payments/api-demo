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
async function step2_displayCurrentState(): Promise<string> {
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

  // Find pre-existing org-level fiat bank account (unmanaged, no tenant, no counterparty)
  const fundingBank = accounts.data.find(
    (a) => a.type === "fiat_bank" && a.isManaged === false && !a.tenantId && !a.counterpartyId,
  );
  if (fundingBank) {
    console.log(`  Funding bank:   ${fundingBank.name} (${fundingBank.id})`);
    return fundingBank.id;
  }
  const fallbackId = process.env.FALLBACK_FUNDING_BANK_ACCOUNT_ID;
  if (!fallbackId) {
    throw new Error("No fiat_bank account found and FALLBACK_FUNDING_BANK_ACCOUNT_ID is not set");
  }
  console.log(`  Funding bank:   (fallback) ${fallbackId}`);
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
      businessLegalName: customerName,
      businessDba: customerName,
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
      businessDba: beneficiaryName,
      businessAddressCountry: "US",
      businessStreetAddress1: faker.location.streetAddress(),
      businessCity: faker.location.city(),
      businessState: faker.location.state({ abbreviated: true }),
      businessPostalCode: faker.location.zipCode(),
      businessLegalEntityIdentifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
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
      walletAddress: process.env.BENEFICIARY_WALLET_ADDRESS || "G" + faker.string.fromCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 55),
      counterpartyId: beneficiaryCounterpartyId,
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
): Promise<{ depositId: string; instructions: Record<string, unknown> }> {
  const maxAttempts = 60;
  const retryIntervalMs = 10_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const deposit = await post<{ data: { id: string } }>(
        "/v1/treasury/deposits",
        {
          fromCurrency: "USD",
          toCurrency: "USDC",
          fromAmount: "100",
          fromAccountId: fromAccountId,
          toAccountId: toAccountId,
        },
      );
      // Fetch deposit instructions with retry (30s interval, 10min max)
      const depositId = deposit.data.id;
      const instrMaxAttempts = 60;
      const instrRetryMs = 10_000;
      for (let instrAttempt = 1; instrAttempt <= instrMaxAttempts; instrAttempt++) {
        try {
          const instructions = await get<{ data: Record<string, unknown> }>(
            `/v1/treasury/deposits/${depositId}/instructions`,
          );
          console.log("  Deposit instructions:", JSON.stringify(instructions.data, null, 2));
          return { depositId, instructions: instructions.data };
        } catch (err) {
          console.log(`  Instructions attempt ${instrAttempt}/${instrMaxAttempts} failed: ${(err as Error).message}`);
          if (instrAttempt === instrMaxAttempts) throw err;
          console.log(`  Retrying in ${instrRetryMs / 1000}s...`);
          await new Promise((r) => setTimeout(r, instrRetryMs));
        }
      }
      throw new Error("Failed to fetch deposit instructions after all retries");
    } catch (err) {
      console.log(`  Deposit attempt ${attempt}/${maxAttempts} failed: ${(err as Error).message}`);
      if (attempt === maxAttempts) throw err;
      console.log(`  Retrying in ${retryIntervalMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Step 5: Simulate deposit via Circle sandbox mock wire
// ---------------------------------------------------------------------------
async function step5_simulateDeposit(instructions: Record<string, unknown>): Promise<void> {
  const circleApiKey = process.env.CIRCLE_API_KEY;
  if (!circleApiKey) throw new Error("CIRCLE_API_KEY is not set");

  const toAccount = instructions.toAccount as Record<string, unknown>;
  const metadata = toAccount.metadata as Record<string, unknown>;
  const body = {
    trackingRef: metadata.trackingRef,
    amount: { amount: "100", currency: "USD" },
    beneficiaryBank: { accountNumber: toAccount.accountNumber },
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
): Promise<string> {
  const payment = await post<{ data: { id: string } }>("/v1/payments", {
    direction: "outbound",
    fundingAccountId: fundingAccountId,
    fromAccountId: fromAccountId,
    toAccountId: toAccountId,
    fromAmount: "10.03",
    fromCurrency: "USDC",
    toCurrency: "USDC",
    toNetwork: "STELLAR",
  });
  return payment.data.id;
}

// ---------------------------------------------------------------------------
// Step 7: Poll payment until complete
// ---------------------------------------------------------------------------
async function step7_pollPaymentCompletion(paymentId: string): Promise<void> {
  const maxAttempts = 60;
  const pollIntervalMs = 10_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const payment = await get<{ data: IPayment }>(`/v1/payments/${paymentId}`);
    const steps = payment.data.steps ?? [];

    const failedStep = steps.find((s) => s.status === "failed");
    if (failedStep) {
      throw new Error(`Step ${failedStep.stepSequence} failed: ${failedStep.statusReasons}`);
    }

    const stepStatuses = steps.map((s) => `step${s.stepSequence}=${s.status}`).join(", ");
    console.log(`  Poll ${attempt}/${maxAttempts}: ${stepStatuses}`);

    if (steps.length >= 2 && steps[1]?.confirmedAt) {
      console.log(`  Second step confirmed at ${steps[1]!.confirmedAt}`);
      return;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  throw new Error("Payment did not complete within 10 minutes");
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
  console.log("\n[Step 3] Creating counterparty, ledger, wallet, and bank account...");
  const entities = await step3_setupEntities(tenantId);
  console.log(`  Customer counterparty:          ${entities.customerCounterpartyName} (${entities.customerCounterpartyId})`);
  console.log(`  Beneficiary counterparty:       ${entities.beneficiaryCounterpartyName} (${entities.beneficiaryCounterpartyId})`);
  console.log(`  Customer ledger (Circle):       ${entities.ledgerName} (${entities.ledgerAccountId})`);
  console.log(`  Beneficiary wallet (unmanaged): ${entities.walletName} (${entities.walletAccountId})`);
  return entities;
}

async function runSteps4Through7(entities: VariantEntities, bankAccountId: string): Promise<void> {
  const { ledgerAccountId, walletAccountId } = entities;

  console.log("\n[Step 4] Creating deposit (100 USD → USDC)...");
  const { depositId, instructions } = await step4_createDeposit(bankAccountId, ledgerAccountId);
  console.log(`  Deposit ID: ${depositId}`);

  console.log("\n[Step 5] Simulating deposit via Circle mock wire...");
  await step5_simulateDeposit(instructions);

  console.log("\n[Step 6] Creating payment (0.01 USDC)...");
  const paymentId = await step6_createPayment(
    bankAccountId,
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
  const bankAccountId = await step2_displayCurrentState();

  const enableVariants = (process.env.ENABLE_VARIANTS || "BOTH").toUpperCase();
  const runA = enableVariants === "A" || enableVariants === "BOTH";
  const runB = enableVariants === "B" || enableVariants === "BOTH";

  let variantA: VariantEntities | undefined;
  let variantB: VariantEntities | undefined;

  // --- Variant A: Org-level (no tenant) ---
  if (runA) {
    console.log("\n=== Variant A: Org-level ===");
    variantA = await runStep3();
  }

  // --- Variant B: Tenant-level ---
  if (runB) {
    console.log("\n=== Variant B: Tenant-level ===");

    console.log("\n[Tenant] Creating tenant...");
    const tenantName = faker.company.name();
    const tenant = await post<{ data: { tenant: { id: string } } }>(
      "/v1/entities/tenants",
      {
        businessLegalName: tenantName,
        businessDba: tenantName,
        businessAddressCountry: "US",
        businessLegalEntityIdentifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
      },
    );
    const tenantId = tenant.data.tenant.id;
    console.log(`  Tenant: ${tenantName} (${tenantId})`);

    variantB = await runStep3(tenantId);
  }

  // --- Run steps 4–7 for each variant ---
  if (runA && variantA) {
    console.log("\n=== Variant A: Steps 4–7 ===");
    await runSteps4Through7(variantA, bankAccountId);
  }

  if (runB && variantB) {
    console.log("\n=== Variant B: Steps 4–7 ===");
    await runSteps4Through7(variantB, bankAccountId);
  }

  console.log("\n=== Demo complete ===");
}

main().catch((err) => {
  console.error("\nDemo failed:", err.message);
  process.exit(1);
});
