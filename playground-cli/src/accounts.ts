import type { Interaction } from "./interaction.ts";
import { ApiError, UsageError } from "./errors.ts";
import { requireData, type TesserClient } from "./http.ts";

export type Account = {
  id?: string;
  name?: string;
  type?: string;
  tenant_id?: string | null;
  counterparty_id?: string | null;
  is_managed?: boolean;
  crypto_wallet_address?: string | null;
  workspace_id?: string;
  assets?: Array<{
    currency?: string;
    network?: string;
    available_balance?: string;
  }>;
  [key: string]: unknown;
};

export async function getAccount(client: TesserClient, accountId: string): Promise<Account> {
  const response = await client.request("GET", `/v1/accounts/${encodeURIComponent(accountId)}`, {
    operation: "Get account",
  });
  const account = requireData<Account>(response, "Get account");
  if (!account || typeof account !== "object") {
    throw new ApiError("Get account response did not contain an account", response.status, response.body);
  }
  return account;
}

export async function listAccounts(
  client: TesserClient,
  query: Array<[string, string]> = [],
): Promise<Account[]> {
  const accounts: Account[] = [];
  let page = 1;
  while (true) {
    const response = await client.request("GET", "/v1/accounts", {
      query: [...query, ["limit", "100"], ["page", String(page)]],
      operation: "List accounts",
    });
    const data = requireData<Account[]>(response, "List accounts");
    if (!Array.isArray(data)) {
      throw new ApiError("List accounts response did not contain an account list", response.status, response.body);
    }
    accounts.push(...data.filter((account): account is Account => Boolean(account && typeof account === "object")));
    const body = response.body as { pagination?: { has_next?: boolean } };
    if (body.pagination?.has_next !== true) return accounts;
    page += 1;
  }
}

export function accountSupports(account: Account, currency: string, network: string): boolean {
  return Boolean(
    account.assets?.some(
      (asset) => asset.currency === currency && asset.network === network,
    ),
  );
}

export async function chooseAccount(
  interaction: Interaction,
  label: string,
  accounts: Account[],
): Promise<Account> {
  if (!accounts.length) throw new UsageError(`No accounts match ${label}`);
  if (accounts.length === 1) return accounts[0]!;
  return interaction.choose(
    label,
    accounts.map((account) => ({
      name: `${account.name ?? "Unnamed"} (${account.id ?? "missing id"})`,
      value: account,
      description: account.type,
    })),
  );
}

export function requireAccountId(account: Account, label: string): string {
  if (!account.id) throw new UsageError(`${label} does not contain an ID`);
  return account.id;
}

export function requireWalletAddress(account: Account, label: string): string {
  if (!account.crypto_wallet_address) {
    throw new UsageError(`${label} does not contain crypto_wallet_address`);
  }
  return account.crypto_wallet_address;
}
