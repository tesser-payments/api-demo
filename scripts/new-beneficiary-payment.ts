import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { createInterface } from "node:readline";
import { authenticate, post } from "../src/client.ts";
import { postWithRetry } from "../src/retry.ts";
import { waitForPayment } from "../src/steps.ts";
import type { Envelope, Payment } from "../src/types.ts";

const FROM_ACCOUNT_ID = process.env.TESSER_FROM_ACCOUNT_ID;
if (!FROM_ACCOUNT_ID) throw new Error("TESSER_FROM_ACCOUNT_ID is not set");

const NETWORK = (process.env.PAYMENT_NETWORK || "STELLAR").toUpperCase();
const WALLET_TYPE = NETWORK.startsWith("STELLAR") ? "stablecoin_stellar" : "stablecoin_ethereum";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

async function main() {
  // 1. Prompt for wallet address
  const address = await prompt(`${NETWORK} wallet address: `);
  if (!address) throw new Error("No wallet address provided");

  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();

  // 2. Create beneficiary counterparty (individual)
  console.log(pc.bold("\n[2] Creating beneficiary counterparty..."));
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const beneficiaryName = `${firstName} ${lastName}`;

  const counterparty = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "individual",
      individual_first_name: firstName,
      individual_last_name: lastName,
      individual_address_country: "US",
      individual_street_address1: faker.location.streetAddress(),
      individual_city: faker.location.city(),
      individual_state: faker.location.state({ abbreviated: true }),
      individual_postal_code: faker.location.zipCode(),
    },
  );
  const counterpartyId = counterparty.data.id;
  console.log(`  Counterparty: ${beneficiaryName} ${pc.dim(`(${counterpartyId})`)}`);

  // 3. Create unmanaged wallet. A Stellar address needs a USDC trustline.
  console.log(pc.bold("\n[3] Creating wallet..."));
  const walletName = `${beneficiaryName}'s Wallet`;
  const wallet = await post<{ data: { id: string } }>("/v1/accounts/wallets", {
    name: walletName,
    type: WALLET_TYPE,
    is_managed: false,
    wallet_address: address,
    counterparty_id: counterpartyId,
  });
  const walletAccountId = wallet.data.id;
  console.log(`  Wallet: ${walletName} ${pc.dim(`(${walletAccountId})`)}`);

  // 4. Create payment
  console.log(pc.bold("\n[4] Creating payment..."));
  const amount = (1 + Math.random()).toFixed(2);

  const payment = await postWithRetry<Envelope<Payment>>(
    "Payment",
    "/v1/payments",
    {
      funding_account_id: FROM_ACCOUNT_ID,
      desired: {
        from: {
          account_id: FROM_ACCOUNT_ID,
          amount,
          currency: "USDC",
          network: NETWORK,
        },
        to: {
          account_id: walletAccountId,
          currency: "USDC",
          network: NETWORK,
        },
      },
    },
    // payments-3017: the new wallet's Circle recipient isn't active yet
    { retryOn: ["payments-3017"] },
  );

  const paymentId = payment.data.id;
  console.log(`  Amount:         ${pc.cyan(amount)} USDC on ${NETWORK}`);
  console.log(`  Payment ID:     ${pc.cyan(paymentId)}`);
  console.log(`  Risk status:    ${payment.data.risk_status}`);
  console.log(`  Balance status: ${payment.data.balance_status}`);
  console.log(`  Expires at:     ${pc.dim(payment.data.expires_at ?? "-")}`);

  // 5. Wait until every step is completed, asking before approving a risk review
  console.log(pc.bold("\n[5] Waiting for the payment to complete..."));
  const completed = await waitForPayment(paymentId, {
    decide: async () =>
      (await prompt(pc.yellow("\n  Risk status is awaiting_decision. Approve? (y/n): ")))
        .toLowerCase()
        .startsWith("y"),
    reason: "Reviewed with scripts/new-beneficiary-payment.ts",
  });
  console.log(JSON.stringify(completed, null, 2));

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
