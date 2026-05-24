// Tutorial 03: Deposit USD into the Circle Mint ledger.
//
// Reads `ledgerAccountId` from `tutorials/.state.json` (written by
// tutorial 02). Finds-or-creates an org-level unmanaged bank account as
// the funding source, then POSTs a USD → USDC deposit, simulates it
// (sandbox-only), and polls until the deposit's DEA `actual.to.amount`
// populates.
//
// Standalone run (after tutorial 02):
//   bun run tutorials/03-deposit-via-LP.ts
//
// Derived from the deposit + simulate + poll blocks in
// `examples/deposit-funds-via-a-liquidity-provider.ts`. Source docs:
// https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider

import pc from "picocolors";
import { authenticate, get, getAll, post } from "../src/client.ts";
import { retryUntilSettled, waitUntil } from "../src/wait.ts";
import { loadState, saveState } from "./state.ts";

export interface DepositResult {
  depositId: string;
  ledgerAccountId: string;
  finalBalance: string;
}

const DEPOSIT_AMOUNT = "100.00";

export async function tutorial(): Promise<DepositResult> {
  const state = loadState();
  if (!state.ledgerAccountId) {
    throw new Error(
      "tutorials/.state.json is missing `ledgerAccountId`. " +
        "Run `bun run tutorials/02-create-a-ledger.ts` first.",
    );
  }

  // 1. Find-or-create the org-level unmanaged bank that will be the deposit
  //    source. In production you'd register your own bank account once and
  //    reference its ID. Sandbox auto-provisions a default Hancock Whitney
  //    routing for testing.
  const fundingBankId = await findOrCreateFundingBank();

  // 2. POST the deposit. The DEA `desired` overlay carries the input shape;
  //    `estimated` and `actual` populate as the platform plans and executes
  //    the deposit steps.
  const created = await post<{ data: { id: string } }>(
    "/v1/treasury/deposits",
    {
      tenant_id: null,
      desired: {
        from: {
          account_id: fundingBankId,
          amount: DEPOSIT_AMOUNT,
          currency: "USD",
        },
        to: {
          account_id: state.ledgerAccountId,
          currency: "USDC",
        },
      },
    },
  );
  const depositId = created.data.id;

  // 3. Sandbox-only: simulate the wire deposit so funds arrive. The deposit
  //    step/account wiring is asynchronous, so we retry on the specific
  //    treasury-3111 race; any other error is real and propagates.
  await simulateWhenReady(depositId);

  // 4. Poll the deposit resource until DEA `actual.to.amount` is non-null
  //    (terminal state).
  const terminal = await pollUntilTerminal(depositId);

  saveState({ depositId });
  return {
    depositId,
    ledgerAccountId: state.ledgerAccountId,
    finalBalance: terminal.actual?.to?.amount ?? "0",
  };
}

async function findOrCreateFundingBank(): Promise<string> {
  const accounts = await getAll<{
    id: string;
    type: string;
    is_managed?: boolean | null;
    tenant_id?: string | null;
    counterparty_id?: string | null;
  }>("/v1/accounts");
  const existing = accounts.find(
    (a) =>
      a.type === "fiat_bank" &&
      !a.is_managed &&
      !a.tenant_id &&
      !a.counterparty_id,
  );
  if (existing) return existing.id;
  const created = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name: "Depositing Bank",
    bank_name: "Hancock Whitney Bank",
    bank_code_type: "ROUTING",
    bank_identifier_code: "065400153",
    bank_account_number: "000999999991",
    tenant_id: null,
    counterparty_id: null,
    bank_swift_code: "BARCGB22",
  });
  return created.data.id;
}

async function simulateWhenReady(depositId: string): Promise<void> {
  await retryUntilSettled(
    () => post(`/v1/treasury/deposits/${depositId}/simulate`, {}),
    (err) => err instanceof Error && err.message.includes("treasury-3111"),
    {
      timeoutMs: 60_000,
      intervalMs: 5_000,
      describe: `deposit ${depositId} simulate`,
    },
  );
}

interface DepositResource {
  steps?: { step_sequence: number; status: string; status_reasons?: unknown }[];
  actual?: { to?: { amount?: string } };
}

async function pollUntilTerminal(depositId: string): Promise<DepositResource> {
  // Sandbox-simulated deposits can take up to 20 min to complete.
  const terminal = await waitUntil(
    () => get<{ data: DepositResource }>(`/v1/treasury/deposits/${depositId}`),
    (res) => {
      const failed = res.data.steps?.find((s) => s.status === "failed");
      if (failed) {
        throw new Error(`Deposit step ${failed.step_sequence} failed`);
      }
      return Boolean(res.data.actual?.to?.amount);
    },
    {
      timeoutMs: 25 * 60 * 1000,
      intervalMs: 10_000,
      describe: `deposit ${depositId} terminal (actual.to.amount populated)`,
    },
  );
  return terminal.data;
}

if (import.meta.main) {
  await authenticate();
  const result = await tutorial();
  console.log(
    `Deposit ${pc.cyan(result.depositId)} complete. ` +
      `Ledger ${result.ledgerAccountId} now holds ${result.finalBalance} USDC.`,
  );
  console.log("");
  console.log(pc.dim("Saved to tutorials/.state.json. Next step:"));
  console.log(`  bun run tutorials/04-payout-stellar.ts`);
}
