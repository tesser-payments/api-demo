import { getAll, post } from "../client.ts";
import type { InboundNetwork } from "../inbound.ts";
import { poll, postWithRetry } from "../retry.ts";
import type { Envelope, MockedRiskStatus, Payment, SimulatedInboundPending } from "../types.ts";

/**
 * A same-currency payout from one account to another. The source account
 * funds it, so it must belong to a counterparty or tenant.
 */
export async function createPayment({
  fromAccountId,
  toAccountId,
  amount,
  currency,
  network,
  reference,
}: {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  currency: string;
  network: string;
  reference: string;
}): Promise<string> {
  const payment = await postWithRetry<Envelope<Payment>>(
    "Payment",
    "/v1/payments",
    {
      organization_reference_id: reference,
      funding_account_id: fromAccountId,
      desired: {
        from: { account_id: fromAccountId, amount, currency, network },
        to: { account_id: toAccountId, currency, network },
      },
    },
    // payments-3017: the beneficiary's Circle recipient isn't active yet
    { retryOn: ["payments-3017"], attempts: 30 },
  );
  return payment.data.id;
}

/**
 * Sandbox only: Tesser sends 1 test USDC to the managed wallet `toAccountId`, with
 * the sender's screening verdict forced to `mockedRiskStatus`. Returns the payment id.
 */
export async function simulateInbound({
  toAccountId,
  mockedRiskStatus,
  network,
}: {
  toAccountId: string;
  mockedRiskStatus: MockedRiskStatus;
  network: InboundNetwork;
}): Promise<string> {
  // Allows for clock skew between this machine and the platform.
  const searchFrom = new Date(Date.now() - 5 * 60_000).toISOString();
  // Never retried: the platform can answer 5xx after it has sent the USDC.
  const { data } = await post<Envelope<Payment | SimulatedInboundPending>>(
    "/v1/payments/simulate-inbound",
    { to_account: toAccountId, mocked_risk_status: mockedRiskStatus, network },
    { idempotencyKey: crypto.randomUUID() },
  );
  if (!("tx_hash" in data)) return data.id;
  if (data.payment_id) return data.payment_id;
  return waitForInboundPayment({ txHash: data.tx_hash, searchFrom });
}

async function waitForInboundPayment({ txHash, searchFrom }: { txHash: string; searchFrom: string }): Promise<string> {
  const hash = txHash.toLowerCase();
  return poll(
    "Inbound detection",
    async () => {
      const payments = await getAll<Payment>(`/v1/payments?direction=inbound&start_date=${encodeURIComponent(searchFrom)}`);
      return payments.find((p) => p.steps.some((s) => s.transaction_hash?.toLowerCase() === hash))?.id;
    },
    {
      timeoutMs: 5 * 60_000,
      timeoutHint: `no inbound payment has transaction ${txHash}; the platform may not be watching the wallet on this network yet`,
    },
  );
}
