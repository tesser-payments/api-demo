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
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll a payment until every step is completed, logging risk, balance and
 * step changes. Fails fast on a risk rejection or a failed step.
 */
export async function waitForPayment(
  paymentId: string,
  { decide, reason, timeoutMs = 10 * 60_000, intervalMs }: WaitForPaymentOptions = {},
): Promise<Payment> {
  const reviewKey = crypto.randomUUID();
  let decision: boolean | undefined;
  let reviewed = false;
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
