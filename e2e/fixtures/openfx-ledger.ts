import { authenticate } from "../../src/client.ts";
import { getAccount } from "../../src/api/accounts.ts";
import type { Account } from "../../src/types.ts";
import { requireEnv } from "./preflight.ts";

export const RUN_ID = crypto.randomUUID().slice(0, 8);
export const BALANCE_HOLD_MS = 30_000;

export const exactly = (amount: number) => amount.toFixed(6);
export const ledgerAsset = (ledgerId: string, currency: string) => ({ accountId: ledgerId, currency });

export interface OpenfxAccounts {
  ledger: Account;
  /** The workspace's bank account, registered with OpenFX, that withdrawals pay into. */
  bank: Account;
}

let openfxAccountsLookup: Promise<OpenfxAccounts> | undefined;

// Connecting OpenFX can't be done through the Tesser API, so the tests use accounts set up ahead of time.
export function openfxAccounts(): Promise<OpenfxAccounts> {
  openfxAccountsLookup ??= (async () => {
    const ledgerId = requireEnv("OPENFX_LEDGER_ID");
    const bankId = requireEnv("OPENFX_BANK_ID");
    await authenticate();
    const [ledger, bank] = await Promise.all([getAccount(ledgerId), getAccount(bankId)]);
    if (ledger.type !== "ledger" || ledger.provider !== "OPENFX") {
      throw new Error(`OPENFX_LEDGER_ID ${ledgerId} is a ${ledger.type} at ${ledger.provider ?? "no provider"}, not an OpenFX ledger`);
    }
    if (bank.type !== "fiat_bank") {
      throw new Error(`OPENFX_BANK_ID ${bankId} is a ${bank.type}, not a bank account`);
    }
    return { ledger, bank };
  })();
  return openfxAccountsLookup;
}
