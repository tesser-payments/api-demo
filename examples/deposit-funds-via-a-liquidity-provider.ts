import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, getAll, post } from "../src/client.ts";
import { retryUntilSettled, waitUntil } from "../src/wait.ts";

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
  /**
   * Optional tenant ID. When provided, the counterparty is created under
   * the tenant; the ledger inherits tenant scope via its counterparty.
   * Omit for org-level deposits.
   */
  tenantId?: string;
  /**
   * Pre-existing Circle Mint ledger to deposit into. When provided, the
   * example skips counterparty + ledger creation and uses this ledger
   * directly. Useful for composing multiple flows against one ledger.
   */
  ledgerAccountId?: string;
  /**
   * Whether to create a fresh business counterparty and associate it with
   * the ledger. Defaults to true. When false, no counterparty is created and
   * the ledger is created without a counterparty_id.
   */
  withCounterparty?: boolean;
}

export interface DepositLpResult {
  depositId: string;
  ledgerAccountId: string;
  counterpartyId: string | null;
  deposit: DepositResponse;
}

export interface DepositResponse {
  id: string;
  direction?: string;
  expires_at?: string;
  desired?: {
    from?: { account_id?: string; currency?: string; amount?: string | null };
    to?: { account_id?: string; currency?: string; amount?: string | null };
  };
  estimated?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  actual?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  steps?: {
    step_sequence: number;
    status: string;
    status_reasons?: string[] | string | null;
    provider_key?: string;
    step_type?: string;
    transaction_hash?: string | null;
    fees?: unknown[];
    submitted_at?: string | null;
    confirmed_at?: string | null;
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

  // 3-4. Pick a destination ledger. Cases, in order:
  //   a) Caller passed `ledgerAccountId` → reuse it.
  //   b) `withCounterparty: false` and no `tenantId` → use the workspace-level
  //      Circle Mint ledger that the platform auto-creates the first time a
  //      Circle Mint API key is registered (you can't POST a new workspace
  //      ledger; accounts-3006 rejects it).
  //   c) Otherwise → create a fresh counterparty (when requested) and a
  //      fresh ledger scoped by counterparty or tenant.
  let ledgerAccountId: string;
  let counterpartyId: string | null = null;
  if (input.ledgerAccountId) {
    ledgerAccountId = input.ledgerAccountId;
    console.log(`  Ledger account: ${pc.cyan(ledgerAccountId)} ${pc.dim("(reused)")}`);
  } else if (input.withCounterparty === false && !input.tenantId) {
    const found = await findWorkspaceCircleMintLedger();
    if (!found) {
      throw new Error(
        "No workspace-level Circle Mint ledger found in this workspace. " +
          "It is auto-created when a Circle Mint API key is first registered " +
          "via POST /v1/organizations/secrets — register one and retry.",
      );
    }
    ledgerAccountId = found;
    console.log(
      `  Workspace ledger: ${pc.cyan(ledgerAccountId)} ${pc.dim("(auto-created by Circle Mint key registration)")}`,
    );
  } else {
    // 3. Optionally create a fresh business counterparty.
    let customerName = "(no counterparty)";
    if (input.withCounterparty !== false) {
      customerName = faker.company.name();
      const counterpartyPayload: Record<string, unknown> = {
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
      };
      if (input.tenantId) counterpartyPayload.tenant_id = input.tenantId;
      const customer = await post<{ data: { id: string } }>(
        "/v1/entities/counterparties",
        counterpartyPayload,
      );
      counterpartyId = customer.data.id;
      console.log(
        `  Counterparty: ${customerName} ${pc.dim(`(${counterpartyId})`)}`,
      );
    }

    // 4. Create a Circle Mint ledger account.
    // Platform constraint: the ledger payload must carry EXACTLY ONE of
    // counterparty_id or tenant_id (workspace-only and both-at-once are
    // both rejected — accounts-3006 / accounts-3000). When a counterparty
    // exists, the ledger inherits tenant scope through the counterparty.
    const ledgerPayload: Record<string, unknown> = {
      name: `${customerName}'s Ledger`,
      provider: "CIRCLE_MINT",
    };
    if (counterpartyId) {
      ledgerPayload.counterparty_id = counterpartyId;
    } else if (input.tenantId) {
      ledgerPayload.tenant_id = input.tenantId;
    } else {
      throw new Error(
        "Circle Mint ledgers require a tenant or a counterparty. " +
          "Pass tenantId, set withCounterparty true (default), or both.",
      );
    }
    const ledger = await post<{ data: { id: string } }>(
      "/v1/accounts/ledgers",
      ledgerPayload,
    );
    ledgerAccountId = ledger.data.id;
    console.log(`  Ledger account: ${pc.cyan(ledgerAccountId)}`);

    // Wait for Circle compliance ACCEPTED before depositing into a new ledger.
    await waitForLedgerProvisioned(ledgerAccountId);
  }

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
  await simulateDepositWhenReady(depositId);
  console.log(pc.dim("  Simulated"));

  // 7. Poll the deposit resource until DEA `actual.to.amount` populates.
  const terminal = await pollDepositTerminal(depositId);

  return { depositId, ledgerAccountId, counterpartyId, deposit: terminal };
}

async function findWorkspaceCircleMintLedger(): Promise<string | null> {
  // The workspace-level Circle Mint ledger is auto-provisioned by the
  // platform the first time a Circle Mint API key is registered. Find it
  // by looking for a ledger with provider=CIRCLE_MINT and neither tenant
  // nor counterparty scoping.
  const accounts = await getAll<{
    id: string;
    type: string;
    provider?: string | null;
    tenant_id?: string | null;
    counterparty_id?: string | null;
  }>("/v1/accounts");
  const found = accounts.find(
    (a) =>
      a.type === "ledger" &&
      a.provider === "CIRCLE_MINT" &&
      !a.tenant_id &&
      !a.counterparty_id,
  );
  return found?.id ?? null;
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

async function waitForLedgerProvisioned(ledgerAccountId: string): Promise<void> {
  // Circle ledger compliance is observable on the resource itself via
  // `metadata.circle_mint.circle_compliance_state`, so we poll the
  // resource directly rather than retrying an operation.
  let lastState: string | undefined;
  await waitUntil(
    () =>
      get<{
        data: {
          id: string;
          metadata?: { circle_mint?: { circle_compliance_state?: string } };
        };
      }>(`/v1/accounts/${ledgerAccountId}`),
    (res) => {
      const state = res.data.metadata?.circle_mint?.circle_compliance_state;
      if (state !== lastState) {
        console.log(pc.dim(`  Waiting for Circle provisioning (state=${state ?? "unset"})...`));
        lastState = state;
      }
      return state === "ACCEPTED";
    },
    {
      timeoutMs: 2 * 60 * 1000,
      intervalMs: 5_000,
      describe: `ledger ${ledgerAccountId} circle_compliance_state=ACCEPTED`,
    },
  );
}

async function simulateDepositWhenReady(depositId: string): Promise<void> {
  // Deposit step/account wiring is provisioned asynchronously after the
  // deposit is created. There's no observable readiness flag — the only
  // signal is the simulate call itself, so we retry the operation.
  await retryUntilSettled(
    () => post(`/v1/treasury/deposits/${depositId}/simulate`, {}),
    (err) => err instanceof Error && err.message.includes("treasury-3111"),
    {
      timeoutMs: 60_000,
      intervalMs: 5_000,
      describe: `deposit ${depositId} simulate`,
      onAttempt: (n) => {
        if (n > 1) console.log(pc.dim("  Waiting for deposit step wiring..."));
      },
    },
  );
}

async function pollDepositTerminal(depositId: string): Promise<DepositResponse> {
  // Sandbox-simulated deposits can take up to 20 min to advance steps to
  // `completed`. Budget 25 min so we don't false-alarm on healthy runs.
  let lastLog = "";
  const terminal = await waitUntil(
    () => get<{ data: DepositResponse }>(`/v1/treasury/deposits/${depositId}`),
    (res) => {
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
      return Boolean(d.actual?.to?.amount);
    },
    {
      timeoutMs: 25 * 60 * 1000,
      intervalMs: 10_000,
      describe: `deposit ${depositId} terminal (actual.to.amount populated)`,
    },
  );
  console.log(
    pc.green(`  Deposit terminal: actual.to=${terminal.data.actual?.to?.amount}`),
  );
  return terminal.data;
}

if (import.meta.main) {
  await authenticate();
  const result = await run({
    depositAmount: process.env.TESSER_TEST_DEPOSIT_AMOUNT ?? "100.00",
  });
  console.log(pc.green(`\nDeposit ${result.depositId} complete.`));
}
