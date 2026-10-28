import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { authenticate } from "./client.ts";
import { assertNoFailedStep, stepSummary, waitForPayment } from "./steps.ts";
import type { Payment, RiskStatus, Step, StepStatus } from "./types.ts";

const leg = { account_id: null, amount: null, currency: null, network: null };
const overlay = { from: leg, to: leg };

const step = (status: StepStatus, extra: Partial<Step> = {}): Step => ({
  id: "s1",
  step_sequence: 1,
  step_type: "transfer",
  estimated: overlay,
  actual: overlay,
  status,
  created_at: "",
  updated_at: "",
  ...extra,
});

const payment = (risk_status: RiskStatus, steps: Step[]): Payment => ({
  id: "p1",
  workspace_id: "w1",
  direction: "outbound",
  funding_account_id: null,
  desired: overlay,
  estimated: overlay,
  actual: overlay,
  risk_status,
  balance_status: null,
  steps,
  created_at: "",
  updated_at: "",
  expires_at: null,
});

let logSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
const reviews: { body: unknown; key: string | undefined }[] = [];

// Auth, then each GET returns the next payment state; review POSTs are recorded.
async function serve(...states: Payment[]) {
  fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization) return Response.json({ access_token: "t" });
    if (String(url).endsWith("/review")) {
      reviews.push({ body: JSON.parse(String(init?.body)), key: headers["Idempotency-Key"] });
      return Response.json({ data: {} });
    }
    const next = states.length > 1 ? states.shift() : states[0];
    return Response.json({ data: next });
  });
  await authenticate();
}

beforeEach(() => {
  reviews.length = 0;
  process.env.TESSER_CLIENT_ID ||= "test";
  process.env.TESSER_CLIENT_SECRET ||= "test";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => {
  logSpy.mockRestore();
  fetchSpy.mockRestore();
});

const fast = { timeoutMs: 1_000, intervalMs: 1 };

describe("stepSummary and assertNoFailedStep", () => {
  test("summarise steps", () => {
    expect(stepSummary([step("confirmed"), step("created", { step_sequence: 2 })])).toBe(
      "step1=confirmed, step2=created",
    );
    expect(stepSummary([])).toBe("no steps yet");
  });

  test("a failed step throws with its status reasons", () => {
    const failed = step("failed", {
      status_reasons: [{ error_code: "payments-5001", error_message: "Circle payout failed" }],
    });
    expect(() => assertNoFailedStep("Payment", [failed])).toThrow(
      "Payment step 1 failed: payments-5001: Circle payout failed",
    );
    expect(() => assertNoFailedStep("Payment", [step("completed")])).not.toThrow();
  });
});

describe("waitForPayment", () => {
  test("returns once every step is completed", async () => {
    await serve(
      payment("unchecked", [step("created")]),
      payment("automatically_approved", [step("confirmed")]),
      payment("automatically_approved", [step("completed")]),
    );
    const result = await waitForPayment("p1", fast);
    expect(result.steps[0]!.status).toBe("completed");
  });

  test("asks once and records the review decision with an Idempotency-Key", async () => {
    await serve(
      payment("awaiting_decision", [step("created")]),
      payment("manually_approved", [step("completed")]),
    );
    const decide = mock(async () => true);
    await waitForPayment("p1", { ...fast, decide, reason: "ok" });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(reviews).toEqual([{ body: { is_approved: true, reason: "ok" }, key: expect.any(String) }]);
  });

  test("without decide, it waits for someone else to review", async () => {
    await serve(
      payment("awaiting_decision", [step("created")]),
      payment("awaiting_decision", [step("created")]),
      payment("manually_approved", [step("completed")]),
    );
    await waitForPayment("p1", fast);
    expect(reviews).toHaveLength(0);
  });

  test("a rejection fails at once", async () => {
    await serve(payment("automatically_rejected", [step("failed")]));
    await expect(waitForPayment("p1", fast)).rejects.toThrow("was rejected (automatically_rejected)");
  });

  test("a failed step fails at once with its reasons", async () => {
    await serve(
      payment("automatically_approved", [
        step("failed", { status_reasons: [{ error_code: "payments-5001", error_message: "boom" }] }),
      ]),
    );
    await expect(waitForPayment("p1", fast)).rejects.toThrow("payments-5001: boom");
  });
});
