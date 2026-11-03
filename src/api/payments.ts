import { postWithRetry } from "../retry.ts";
import type { Envelope, Payment } from "../types.ts";

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
