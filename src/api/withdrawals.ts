import { get } from "../client.ts";
import { postWithRetry } from "../retry.ts";
import type { Envelope, Withdrawal } from "../types.ts";

/** A withdrawal from a managed ledger at a liquidity provider to the workspace's bank account. */
export async function createLedgerWithdrawal({
  ledgerId,
  bankAccountId,
  amount,
  fromCurrency,
  toCurrency,
  reference,
}: {
  ledgerId: string;
  bankAccountId: string;
  amount: string;
  fromCurrency: string;
  toCurrency: string;
  reference: string;
}): Promise<Withdrawal> {
  const withdrawal = await postWithRetry<Envelope<Withdrawal>>(
    "Withdrawal",
    "/v1/treasury/withdrawals",
    {
      organization_reference_id: reference,
      desired: {
        from: { account_id: ledgerId, amount, currency: fromCurrency },
        to: { account_id: bankAccountId, currency: toCurrency },
      },
    },
    { attempts: 30 },
  );
  return withdrawal.data;
}

export async function getWithdrawal(withdrawalId: string): Promise<Withdrawal> {
  const { data } = await get<Envelope<Withdrawal>>(`/v1/treasury/withdrawals/${withdrawalId}`);
  return data;
}
