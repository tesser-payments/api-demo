import { authenticate, getAll } from "../../src/client.ts";
import { findWorkspaceBank } from "../../src/api/accounts.ts";
import type { Account } from "../../src/types.ts";

export const RUN_ID = crypto.randomUUID().slice(0, 8);
export const BALANCE_HOLD_MS = 30_000;

export const exactly = (amount: number) => amount.toFixed(6);
export const ledgerAsset = (ledgerId: string, currency: string) => ({ accountId: ledgerId, currency });

export interface OpenfxAccounts {
  ledger: Account;
  /** The workspace bank, whose account number OpenFX has as a USD withdrawal address. */
  bank: Account;
}

let openfxAccountsLookup: Promise<OpenfxAccounts> | undefined;

// Connecting OpenFX can't be done through the Tesser API, so the tests use accounts set up ahead of time.
export function openfxAccounts(): Promise<OpenfxAccounts> {
  openfxAccountsLookup ??= (async () => {
    await authenticate();
    const [ledger, bank] = await Promise.all([findOpenfxLedger(), findWorkspaceBank()]);
    if (!bank) {
      throw new Error("The workspace has no bank account of its own; create one with OpenFX's USD withdrawal address details");
    }
    return { ledger, bank };
  })();
  return openfxAccountsLookup;
}

// Storing the organization's OpenFX credentials creates the workspace's one OpenFX ledger.
async function findOpenfxLedger(): Promise<Account> {
  const ledgers = await getAll<Account>("/v1/accounts?type=ledger");
  const openfxLedgers = ledgers.filter((a) => a.provider === "OPENFX" && !a.tenant_id && !a.counterparty_id);
  if (openfxLedgers.length !== 1) {
    throw new Error(
      `The workspace has ${openfxLedgers.length} OpenFX ledgers, expected exactly 1; store the organization's OpenFX credentials to create it`,
    );
  }
  return openfxLedgers[0]!;
}
