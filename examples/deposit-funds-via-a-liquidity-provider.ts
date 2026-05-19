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

export interface DepositResponse {
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
  const fromCurrency = input.fromCurrency ?? "USD";
  const toCurrency = input.toCurrency ?? "USDC";

  // 1. Store Circle Mint API key in vault (idempotent).
  await ensureCircleMintKey();

  // 2. Find-or-create an org-level unmanaged bank account as funding source.
  const fundingBankId = await findOrCreateFundingBank();
  console.log(`  Funding bank: ${pc.cyan(fundingBankId)}`);

  // 3. Create a fresh business counterparty for this run.
  const customerName = faker.company.name();
  const customer = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "business",
      business_legal_name: customerName,
      business_dba: customerName,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({
        length: 20,
        casing: "upper",
      }),
    },
  );
  console.log(
    `  Counterparty: ${customerName} ${pc.dim(`(${customer.data.id})`)}`,
  );

  // 4. Create a Circle Mint ledger account tied to that counterparty.
  const ledger = await post<{ data: { id: string } }>(
    "/v1/accounts/ledgers",
    {
      name: `${customerName}'s Ledger`,
      provider: "CIRCLE_MINT",
      counterparty_id: customer.data.id,
    },
  );
  const ledgerAccountId = ledger.data.id;
  console.log(`  Ledger account: ${pc.cyan(ledgerAccountId)}`);

  // 4.5. Wait for Circle to finish provisioning the ledger before depositing.
  await waitForLedgerProvisioned(ledgerAccountId);

  // 5. Create the deposit.
  const created = await post<{ data: DepositResponse }>(
    "/v1/treasury/deposits",
    {
      tenant_id: null,
      desired: {
        from: {
          account_id: fundingBankId,
          amount: input.depositAmount,
          currency: fromCurrency,
        },
        to: {
          account_id: ledgerAccountId,
          currency: toCurrency,
        },
      },
    },
  );
  const depositId = created.data.id;
  console.log(`  Deposit ID: ${pc.cyan(depositId)}`);

  // 6. Sandbox-only: simulate the deposit so funds arrive.
  await post(`/v1/treasury/deposits/${depositId}/simulate`, {});
  console.log(pc.dim("  Simulated"));

  // 7. Poll the deposit resource until DEA `actual.to.amount` populates.
  const terminal = await pollDepositTerminal(depositId);

  return { depositId, ledgerAccountId, deposit: terminal };
}

async function ensureCircleMintKey(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CIRCLE_API_KEY is required for the deposit-via-LP example. " +
        "Set it in .env and re-run.",
    );
  }
  try {
    await post("/v1/organizations/secrets", {
      provider: "CIRCLE_MINT",
      key: "CIRCLE_MINT_API_KEY",
      value: apiKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // secrets-0002 means "already configured" — idempotent.
    if (!msg.includes("secrets-0002")) throw err;
  }
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

interface LedgerAccount {
  id: string;
  metadata?: {
    circle_mint?: {
      circle_compliance_state?: string;
    };
  };
}

async function waitForLedgerProvisioned(ledgerAccountId: string): Promise<void> {
  const intervalMs = 5_000;
  const deadline = Date.now() + 2 * 60 * 1000; // 2 minutes
  while (true) {
    const res = await get<{ data: LedgerAccount }>(
      `/v1/accounts/${ledgerAccountId}`,
    );
    const state = res.data.metadata?.circle_mint?.circle_compliance_state;
    if (state === "ACCEPTED") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ledger ${ledgerAccountId} not provisioned within 2 min ` +
          `(circle_compliance_state=${state ?? "unset"})`,
      );
    }
    console.log(pc.dim(`  Waiting for Circle provisioning (state=${state ?? "unset"})…`));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function pollDepositTerminal(depositId: string): Promise<DepositResponse> {
  const intervalMs = 5_000;
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
  let lastLog = "";
  while (true) {
    const res = await get<{ data: DepositResponse }>(
      `/v1/treasury/deposits/${depositId}`,
    );
    const d = res.data;
    const failed = d.steps?.find((s) => s.status === "failed");
    if (failed) {
      throw new Error(
        `Deposit step ${failed.step_sequence} failed: ${failed.status_reasons}`,
      );
    }
    const log = (d.steps ?? [])
      .map((s) => `step${s.step_sequence}=${s.status}`)
      .join(", ");
    if (log !== lastLog) {
      console.log(pc.yellow(`  Poll: ${log}`));
      lastLog = log;
    }
    if (d.actual?.to?.amount) {
      console.log(
        pc.green(`  Deposit terminal: actual.to=${d.actual.to.amount}`),
      );
      return d;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Deposit ${depositId} did not terminate within 5 min`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  await authenticate();
  const result = await run({
    depositAmount: process.env.TESSER_TEST_DEPOSIT_AMOUNT ?? "100.00",
  });
  console.log(pc.green(`\nDeposit ${result.depositId} complete.`));
}
