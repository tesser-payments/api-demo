import pc from "picocolors";
import { authenticate, get, post } from "../src/client.ts";
import type { Account, Envelope, Payment } from "../src/types.ts";

const FROM_ACCOUNT_ID = process.env.TESSER_FROM_ACCOUNT_ID;
const TO_ACCOUNT_ID = process.env.TESSER_TO_ACCOUNT_ID;
const NETWORK = (process.env.PAYMENT_NETWORK || "STELLAR").toUpperCase();

if (!FROM_ACCOUNT_ID) throw new Error("TESSER_FROM_ACCOUNT_ID is not set");
if (!TO_ACCOUNT_ID) throw new Error("TESSER_TO_ACCOUNT_ID is not set");

function logAccount(account: Account): void {
  console.log(`  ID:       ${pc.cyan(account.id)}`);
  console.log(`  Name:     ${account.name}`);
  console.log(`  Type:     ${account.type}`);
  if (account.provider) console.log(`  Provider: ${account.provider}`);
  if (account.crypto_wallet_address) console.log(`  Address:  ${account.crypto_wallet_address}`);
  if (account.assets?.length) {
    for (const a of account.assets) {
      const net = a.network ? ` (${a.network})` : "";
      console.log(`  Asset:    ${pc.cyan(a.available_balance)} ${a.currency}${net}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Authenticate + get source account
// ---------------------------------------------------------------------------
async function getSourceAccount(): Promise<void> {
  const data = await get<Envelope<Account>>(`/v1/accounts/${FROM_ACCOUNT_ID}`);
  logAccount(data.data);
}

// ---------------------------------------------------------------------------
// Step 2: Get destination account
// ---------------------------------------------------------------------------
async function getDestinationAccount(): Promise<void> {
  const data = await get<Envelope<Account>>(`/v1/accounts/${TO_ACCOUNT_ID}`);
  logAccount(data.data);
}

// ---------------------------------------------------------------------------
// Step 3: Create payment
// ---------------------------------------------------------------------------
async function createPayment(): Promise<void> {
  const amount = (1 + Math.random()).toFixed(2);

  // The source account funds the payment; it must belong to a counterparty
  // or tenant (a counterparty's ledger qualifies).
  const body = {
    funding_account_id: FROM_ACCOUNT_ID,
    desired: {
      from: {
        account_id: FROM_ACCOUNT_ID,
        amount,
        currency: "USDC",
        network: NETWORK,
      },
      to: {
        account_id: TO_ACCOUNT_ID,
        currency: "USDC",
        network: NETWORK,
      },
    },
  };
  console.log(`  Amount: ${pc.cyan(amount)} USDC on ${NETWORK}`);
  console.log(`  Body:   ${JSON.stringify(body, null, 2)}`);

  const data = await post<Envelope<Payment>>("/v1/payments", body);

  console.log(`  Payment ID:      ${pc.cyan(data.data.id)}`);
  console.log(`  Risk status:     ${data.data.risk_status}`);
  console.log(`  Balance status:  ${data.data.balance_status}`);
  console.log(`  Expires at:      ${pc.dim(data.data.expires_at ?? "-")}`);
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
