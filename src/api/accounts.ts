import { get, getAll, post } from "../client.ts";
import type { Payout } from "../payout.ts";
import { poll } from "../retry.ts";
import type { Account, Envelope } from "../types.ts";

export interface FundingBank {
  id: string;
  name: string;
  created: boolean;
}

const toCents = (amount: string) => Math.round(parseFloat(amount) * 100);

/**
 * The workspace's own fiat bank (unmanaged, no tenant, no counterparty) that
 * deposits are wired from. Created on first use.
 */
export async function findOrCreateFundingBank(): Promise<FundingBank> {
  const accounts = await getAll<Account>("/v1/accounts");
  const existing = accounts.find(
    (a) => a.type === "fiat_bank" && !a.is_managed && !a.tenant_id && !a.counterparty_id,
  );
  if (existing) return { id: existing.id, name: existing.name, created: false };

  const name = "Depositing Bank";
  const bank = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name,
    bank_name: "Hancock Whitney Bank",
    bank_code_type: "ROUTING",
    bank_identifier_code: "065400153",
    bank_account_number: "000999999991",
    tenant_id: null,
    counterparty_id: null,
    bank_swift_code: "BARCGB22",
  });
  return { id: bank.data.id, name, created: true };
}

export async function createCircleLedger({ counterpartyId, name }: { counterpartyId: string; name: string }): Promise<string> {
  const ledger = await post<{ data: { id: string } }>("/v1/accounts/ledgers", {
    name,
    provider: "CIRCLE_MINT",
    counterparty_id: counterpartyId,
  });
  return ledger.data.id;
}

/**
 * A wallet Tesser pays out to but doesn't hold keys for. A Stellar address
 * must have a USDC trustline to receive USDC.
 */
export async function createUnmanagedWallet({
  counterpartyId,
  name,
  payout,
}: {
  counterpartyId: string;
  name: string;
  payout: Payout;
}): Promise<string> {
  const wallet = await post<{ data: { id: string } }>("/v1/accounts/wallets", {
    name,
    type: payout.walletType,
    is_managed: false,
    wallet_address: payout.address,
    counterparty_id: counterpartyId,
  });
  return wallet.data.id;
}

/**
 * Wait until Circle accepts the ledger's compliance. Deposits into the ledger
 * are rejected (treasury-3103) until then. The platform checks after 10s,
 * retries 5 times 30s apart, then every 30 min.
 */
export async function waitForLedgerCompliance({
  ledgerAccountId,
  counterpartyId,
}: {
  ledgerAccountId: string;
  counterpartyId: string;
}): Promise<void> {
  await poll(
    "Ledger compliance",
    async () => {
      const res = await get<{ data: Account[] }>(
        `/v1/accounts?type=ledger&counterparty_id=${counterpartyId}&compliance_accepted=true`,
      );
      return res.data.some((a) => a.id === ledgerAccountId) ? true : undefined;
    },
    {
      timeoutMs: 35 * 60_000,
      timeoutHint: "Circle compliance is still PENDING; after its first checks the platform only rechecks every 30 min",
    },
  );
}

/**
 * Wait until the account's available balance in `currency` is exactly
 * `amount`. Throws as soon as it is higher.
 */
export async function waitForBalance({
  accountId,
  currency,
  amount,
}: {
  accountId: string;
  currency: string;
  amount: string;
}): Promise<string> {
  return poll(
    "Account balance",
    async () => {
      const { data } = await get<Envelope<Account>>(`/v1/accounts/${accountId}`);
      const available = data.assets?.find((a) => a.currency === currency)?.available_balance ?? "0";
      if (toCents(available) > toCents(amount)) {
        throw new Error(`Account ${accountId} holds ${available} ${currency}, more than the expected ${amount}`);
      }
      return toCents(available) === toCents(amount) ? available : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 5_000, timeoutHint: `expected ${amount} ${currency} in account ${accountId}` },
  );
}
