import pc from "picocolors";
import { authenticate, get, post } from "./src/client.ts";
import type { IAccount } from "@tesser-payments/types";

const FROM_ACCOUNT_ID = process.env.TESSER_FROM_ACCOUNT_ID;
const TO_ACCOUNT_ID = process.env.TESSER_TO_ACCOUNT_ID;

if (!FROM_ACCOUNT_ID) throw new Error("TESSER_FROM_ACCOUNT_ID is not set");
if (!TO_ACCOUNT_ID) throw new Error("TESSER_TO_ACCOUNT_ID is not set");

function logAccount(account: IAccount): void {
  console.log(`  ID:       ${pc.cyan(account.id)}`);
  console.log(`  Name:     ${account.name}`);
  console.log(`  Type:     ${account.type}`);
  if (account.provider) console.log(`  Provider: ${account.provider}`);
  if (account.cryptoWalletAddress) console.log(`  Address:  ${account.cryptoWalletAddress}`);
  if (account.assets?.length) {
    for (const a of account.assets) {
      const net = a.network ? ` (${a.network})` : "";
      console.log(`  Asset:    ${pc.cyan(a.availableBalance)} ${a.currency}${net}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Authenticate + get source account
// ---------------------------------------------------------------------------
async function getSourceAccount(): Promise<void> {
  const data = await get<{ data: IAccount }>(`/v1/accounts/${FROM_ACCOUNT_ID}`);
  logAccount(data.data);
}

// ---------------------------------------------------------------------------
// Step 2: Get destination account
// ---------------------------------------------------------------------------
async function getDestinationAccount(): Promise<void> {
  const data = await get<{ data: IAccount }>(`/v1/accounts/${TO_ACCOUNT_ID}`);
  logAccount(data.data);
}

// ---------------------------------------------------------------------------
// Step 3: Create payment
// ---------------------------------------------------------------------------
async function createPayment(): Promise<void> {
  const toAmount = (1 + Math.random()).toFixed(2);

  const body = {
    from_currency: "USDC",
    to_currency: "USDC",
    from_account_id: FROM_ACCOUNT_ID,
    source_account_id: FROM_ACCOUNT_ID,
    to_account_id: TO_ACCOUNT_ID,
    from_network: "STELLAR",
    to_network: "STELLAR",
    to_amount: null,
    from_amount: toAmount,
  };
  console.log(`  Amount: ${pc.cyan(toAmount)} USDC`);
  console.log(`  Body:   ${JSON.stringify(body, null, 2)}`);

  const data = await post<{
    data: {
      id: string;
      risk_status: string;
      balance_status: string;
      expires_at: string;
      created_at: string;
    };
  }>("/v1/payments", body);

  console.log(`  Payment ID:      ${pc.cyan(data.data.id)}`);
  console.log(`  Risk status:     ${data.data.risk_status}`);
  console.log(`  Balance status:  ${data.data.balance_status}`);
  console.log(`  Expires at:      ${pc.dim(data.data.expires_at)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(pc.bold("\n[1] Authenticating + getting source account..."));
  await authenticate();
  await getSourceAccount();

  console.log(pc.bold("\n[2] Getting destination account..."));
  await getDestinationAccount();

  console.log(pc.bold("\n[3] Creating payment..."));
  await createPayment();

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
