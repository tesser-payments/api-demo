import pc from "picocolors";

const BASE = "https://api-sandbox.circle.com";
const API_KEY = process.env.CIRCLE_API_KEY;
const FROM_WALLET_ID = process.env.CIRCLE_FROM_WALLET_ID;
const TO_WALLET_ID = process.env.CIRCLE_TO_WALLET_ID;

if (!API_KEY) throw new Error("CIRCLE_API_KEY is not set");
if (!FROM_WALLET_ID) throw new Error("CIRCLE_FROM_WALLET_ID is not set");
if (!TO_WALLET_ID) throw new Error("CIRCLE_TO_WALLET_ID is not set");

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

async function circleGet<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  console.log(pc.dim(`  GET ${url}`));
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} failed (${res.status})\n  ${text}`);
  }
  return (await res.json()) as T;
}

async function circlePost<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  console.log(pc.dim(`  POST ${url}`));
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} failed (${res.status})\n  ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Step 1: Check balance
// ---------------------------------------------------------------------------
async function checkBalance(): Promise<void> {
  const data = await circleGet<{
    data: {
      available: { amount: string; currency: string }[];
      unsettled: { amount: string; currency: string }[];
    };
  }>(`/v1/businessAccount/balances?walletId=${FROM_WALLET_ID}`);

  console.log("  Available:");
  for (const b of data.data.available) {
    console.log(`    ${pc.cyan(b.amount)} ${b.currency}`);
  }
  if (data.data.unsettled?.length > 0) {
    console.log("  Unsettled:");
    for (const b of data.data.unsettled) {
      console.log(`    ${pc.yellow(b.amount)} ${b.currency}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Get external entity by wallet ID
// ---------------------------------------------------------------------------
async function getExternalEntity(): Promise<void> {
  const data = await circleGet<{
    data: {
      walletId: string;
      businessName?: string;
      businessUniqueIdentifier?: string;
      identifierIssuingCountryCode?: string;
      complianceState?: string;
    };
  }>(`/v1/externalEntities/${FROM_WALLET_ID}`);

  const e = data.data;
  console.log(`  Wallet ID:    ${pc.cyan(e.walletId)}`);
  if (e.businessName) console.log(`  Business:     ${e.businessName}`);
  if (e.businessUniqueIdentifier) console.log(`  Identifier:   ${e.businessUniqueIdentifier}`);
  if (e.identifierIssuingCountryCode) console.log(`  Country:      ${e.identifierIssuingCountryCode}`);
  if (e.complianceState) console.log(`  Compliance:   ${e.complianceState}`);
}

// ---------------------------------------------------------------------------
// Step 3: Check recipient address
// ---------------------------------------------------------------------------
async function checkRecipient(): Promise<void> {
  const data = await circleGet<{
    data: {
      id: string;
      address: string;
      addressTag: string | null;
      chain: string;
      currency: string;
      description: string;
      status: string;
    };
  }>(`/v1/addressBook/recipients/${TO_WALLET_ID}`);

  const r = data.data;
  console.log(`  ID:          ${pc.cyan(r.id)}`);
  console.log(`  Address:     ${r.address}`);
  console.log(`  Chain:       ${r.chain}`);
  console.log(`  Currency:    ${r.currency}`);
  console.log(`  Status:      ${r.status}`);
  console.log(`  Description: ${r.description}`);
}

// ---------------------------------------------------------------------------
// Step 4: Create payout
// ---------------------------------------------------------------------------
async function createPayout(): Promise<void> {
  const amount = (1 + Math.random()).toFixed(2);

  const body = {
    idempotencyKey: crypto.randomUUID(),
    source: { type: "wallet", id: FROM_WALLET_ID },
    destination: { type: "address_book", id: TO_WALLET_ID },
    amount: { amount, currency: "USD" },
  };
  console.log(`  Amount: ${pc.cyan(amount)} USD`);
  console.log(`  Body:   ${JSON.stringify(body, null, 2)}`);

  const data = await circlePost<{
    data: {
      id: string;
      status: string;
      amount: { amount: string; currency: string };
      fees: { amount: string; currency: string };
      createDate: string;
      sourceWalletId: string;
      destination: { type: string; id: string };
    };
  }>("/v1/payouts", body);

  console.log(`  Payout ID: ${pc.cyan(data.data.id)}`);
  console.log(`  Status:    ${data.data.status}`);
  console.log(`  Amount:    ${data.data.amount.amount} ${data.data.amount.currency}`);
  if (data.data.fees) {
    console.log(`  Fees:      ${data.data.fees.amount} ${data.data.fees.currency}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(pc.bold("\n[1] Checking balance..."));
  await checkBalance();

  console.log(pc.bold("\n[2] Getting external entity..."));
  await getExternalEntity();

  console.log(pc.bold("\n[3] Checking recipient address..."));
  await checkRecipient();

  console.log(pc.bold("\n[4] Creating payout..."));
  await createPayout();

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
