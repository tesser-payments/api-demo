import pc from "picocolors";
import { get, post } from "./client.ts";
import { poll } from "./retry.ts";
import type { Envelope, Payment, Step } from "./types.ts";

export const stepSummary = (steps: Step[]) =>
  steps.map((s) => `step${s.step_sequence}=${s.status}`).join(", ") || "no steps yet";

/**
 * Throw if any step failed, with its `status_reasons` as `code: message`.
 */
export function assertNoFailedStep(kind: string, steps: Step[]): void {
  const failed = steps.find((s) => s.status === "failed");
  if (!failed) return;
  const reasons = failed.status_reasons
    ?.map((r) => `${r.error_code}: ${r.error_message}`)
    .join("; ");
  throw new Error(`${kind} step ${failed.step_sequence} failed: ${reasons || "no reason given"}`);
}

export interface WaitForPaymentOptions {
  /**
   * Called once if risk screening holds the payment for review; resolve to
   * `true` to approve. Without it, the wait continues until someone decides
   * (in the dashboard or via the review endpoint).
   */
  decide?: (payment: Payment) => Promise<boolean>;
  /** Recorded with the review decision. */
  reason?: string;
  /** Called once per transaction a step asks to sign; resolve to its `signature`. Without it, someone else must sign. */
  sign?: (step: Step, payment: Payment) => Promise<string>;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll a payment until every step is completed, logging risk, balance and
 * step changes. Fails fast on a risk rejection or a failed step.
 */
export async function waitForPayment(
  paymentId: string,
  { decide, reason, sign, timeoutMs = 10 * 60_000, intervalMs }: WaitForPaymentOptions = {},
): Promise<Payment> {
  const reviewKey = crypto.randomUUID();
  let decision: boolean | undefined;
  let reviewed = false;
  // Keyed by step and transaction: a retry resends the same signature and key, a new transaction is signed anew.
  const signRequests = new Map<string, SignRequest>();
  const submittedSignatures = new Set<string>();
  let last = "";

  return poll(
    "Payment",
    async () => {
      const { data: payment } = await get<Envelope<Payment>>(`/v1/payments/${paymentId}`);
      const summary = `risk=${payment.risk_status ?? "-"}  balance=${payment.balance_status ?? "-"}  ${stepSummary(payment.steps)}`;
      if (summary !== last) console.log(pc.yellow(`  ${summary}`));
      last = summary;

      if (payment.risk_status === "automatically_rejected" || payment.risk_status === "manually_rejected") {
        throw new Error(`Payment ${paymentId} was rejected (${payment.risk_status})`);
      }

      if (payment.risk_status === "awaiting_decision" && !reviewed) {
        if (!decide) return undefined;
        // Ask once, even if the review POST below has to be retried.
        decision ??= await decide(payment);
        await post(
          `/v1/payments/${paymentId}/review`,
          { is_approved: decision, ...(reason && { reason }) },
          { idempotencyKey: reviewKey },
        );
        reviewed = true;
        console.log(pc.dim(`  Risk review: ${decision ? "approved" : "rejected"}`));
        return undefined;
      }

      assertNoFailedStep("Payment", payment.steps);

      for (const step of payment.steps) {
        if (!sign || step.status !== "signature_requested" || !step.unsigned_transaction) continue;
        const transactionKey = `${step.id}:${step.unsigned_transaction}`;
        if (submittedSignatures.has(transactionKey)) continue;
        const request = signRequests.get(transactionKey) ?? {
          signature: await sign(step, payment),
          idempotencyKey: crypto.randomUUID(),
        };
        signRequests.set(transactionKey, request);
        await submitSignature({ paymentId, stepId: step.id, ...request });
        submittedSignatures.add(transactionKey);
        console.log(pc.dim(`  Signed step ${step.step_sequence}`));
      }

      const done = payment.steps.length > 0 && payment.steps.every((s) => s.status === "completed");
      return done ? payment : undefined;
    },
    {
      timeoutMs,
      intervalMs,
      timeoutHint: decide ? undefined : "If risk is awaiting_decision, approve or reject the payment",
    },
  );
}

interface SignRequest {
  signature: string;
  idempotencyKey: string;
}

async function submitSignature({
  paymentId,
  stepId,
  signature,
  idempotencyKey,
}: { paymentId: string; stepId: string } & SignRequest): Promise<void> {
  try {
    await post(`/v1/payments/${paymentId}/steps/${stepId}/sign`, { signature }, { idempotencyKey });
  } catch (error) {
    // The request body is in the error message; a signature authorizes moving the wallet's funds.
    if (error instanceof Error) error.message = error.message.replaceAll(signature, "<redacted>");
    throw error;
  }
}
