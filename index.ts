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
async function step3_setupEntities(): Promise<{
  counterpartyId: string;
  ledgerAccountId: string;
  walletAccountId: string;
}> {
  // TODO:
  // 1. POST /v1/entities/counterparties — create individual counterparty
  // 2. POST /v1/accounts/ledgers — create ledger account for counterparty
  // 3. POST /v1/accounts/wallets — create unmanaged recipient wallet for counterparty
  // Return all three IDs
  throw new Error("TODO: implement step3_setupEntities");
}

// ---------------------------------------------------------------------------
// Step 4: Display ledger deposit address
// ---------------------------------------------------------------------------
async function step4_displayDepositAddress(
  ledgerAccountId: string,
): Promise<void> {
  // TODO: GET /v1/accounts/{ledgerAccountId}
  // Print the deposit address from the account response
  throw new Error("TODO: implement step4_displayDepositAddress");
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Tesser API E2E Demo ===\n");

  console.log("[Step 1] Authenticating...");
  await step1_authenticate();

  console.log("\n[Step 2] Fetching current state...");
  await step2_displayCurrentState();

  console.log("\n[Step 3] Creating counterparty, ledger, and recipient wallet...");
  const { counterpartyId, ledgerAccountId, walletAccountId } =
    await step3_setupEntities();
  console.log(`  Counterparty: ${counterpartyId}`);
  console.log(`  Ledger:       ${ledgerAccountId}`);
  console.log(`  Wallet:       ${walletAccountId}`);

  console.log("\n[Step 4] Deposit address:");
  await step4_displayDepositAddress(ledgerAccountId);

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

  console.log("\n=== Demo complete ===");
}

main().catch((err) => {
  console.error("\nDemo failed:", err.message);
  process.exit(1);
});
