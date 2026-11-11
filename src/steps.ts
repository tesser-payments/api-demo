import pc from "picocolors";
import { submitStepSignature } from "./api/payments.ts";
import { getRebalance, submitRebalanceStepSignature } from "./api/rebalances.ts";
import { ApiError, get, post } from "./client.ts";
import { poll } from "./retry.ts";
import type { Envelope, Payment, Rebalance, Step } from "./types.ts";

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

const allCompleted = (steps: Step[]) => steps.length > 0 && steps.every((s) => s.status === "completed");

// What each sign endpoint answers for a step that is no longer waiting for a signature.
const PAYMENT_STEP_NOT_SIGNABLE = "payments-3060";
const REBALANCE_STEP_NOT_SIGNABLE = "treasury-3013";

/** Resolves to the `signature` for the transaction a step asks to sign. */
export type SignStep<T> = (step: Step, transfer: T) => Promise<string>;

type SubmitSignature = (signed: { stepId: string; signature: string; idempotencyKey: string }) => Promise<void>;

/** Sign and submit each step that asks for a signature, once per transaction it asks to sign. */
function stepSigner<T extends { steps: Step[] }>({
  sign,
  submit,
  stepNotSignableCode,
}: {
  sign: SignStep<T>;
  submit: SubmitSignature;
  stepNotSignableCode: string;
}): (transfer: T) => Promise<void> {
  // Keyed by step and transaction: a retry resends the same signature and key, a new transaction is signed anew.
  const signatures = new Map<string, { signature: string; idempotencyKey: string; submitted: boolean }>();
  return async (transfer) => {
    for (const step of transfer.steps) {
      if (step.status !== "signature_requested" || !step.unsigned_transaction) continue;
      const transactionKey = `${step.id}:${step.unsigned_transaction}`;
      const known = signatures.get(transactionKey);
      if (known?.submitted) continue;
      const request = known ?? { signature: await sign(step, transfer), idempotencyKey: crypto.randomUUID(), submitted: false };
      signatures.set(transactionKey, request);
      try {
        await submit({ stepId: step.id, signature: request.signature, idempotencyKey: request.idempotencyKey });
      } catch (error) {
        // A resend after a lost response: 5xx isn't idempotency-cached, so the platform reports the step signed.
        const alreadyTaken = known !== undefined && error instanceof ApiError && error.hasCode(stepNotSignableCode);
        if (!alreadyTaken) throw error;
      }
      request.submitted = true;
      console.log(pc.dim(`  Signed step ${step.step_sequence}`));
    }
  };
}

const signatureHint = (last: string) => last.includes("=signature_requested") && "a step is waiting for a signature; pass sign";

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
  sign?: SignStep<Payment>;
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
  const signRequestedSteps =
    sign &&
    stepSigner({
      sign,
      submit: (signed) => submitStepSignature({ paymentId, ...signed }),
      stepNotSignableCode: PAYMENT_STEP_NOT_SIGNABLE,
    });
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
      await signRequestedSteps?.(payment);
      return allCompleted(payment.steps) ? payment : undefined;
    },
    {
      timeoutMs,
      intervalMs,
      timeoutHint: () => {
        const reviewHint = !decide && last.includes("risk=awaiting_decision") && "approve or reject the payment's review";
        const signHint = !sign && signatureHint(last);
        return [`last seen ${last || "nothing"}`, reviewHint, signHint].filter(Boolean).join("; ");
      },
    },
  );
}

export interface WaitForRebalanceOptions {
  /** Resolves to the `signature` for each transaction a step asks to sign; called again only after a transient error. */
  sign?: SignStep<Rebalance>;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll a rebalance until every step is completed, logging balance and step
 * changes. Fails fast on a failed step.
 */
export async function waitForRebalance(
  rebalanceId: string,
  { sign, timeoutMs = 10 * 60_000, intervalMs }: WaitForRebalanceOptions = {},
): Promise<Rebalance> {
  const signRequestedSteps =
    sign &&
    stepSigner({
      sign,
      submit: (signed) => submitRebalanceStepSignature({ rebalanceId, ...signed }),
      stepNotSignableCode: REBALANCE_STEP_NOT_SIGNABLE,
    });
  let last = "";

  return poll(
    "Rebalance",
    async () => {
      const rebalance = await getRebalance(rebalanceId);
      const summary = `balance=${rebalance.balance_status}  ${stepSummary(rebalance.steps)}`;
      if (summary !== last) console.log(pc.yellow(`  ${summary}`));
      last = summary;

      assertNoFailedStep("Rebalance", rebalance.steps);
      await signRequestedSteps?.(rebalance);
      return allCompleted(rebalance.steps) ? rebalance : undefined;
    },
    {
      timeoutMs,
      intervalMs,
      timeoutHint: () => [`last seen ${last || "nothing"}`, !sign && signatureHint(last)].filter(Boolean).join("; "),
    },
  );
}
