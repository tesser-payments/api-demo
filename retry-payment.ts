import { authenticate, get, post } from "./src/client.ts";
import type { IPayment } from "@tesser-payments/types";

// ---------------------------------------------------------------------------
// Read payment request body from stdin (JS object literal)
// ---------------------------------------------------------------------------
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ---------------------------------------------------------------------------
// Poll payment until first step confirmed
// ---------------------------------------------------------------------------
async function pollPayment(paymentId: string): Promise<void> {
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

    if (steps.length >= 1 && steps[0]?.finalizedAt) {
      console.log(`  First step finalized at ${steps[0]!.finalizedAt}`);
      return;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  throw new Error("Payment did not complete within 10 minutes");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Paste payment request body (JS object literal), then press Ctrl+D:\n");

  const input = await readStdin();
  if (!input) throw new Error("No input received");

  // Parse JS object literal (unquoted keys) by wrapping in parens
  const body = new Function(`return (${input})`)();
  console.log("\nParsed payment body:", JSON.stringify(body, null, 2));

  console.log("\n[1] Authenticating...");
  await authenticate();

  console.log("[2] Creating payment...");
  const payment = await post<{ data: { id: string } }>("/v1/payments", body);
  const paymentId = payment.data.id;
  console.log(`  Payment ID: ${paymentId}`);

  console.log("[3] Polling payment until complete...");
  await pollPayment(paymentId);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
