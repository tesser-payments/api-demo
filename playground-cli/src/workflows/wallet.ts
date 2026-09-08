import {
  accountSupports,
  chooseAccount,
  getAccount,
  listAccounts,
  requireWalletAddress,
  type Account,
} from "../accounts.ts";
import type { Runtime } from "../runtime.ts";

export type WalletOptions = {
  walletId?: string;
  currency?: string;
  network?: string;
};

export async function resolveWallet(
  runtime: Runtime,
  options: WalletOptions,
  defaults: { currency?: string; network?: string } = {},
): Promise<Account> {
  const walletId = options.walletId;
  if (walletId) return getAccount(runtime.client, walletId);
  const currency = options.currency ?? defaults.currency ?? (runtime.interaction.interactive ? undefined : "USDC");
  const network = options.network ?? defaults.network;
  const resolvedCurrency = (await runtime.interaction.text("Wallet currency", currency, "USDC")).toUpperCase();
  const resolvedNetwork = (await runtime.interaction.text("Wallet network", network, "BASE_SEPOLIA")).toUpperCase();
  const accounts = await listAccounts(runtime.client, [["entity_type", "sub_org"]]);
  const matches = accounts.filter(
    (account) =>
      account.tenant_id == null &&
      account.counterparty_id == null &&
      Boolean(account.crypto_wallet_address) &&
      accountSupports(account, resolvedCurrency, resolvedNetwork),
  );
  return chooseAccount(runtime.interaction, `${resolvedCurrency} ${resolvedNetwork} wallet`, matches);
}

export async function runWalletAddress(runtime: Runtime, options: WalletOptions): Promise<void> {
  const account = await resolveWallet(runtime, options);
  runtime.output.result({
    accountId: account.id,
    address: requireWalletAddress(account, `Wallet ${account.id ?? ""}`),
  });
}
