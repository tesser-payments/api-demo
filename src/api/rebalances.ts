import { get, postSignature } from "../client.ts";
import { postWithRetry } from "../retry.ts";
import type { Envelope, Rebalance } from "../types.ts";

/** A same-currency move between two of the workspace's managed wallets on one network. */
export async function createRebalance({
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
}): Promise<Rebalance> {
  const rebalance = await postWithRetry<Envelope<Rebalance>>(
    "Rebalance",
    "/v1/treasury/rebalances",
    {
      organization_reference_id: reference,
      desired: {
        from: { account_id: fromAccountId, amount, currency, network },
        to: { account_id: toAccountId, currency, network },
      },
    },
    // 5 min of transient failures, as for a payment, rather than the default 10.
    { attempts: 30 },
  );
  return rebalance.data;
}

export async function getRebalance(rebalanceId: string): Promise<Rebalance> {
  const { data } = await get<Envelope<Rebalance>>(`/v1/treasury/rebalances/${rebalanceId}`);
  return data;
}

/**
 * Submit the signature for a rebalance's wallet step. Not retried here, so a
 * retry by the caller resends the same signature under the same key.
 */
export async function submitRebalanceStepSignature({
  rebalanceId,
  stepId,
  signature,
  idempotencyKey,
}: {
  rebalanceId: string;
  stepId: string;
  signature: string;
  idempotencyKey: string;
}): Promise<void> {
  await postSignature(`/v1/treasury/rebalances/${rebalanceId}/steps/${stepId}/sign`, { signature }, { idempotencyKey });
}
