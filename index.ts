import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, getAll, post, DEBUG } from "./src/client.ts";
import { pRetry, AbortError, retryOpts, RETRY_INTERVAL_MS } from "./src/retry.ts";
import type {
  CounterpartyListResponse,
  TenantListResponse,
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

  const allCounterparties = await getAll<CounterpartyListResponse["data"][number]>("/v1/entities/counterparties");
  console.log(`  Counterparties: ${pc.bold(String(allCounterparties.length))}`);
  for (const c of allCounterparties) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(c.id)}  ${c.classification}  ${c.name}`);
  }

  const allAccounts = await getAll<{
    id: string; name: string; type: string;
    counterparty_id?: string | null; tenant_id?: string | null;
    is_managed?: boolean | null;
    assets?: { currency: string; available_balance: string }[];
  }>("/v1/accounts");
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

  const allPayments = await getAll<{
    id: string; direction: string;
    from_amount?: string; from_currency?: string;
    to_amount?: string; to_currency?: string;
  }>("/v1/payments");
  console.log(`  Payments:       ${pc.bold(String(allPayments.length))}`);
  for (const p of allPayments) {
    console.log(`    ${pc.dim("·")} ${pc.cyan(p.id)}  ${p.direction}  ${p.from_amount} ${p.from_currency} → ${p.to_amount} ${p.to_currency}`);
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
// Step 1.5: Store Circle Mint API key in organization vault
// ---------------------------------------------------------------------------
async function step1_5_storeCircleMintKey(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;

  if (!apiKey) {
    console.log(pc.yellow("  ⚠️  CIRCLE_API_KEY not set — skipping vault storage"));
    return;
  }

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
      // You must use a Stellar wallet that has enabled a trustline for USDC
      // https://developers.stellar.org/docs/data/analytics/hubble/data-catalog/data-dictionary/bronze/trustlines
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
): Promise<string> {
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

  return deposit.data.id;
}

// ---------------------------------------------------------------------------
// Step 5: Simulate deposit via Tesser sandbox endpoint
// ---------------------------------------------------------------------------
async function step5_simulateDeposit(depositId: string): Promise<void> {
  const res = await pRetry(
    () =>
      post<{ data: Record<string, unknown> }>(
        `/v1/treasury/deposits/${depositId}/simulate`,
        {},
      ),
    retryOpts("Simulate"),
  );
  console.log("  Simulate response:", JSON.stringify(res.data, null, 2));
}

// ---------------------------------------------------------------------------
// Step 5b: Poll ledger account balance until funded
// ---------------------------------------------------------------------------
async function pollLedgerBalance(ledgerAccountId: string): Promise<void> {
  await pRetry(
    async () => {
      const account = await get<{
        data: {
          id: string;
          assets?: { currency: string; available_balance: string }[];
        };
      }>(`/v1/accounts/${ledgerAccountId}`);

      const asset = account.data.assets?.[0];
      const balance = asset ? parseFloat(asset.available_balance) : 0;
      console.log(pc.yellow(`  Balance: ${balance} ${asset?.currency ?? "?"}`));

      if (balance > 0) {
        console.log(pc.green(`  Ledger funded: ${asset!.available_balance} ${asset!.currency}`));
        return;
      }

      throw new Error("Ledger balance is 0");
    },
    {
      retries: Infinity,
      minTimeout: RETRY_INTERVAL_MS,
      maxTimeout: RETRY_INTERVAL_MS,
      factor: 1,
      onFailedAttempt: ({ attemptNumber }) => {
        console.log(pc.dim(`  Retrying in ${RETRY_INTERVAL_MS / 1000}s... (attempt ${attemptNumber})`));
      },
    },
  );
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

  const payment = await pRetry(
    () =>
      post<{ data: { id: string } }>("/v1/payments", {
        direction: "outbound",
        funding_account_id: fundingAccountId,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
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
      const payment = await get<{
        data: {
          steps?: {
            step_sequence: number;
            status: string;
            status_reasons?: string | null;
            finalized_at?: string | null;
          }[];
        };
      }>(`/v1/payments/${paymentId}`);
      const steps = payment.data.steps ?? [];

      const failedStep = steps.find((s) => s.status === "failed");
      if (failedStep) {
        throw new AbortError(
          `Step ${failedStep.step_sequence} failed: ${failedStep.status_reasons}`,
        );
      }

      const stepStatuses = steps
        .map((s) => `step${s.step_sequence}=${s.status}`)
        .join(", ");
      console.log(pc.yellow(`  Poll: ${stepStatuses}`));

      if (steps.length >= 1 && steps[0]?.finalized_at) {
        console.log(pc.green(`  First step finalized at ${steps[0]!.finalized_at}`));
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
  const depositId = await step4_createDeposit(bankAccountId, ledgerAccountId, depositAmount);
  console.log(`  Deposit ID: ${pc.cyan(depositId)}`);

  console.log(pc.bold("\n[Step 5] Simulating deposit..."));
  await step5_simulateDeposit(depositId);

  console.log(pc.bold("\n[Step 5b] Polling ledger balance until funded..."));
  console.log(`  Ledger account:  ${pc.cyan(ledgerAccountId)}`);
  console.log(`  Wallet account:  ${pc.cyan(walletAccountId)}`);
  await pollLedgerBalance(ledgerAccountId);

  console.log(pc.bold(`\n[Step 6] Creating payment (${paymentAmount} USDC)...`));
  const paymentId = await step6_createPayment(
    bankAccountId,
    ledgerAccountId,
    walletAccountId,
    paymentAmount,
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
  console.log(`  Debug mode: ${DEBUG ? pc.yellow("ON") : pc.dim("OFF")}`);

  console.log(pc.bold("\n[Step 1] Authenticating..."));
  await step1_authenticate();

  console.log(pc.bold("\n[Step 1.5] Storing Circle Mint API key in vault..."));
  await step1_5_storeCircleMintKey();

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
        business_street_address1: faker.location.streetAddress(),
        business_city: faker.location.city(),
        business_state: faker.location.state({ abbreviated: true }),
        business_postal_code: faker.location.zipCode(),
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
