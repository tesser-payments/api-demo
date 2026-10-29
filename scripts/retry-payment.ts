import pc from "picocolors";
import { authenticate, post } from "../src/client.ts";
import { waitForPayment } from "../src/steps.ts";
import type { Envelope, Payment } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Read payment request body from stdin (JS object literal)
// ---------------------------------------------------------------------------
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(pc.dim("Paste payment request body (JS object literal), then press Ctrl+D:\n"));

  const input = await readStdin();
  if (!input) throw new Error("No input received");

  // Parse JS object literal (unquoted keys) by wrapping in parens
  const body = new Function(`return (${input})`)();
  console.log("\nParsed payment body:", JSON.stringify(body, null, 2));

  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();

  console.log(pc.bold("\n[2] Creating payment..."));
  const payment = await post<Envelope<Payment>>("/v1/payments", body);
  const paymentId = payment.data.id;
  console.log(`  Payment ID: ${pc.cyan(paymentId)}`);

  // A payment held for risk review waits here until someone decides
  // (dashboard or POST /v1/payments/{id}/review).
  console.log(pc.bold("\n[3] Waiting for the payment to complete..."));
  const completed = await waitForPayment(paymentId);
  for (const s of completed.steps) {
    console.log(pc.green(`  step${s.step_sequence} completed at ${s.completed_at}  ${pc.dim(s.transaction_hash ?? "")}`));
  }

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
