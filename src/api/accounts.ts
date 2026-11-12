import { get, getAll, post, postSignature } from "../client.ts";
import type { Payout } from "../payout.ts";
import { isTransient, poll } from "../retry.ts";
import type { Account, AccountType, Envelope } from "../types.ts";

export interface FundingBank {
  id: string;
  name: string;
  created: boolean;
}

// Stablecoin balances have 6 decimals; comparing all of them catches sub-cent fees.
const toMicros = (amount: string) => Math.round(parseFloat(amount) * 1_000_000);

const TEST_BANK_DETAILS = {
  bank_name: "Hancock Whitney Bank",
  bank_code_type: "ROUTING",
  bank_identifier_code: "065400153",
  bank_account_number: "000999999991",
  bank_swift_code: "BARCGB22",
};

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
    ...TEST_BANK_DETAILS,
    tenant_id: null,
    counterparty_id: null,
  });
  return { id: bank.data.id, name, created: true };
}

export async function createCounterpartyBank({ counterpartyId, name }: { counterpartyId: string; name: string }): Promise<string> {
  const bank = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name,
    ...TEST_BANK_DETAILS,
    counterparty_id: counterpartyId,
  });
  return bank.data.id;
}

/** A counterparty's account of `type` named exactly `name`; throws if several share it. */
export async function findCounterpartyAccount({ type, name }: { type: AccountType; name: string }): Promise<Account | undefined> {
  // `search` matches part of the name, so the exact match is filtered here.
  const candidates = await getAll<Account>(`/v1/accounts?type=${type}&search=${encodeURIComponent(name)}`);
  const matches = candidates.filter((a) => a.name === name && a.counterparty_id);
  if (matches.length > 1) {
    throw new Error(`${matches.length} counterparty accounts are named "${name}"; delete the extras so exactly one remains`);
  }
  return matches[0];
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
  payout: Pick<Payout, "walletType" | "address">;
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
 * A wallet Tesser holds keys for, on every EVM network. One attempt only: a 5xx
 * can follow a wallet Turnkey already created, and retries would log the signature.
 */
export async function createManagedEvmWallet({ name, signature }: { name: string; signature: string }): Promise<Account> {
  const wallet = await postSignature<Envelope<Account>>(
    "/v1/accounts/wallets",
    { name, type: "stablecoin_ethereum", is_managed: true, signature },
    { idempotencyKey: crypto.randomUUID() },
  );
  return wallet.data;
}

/** The workspace's first managed EVM wallet, created at signup: the first address of its master wallet. */
export async function findMasterWallet(): Promise<Account> {
  const listed = await getAll<Account>("/v1/accounts?type=stablecoin_ethereum&is_managed=true&entity_type=sub_org");
  const [master] = listed
    .filter((a) => a.is_managed && !a.tenant_id && !a.counterparty_id)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  if (!master) throw new Error("The workspace has no managed EVM wallet to use as its master wallet");
  return master;
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

export interface BalanceQuery {
  accountId: string;
  currency: string;
  /** A wallet holds a balance per network; leave it out for a ledger. */
  network?: string;
}

export async function getAccount(accountId: string): Promise<Account> {
  const { data } = await get<Envelope<Account>>(`/v1/accounts/${accountId}`);
  return data;
}

/** The account's available balance in `currency` (and `network`), "0" if it holds none. */
export async function getAvailableBalance({ accountId, currency, network }: BalanceQuery): Promise<string> {
  const account = await getAccount(accountId);
  const asset = account.assets?.find((a) => a.currency === currency && (!network || a.network === network));
  return asset?.available_balance ?? "0";
}

/**
 * Wait until the account's available balance in `currency` (and `network`) is
 * exactly `amount`. Throws as soon as it is higher, or lower when `falling`.
 */
export async function waitForBalance({
  amount,
  falling = false,
  ...query
}: BalanceQuery & { amount: string; falling?: boolean }): Promise<string> {
  const { accountId, currency } = query;
  return poll(
    "Account balance",
    async () => {
      const available = await getAvailableBalance(query);
      if (!falling && toMicros(available) > toMicros(amount)) {
        throw new Error(`Account ${accountId} holds ${available} ${currency}, more than the expected ${amount}`);
      }
      if (falling && toMicros(available) < toMicros(amount)) {
        throw new Error(`Account ${accountId} holds ${available} ${currency}, less than the expected ${amount}`);
      }
      return toMicros(available) === toMicros(amount) ? available : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 5_000, timeoutHint: `expected ${amount} ${currency} in account ${accountId}` },
  );
}

/** Throw unless the available balance stays exactly `amount` for `holdMs`. */
export async function assertBalanceHolds({
  amount,
  holdMs,
  ...query
}: BalanceQuery & { amount: string; holdMs: number }): Promise<void> {
  const deadline = Date.now() + holdMs;
  while (true) {
    try {
      const available = await getAvailableBalance(query);
      if (toMicros(available) !== toMicros(amount)) {
        throw new Error(`Account ${query.accountId} holds ${available} ${query.currency}, expected it to stay at ${amount}`);
      }
    } catch (error) {
      if (!isTransient(error)) throw error;
    }
    if (Date.now() >= deadline) return;
    await Bun.sleep(5_000);
  }
}
