import pc from "picocolors";
import { authenticate, get, post } from "../src/client.ts";
import { pRetry, AbortError, retryOpts } from "../src/retry.ts";

// ---------------------------------------------------------------------------
// Read payment request body from stdin (JS object literal)
// ---------------------------------------------------------------------------
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ---------------------------------------------------------------------------
// Poll payment until every step reaches a terminal success state
// ---------------------------------------------------------------------------
async function pollPayment(paymentId: string): Promise<void> {
  await pRetry(
    async () => {
      const payment = await get<{
        data: {
          steps?: {
            step_sequence: number;
            status: string;
            status_reasons?: string | null;
            finalized_at?: string | null;
            completed_at?: string | null;
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

      const allTerminal =
        steps.length >= 1 && steps.every((s) => s.completed_at ?? s.finalized_at);
      if (allTerminal) {
        const latest = steps.reduce((a, b) => {
          const aAt = (a.completed_at ?? a.finalized_at) as string;
          const bAt = (b.completed_at ?? b.finalized_at) as string;
          return bAt > aAt ? b : a;
        });
        const terminalAt = (latest.completed_at ?? latest.finalized_at) as string;
        const label = latest.completed_at ? "completed" : "finalized";
        console.log(
          pc.green(`  All ${steps.length} step(s) terminal — latest ${label} at ${terminalAt}`),
        );
        return;
      }

      throw new Error("Payment not yet finalized");
    },
    retryOpts("Poll"),
  );
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
  const payment = await post<{ data: { id: string } }>("/v1/payments", body);
  const paymentId = payment.data.id;
  console.log(`  Payment ID: ${pc.cyan(paymentId)}`);

  console.log(pc.bold("\n[3] Polling payment until complete..."));
  await pollPayment(paymentId);

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
