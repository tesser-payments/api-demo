import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { createInterface } from "node:readline";
import { authenticate, get, post } from "../src/client.ts";
import { pRetry, AbortError, retryOpts } from "../src/retry.ts";

const FROM_ACCOUNT_ID = process.env.TESSER_FROM_ACCOUNT_ID;
if (!FROM_ACCOUNT_ID) throw new Error("TESSER_FROM_ACCOUNT_ID is not set");

function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    }),
  );
}

async function main() {
  // 1. Prompt for wallet address
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const address = await new Promise<string>((resolve) =>
    rl.question("Wallet address: ", (answer) => { rl.close(); resolve(answer.trim()); }),
  );
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

  // 3. Create unmanaged Stellar wallet
  console.log(pc.bold("\n[3] Creating wallet..."));
  const walletName = `${beneficiaryName}'s Wallet`;
  const wallet = await post<{ data: { id: string } }>("/v1/accounts/wallets", {
    name: walletName,
    type: "stablecoin_stellar",
    is_managed: false,
    wallet_address: address,
    counterparty_id: counterpartyId,
  });
  const walletAccountId = wallet.data.id;
  console.log(`  Wallet: ${walletName} ${pc.dim(`(${walletAccountId})`)}`);

  // 4. Create payment
  console.log(pc.bold("\n[4] Creating payment..."));
  const amount = (1 + Math.random()).toFixed(2);

  const payment = await pRetry(
    () =>
      post<{
        data: {
          id: string;
          risk_status: string;
          balance_status: string;
          expires_at: string;
        };
      }>("/v1/payments", {
        direction: "outbound",
        funding_account_id: FROM_ACCOUNT_ID,
        from_account_id: FROM_ACCOUNT_ID,
        to_account_id: walletAccountId,
        from_amount: amount,
        from_currency: "USDC",
        to_currency: "USDC",
        to_network: "STELLAR",
      }),
    retryOpts("Payment"),
  );

  const paymentId = payment.data.id;
  console.log(`  Amount:         ${pc.cyan(amount)} USDC`);
  console.log(`  Payment ID:     ${pc.cyan(paymentId)}`);
  console.log(`  Risk status:    ${payment.data.risk_status}`);
  console.log(`  Balance status: ${payment.data.balance_status}`);
  console.log(`  Expires at:     ${pc.dim(payment.data.expires_at)}`);

  // 5. Poll payment until finalized
  console.log(pc.bold("\n[5] Polling payment until finalized..."));
  await pRetry(
    async () => {
      const res = await get<{
        data: {
          risk_status?: string;
          steps?: {
            step_sequence: number;
            status: string;
            status_reasons?: string | null;
            finalized_at?: string | null;
          }[];
          [key: string]: unknown;
        };
      }>(`/v1/payments/${paymentId}`);

      console.log(JSON.stringify(res, null, 2));

      // Handle risk review if awaiting decision
      if (res.data.risk_status === "awaiting_approval") {
        const approved = await promptYesNo(
          pc.yellow("\n  Risk status is awaiting_approval. Approve? (y/n): "),
        );
        const review = await post<{ data: Record<string, unknown> }>(
          `/v1/payments/${paymentId}/review`,
          { is_approved: approved },
        );
        console.log(`  Review submitted (${approved ? "approved" : "rejected"}):`);
        console.log(JSON.stringify(review, null, 2));
        if (!approved) {
          throw new AbortError("Payment rejected by user");
        }
        throw new Error("Waiting for post-review processing");
      }

      const steps = res.data.steps ?? [];

      const failedStep = steps.find((s) => s.status === "failed");
      if (failedStep) {
        throw new AbortError(
          `Step ${failedStep.step_sequence} failed: ${failedStep.status_reasons}`,
        );
      }

      if (steps.length >= 1 && steps[0]?.finalized_at) {
        console.log(pc.green(`  Finalized at ${steps[0].finalized_at}`));
        return;
      }

      throw new Error("Payment not yet finalized");
    },
    retryOpts("Poll"),
  );

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
