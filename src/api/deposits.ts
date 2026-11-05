import pc from "picocolors";
import { get } from "../client.ts";
import { poll, postWithRetry } from "../retry.ts";
import { assertNoFailedStep, stepSummary } from "../steps.ts";
import type { Deposit, Envelope, Step } from "../types.ts";

/**
 * A fiat → stablecoin deposit, e.g. USD from a bank into a ledger as USDC.
 * Circle matches a simulated wire to its deposit by exact amount, so give
 * each deposit its own amount.
 */
export async function createDeposit({
  fromAccountId,
  toAccountId,
  amount,
  fromCurrency,
  toCurrency,
  reference,
}: {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  fromCurrency: string;
  toCurrency: string;
  reference: string;
}): Promise<string> {
  const deposit = await postWithRetry<Envelope<Deposit>>("Deposit", "/v1/treasury/deposits", {
    organization_reference_id: reference,
    desired: {
      from: { account_id: fromAccountId, amount, currency: fromCurrency },
      to: { account_id: toAccountId, currency: toCurrency },
    },
  });
  return deposit.data.id;
}

/**
 * Wait until the deposit is planned. Planning runs asynchronously; until it
 * does, the deposit has no steps and simulate fails with treasury-3101.
 */
export async function waitForDepositPlan(depositId: string): Promise<Step[]> {
  return poll(
    "Deposit planning",
    async () => {
      const { data } = await get<Envelope<Deposit>>(`/v1/treasury/deposits/${depositId}`);
      const steps = data.steps ?? [];
      assertNoFailedStep("Deposit", steps);
      return steps.length > 0 ? steps : undefined;
    },
    {
      timeoutMs: 2 * 60_000,
      intervalMs: 5_000,
      timeoutHint:
        "The deposit was never planned and the API gives no reason. The usual cause is a Circle account with no linked wire bank",
    },
  );
}

/**
 * Send a mock wire for the deposit (sandbox only). The response shows the
 * deposit as it was before the simulation.
 */
export async function simulateWire(depositId: string): Promise<Deposit> {
  // Idempotency-Key: a retried simulate must not send the mock wire twice.
  const res = await postWithRetry<Envelope<Deposit>>(
    "Simulate",
    `/v1/treasury/deposits/${depositId}/simulate`,
    {},
  );
  return res.data;
}

/**
 * Wait until every deposit step is completed. Circle settles the simulated
 * wire asynchronously via webhook.
 */
export async function waitForDepositCompletion(depositId: string): Promise<Deposit> {
  let last = "";
  return poll(
    "Deposit settlement",
    async () => {
      const { data } = await get<Envelope<Deposit>>(`/v1/treasury/deposits/${depositId}`);
      const steps = data.steps ?? [];
      assertNoFailedStep("Deposit", steps);
      const summary = stepSummary(steps);
      if (summary !== last) console.log(pc.yellow(`  Deposit: ${summary}`));
      last = summary;
      return steps.length > 0 && steps.every((s) => s.status === "completed") ? data : undefined;
    },
    {
      timeoutMs: 10 * 60_000,
      timeoutHint: "Circle settles the simulated wire by webhook; check the Circle webhook subscription for this environment",
    },
  );
}
