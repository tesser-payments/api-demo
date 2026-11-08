import pc from "picocolors";
import { submitStepSignature } from "./api/payments.ts";
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
  /** Resolves to the `signature` for each transaction a step asks to sign; called again only after a transient error. */
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
  const signatures = new Map<string, { signature: string; idempotencyKey: string; submitted: boolean }>();
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
        const known = signatures.get(transactionKey);
        if (known?.submitted) continue;
        const request = known ?? { signature: await sign(step, payment), idempotencyKey: crypto.randomUUID(), submitted: false };
        signatures.set(transactionKey, request);
        await submitStepSignature({
          paymentId,
          stepId: step.id,
          signature: request.signature,
          idempotencyKey: request.idempotencyKey,
        });
        request.submitted = true;
        console.log(pc.dim(`  Signed step ${step.step_sequence}`));
      }

      const done = payment.steps.length > 0 && payment.steps.every((s) => s.status === "completed");
      return done ? payment : undefined;
    },
    {
      timeoutMs,
      intervalMs,
      timeoutHint: () => {
        const reviewHint = !decide && last.includes("risk=awaiting_decision") && "approve or reject the payment's review";
        const signHint = !sign && last.includes("=signature_requested") && "a step is waiting for a signature; pass sign";
        return [`last seen ${last || "nothing"}`, reviewHint, signHint].filter(Boolean).join("; ");
      },
    },
  );
}
