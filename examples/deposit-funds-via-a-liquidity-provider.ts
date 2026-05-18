import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, getAll, post } from "../src/client.ts";

export const meta = {
  name: "Deposit funds via a liquidity provider (Circle Mint)",
  description:
    "USD → USDC into a managed Circle Mint ledger. Creates a fresh counterparty + ledger each run, finds-or-creates an org-level unmanaged bank, posts a deposit, simulates it, and polls until the DEA overlay's `actual` populates.",
  docUrl:
    "https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider",
} as const;

export interface DepositLpInput {
  /** Amount in fromCurrency, as a decimal string (e.g. "100.00"). */
  depositAmount: string;
  /** Defaults to "USD". */
  fromCurrency?: string;
  /** Defaults to "USDC". */
  toCurrency?: string;
}

export interface DepositLpResult {
  depositId: string;
  ledgerAccountId: string;
  deposit: DepositResponse;
}

interface DepositResponse {
  id: string;
  desired?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  estimated?: unknown;
  actual?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  steps?: {
    step_sequence: number;
    status: string;
    status_reasons?: string | null;
    finalized_at?: string | null;
    completed_at?: string | null;
  }[];
}

export async function run(input: DepositLpInput): Promise<DepositLpResult> {
  throw new Error("not implemented");
}

if (import.meta.main) {
  await authenticate();
  const result = await run({
    depositAmount: process.env.TESSER_TEST_DEPOSIT_AMOUNT ?? "100.00",
  });
  console.log(pc.green(`\nDeposit ${result.depositId} complete.`));
}
