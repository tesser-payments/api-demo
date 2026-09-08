import { randomUUID } from "node:crypto";
import { chooseAccount, getAccount, listAccounts, requireAccountId, type Account } from "../accounts.ts";
import { positiveNumber } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { requireData } from "../http.ts";
import { KrakenDashboard, resolveKrakenUi } from "../kraken-dashboard.ts";
import type { Runtime } from "../runtime.ts";

type TransferEndpoint = {
  account_id?: string | null;
  amount?: string | null;
  currency?: string | null;
};

type KrakenDepositStep = {
  id?: string;
  provider_key?: string | null;
  status?: string;
  failed_at?: string | null;
  estimated?: { from?: TransferEndpoint; to?: TransferEndpoint };
  actual?: { from?: TransferEndpoint; to?: TransferEndpoint };
  [key: string]: unknown;
};

type TesserDeposit = {
  id?: string;
  desired?: { from?: TransferEndpoint; to?: TransferEndpoint };
  actual?: { from?: TransferEndpoint; to?: TransferEndpoint };
  steps?: KrakenDepositStep[];
  [key: string]: unknown;
};

type DepositInstructions = {
  from_account?: { id?: string; [key: string]: unknown };
  to_account?: {
    bank_account_number?: string;
    bank_identifier_code?: string;
    [key: string]: unknown;
  };
  amount?: string;
  currency?: string;
  [key: string]: unknown;
};

export type KrakenDepositOptions = {
  depositId?: string;
  sourceBankId?: string;
  krakenLedgerId?: string;
  amount?: string;
  organizationReferenceId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  planOnly?: boolean;
  validateOnly?: boolean;
  withUi?: boolean;
};

export type KrakenDepositEnvironment = {
  sourceBankId?: string;
  krakenLedgerId?: string;
  amount?: string;
  organizationReferenceId: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
  resumeDepositId?: string;
};

export async function runKrakenDeposit(runtime: Runtime, options: KrakenDepositOptions): Promise<void> {
  const environment = resolveKrakenDepositEnvironment(options);
  const withUi = await resolveKrakenUi(runtime.interaction, options.withUi, "deposit", options.validateOnly);
  const dashboard = withUi ? new KrakenDashboard("deposit") : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Kraken deposit UI: ${dashboard.outputPath}`);
  try {
    dashboard?.update("configure", "Reviewing the Kraken BRL deposit values", {
      depositId: options.depositId ?? environment.resumeDepositId,
      amount: environment.amount,
      currency: "BRL",
    });
    if (
      runtime.interaction.interactive &&
      !options.validateOnly &&
      !options.depositId &&
      !environment.resumeDepositId
    ) {
      await configureKrakenDepositEnvironment(runtime, environment);
    }
    dashboard?.update("configure", "Reviewed the Kraken BRL deposit values", {
      depositId: options.depositId ?? environment.resumeDepositId,
      sourceBankId: environment.sourceBankId,
      krakenLedgerId: environment.krakenLedgerId,
      amount: environment.amount,
      currency: "BRL",
      organizationReferenceId: environment.organizationReferenceId,
    });
    if (!environment.amount && !options.depositId && !environment.resumeDepositId) {
      throw new UsageError("BRL amount is required");
    }
    if (environment.amount) amountInCents(environment.amount, "BRL amount");
    showEnvironment(runtime, environment, options);
    if (options.validateOnly) {
      dashboard?.complete({ valid: true });
      runtime.output.result({ valid: true });
      return;
    }
    dashboard?.update("authenticate", "Authenticating with Tesser");
    await runtime.interaction.approve("authenticating with Tesser");
    await runtime.client.authenticate();
    let depositId = options.depositId ?? environment.resumeDepositId;
    let deposit: TesserDeposit;
    let ledger: Account;
    let sourceBank: Account | undefined;
    let balanceBefore: string | null = null;
    dashboard?.update("create", "Creating or loading the Tesser deposit");
    if (depositId) {
      deposit = await getDeposit(runtime, depositId);
      dashboard?.update("create", "Loaded the existing Tesser deposit", deposit);
      assertBrLDeposit(deposit);
      const ledgerId = deposit.desired?.to?.account_id;
      if (!ledgerId) {
        throw new UsageError("Existing deposit does not contain a destination account");
      }
      ledger = await resolveKrakenLedger(runtime, {
        ...environment,
        krakenLedgerId: ledgerId,
      });
      runtime.output.progress("kraken.deposit.resumed", { depositId });
    } else {
      ledger = await resolveKrakenLedger(runtime, environment);
      sourceBank = await resolveSourceBank(runtime, environment);
      balanceBefore = requireBrLBalance(ledger);
      await runtime.interaction.approve("creating the Tesser BRL deposit");
      const response = await runtime.client.request("POST", "/v1/treasury/deposits", {
        body: {
          organization_reference_id: environment.organizationReferenceId,
          desired: {
            from: {
              account_id: requireAccountId(sourceBank, "Source bank"),
              amount: environment.amount,
              currency: "BRL",
            },
            to: {
              account_id: requireAccountId(ledger, "Kraken ledger"),
              currency: "BRL",
            },
          },
        },
        operation: "Create Kraken BRL deposit",
      });
      deposit = requireData<TesserDeposit>(response, "Create Kraken BRL deposit");
      if (!deposit.id) {
        throw new ApiError("Create Kraken BRL deposit response did not contain an ID", response.status, response.body);
      }
      depositId = deposit.id;
      dashboard?.update("create", "Created the Tesser deposit", deposit);
      runtime.output.progress("kraken.deposit.created", { depositId });
    }
    dashboard?.update("plan", "Waiting for Tesser to plan the Kraken deposit", deposit);
    const planned = await waitForPlanning(runtime, depositId, environment, dashboard);
    const plannedAmount = requireDepositAmount(planned);
    if (environment.amount) {
      assertSameAmount(environment.amount, plannedAmount, "Planned deposit amount");
    } else {
      environment.amount = plannedAmount;
    }
    if (allStepsCompleted(planned)) {
      assertActualAmount(planned, environment.amount);
      const completedLedger = await getAccount(runtime.client, requireAccountId(ledger, "Kraken ledger"));
      const result = completionResult(
        planned,
        ledger,
        sourceBank,
        environment.amount,
        balanceBefore,
        requireBrLBalance(completedLedger),
      );
      dashboard?.complete(result);
      runtime.output.result(result);
      return;
    }
    dashboard?.update("instructions", "Waiting for safe Tesser deposit instructions", planned);
    const instructions = await waitForInstructions(runtime, depositId, environment, dashboard);
    assertMockInstructions(instructions, environment.amount);
    if (options.planOnly) {
      const result = {
        deposit: planned,
        instructions,
        balance_before: balanceBefore,
        resume_command: `./cli treasury deposit --deposit-id ${depositId}`,
      };
      dashboard?.complete(result);
      runtime.output.result(result);
      return;
    }
    dashboard?.update("transfer", "Submit the matching PIX deposit in Kraken Web", { deposit: planned, instructions });
    runtime.output.info(
      [
        `Tesser deposit ${depositId} is ready.`,
        `Open Kraken Web and create a Pix (PayAmigo) deposit for BRL ${environment.amount}.`,
        "Do not send funds to NOT_PAYABLE or TEST_ONLY.",
        "Continue only after the real PIX transfer has been submitted.",
        "https://www.kraken.com/c",
      ].join("\n"),
    );
    await runtime.interaction.approve("continuing after the real PIX deposit is submitted", false);
    dashboard?.update("reconcile", "Waiting for Tesser to reconcile the Kraken deposit", planned);
    const completed = await waitForCompletion(runtime, depositId, environment, dashboard);
    assertActualAmount(completed, environment.amount);
    const completedLedger = await getAccount(runtime.client, requireAccountId(ledger, "Kraken ledger"));
    const balanceAfter = requireBrLBalance(completedLedger);
    if (balanceBefore !== null) {
      const expected =
        amountInCents(balanceBefore, "Kraken BRL balance", true) + amountInCents(environment.amount, "BRL amount");
      if (amountInCents(balanceAfter, "Kraken BRL balance", true) !== expected) {
        throw new UsageError(
          `Kraken BRL balance mismatch: expected ${formatCents(expected)}, received ${balanceAfter}`,
        );
      }
    }
    const result = completionResult(completed, ledger, sourceBank, environment.amount, balanceBefore, balanceAfter);
    dashboard?.complete(result);
    runtime.output.result(result);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function resolveKrakenDepositEnvironment(
  options: KrakenDepositOptions,
): KrakenDepositEnvironment {
  return {
    sourceBankId: options.sourceBankId,
    krakenLedgerId: options.krakenLedgerId,
    amount: options.amount,
    organizationReferenceId:
      options.organizationReferenceId ?? `kraken-brl-${randomUUID()}`,
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds,
      "--poll-interval-seconds",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds,
      "--timeout-seconds",
      1800,
    ),
    resumeDepositId: undefined,
  };
}

export async function configureKrakenDepositEnvironment(
  runtime: Runtime,
  environment: KrakenDepositEnvironment,
): Promise<void> {
  if (!environment.amount) {
    environment.amount = await runtime.interaction.text("BRL amount");
  }
  type Field =
    | "continue"
    | "sourceBankId"
    | "krakenLedgerId"
    | "amount"
    | "organizationReferenceId"
    | "pollIntervalSeconds"
    | "timeoutSeconds";
  while (true) {
    const field = await runtime.interaction.choose<Field>("Review Kraken BRL deposit values", [
      { name: "Use these values", value: "continue" },
      {
        name: `Source bank: ${environment.sourceBankId ?? "Interactive selection"}`,
        value: "sourceBankId",
      },
      {
        name: `Kraken ledger: ${environment.krakenLedgerId ?? "Interactive selection"}`,
        value: "krakenLedgerId",
      },
      { name: `Amount: BRL ${environment.amount}`, value: "amount" },
      {
        name: `Organization reference: ${environment.organizationReferenceId}`,
        value: "organizationReferenceId",
      },
      {
        name: `Poll interval: ${environment.pollIntervalSeconds} seconds`,
        value: "pollIntervalSeconds",
      },
      {
        name: `Timeout: ${environment.timeoutSeconds} seconds`,
        value: "timeoutSeconds",
      },
    ]);
    if (field === "continue") return;
    if (field === "sourceBankId") {
      environment.sourceBankId = await runtime.interaction.optionalText(
        "Source bank ID (empty selects interactively)",
        environment.sourceBankId,
      );
    }
    if (field === "krakenLedgerId") {
      environment.krakenLedgerId = await runtime.interaction.optionalText(
        "Kraken ledger ID (empty selects interactively)",
        environment.krakenLedgerId,
      );
    }
    if (field === "amount") {
      environment.amount = await runtime.interaction.text("BRL amount", undefined, environment.amount);
    }
    if (field === "organizationReferenceId") {
      environment.organizationReferenceId = await runtime.interaction.text(
        "Organization reference ID",
        undefined,
        environment.organizationReferenceId,
      );
    }
    if (field === "pollIntervalSeconds") {
      environment.pollIntervalSeconds = await promptPositiveNumber(
        runtime,
        "Poll interval in seconds",
        environment.pollIntervalSeconds,
      );
    }
    if (field === "timeoutSeconds") {
      environment.timeoutSeconds = await promptPositiveNumber(
        runtime,
        "Timeout in seconds",
        environment.timeoutSeconds,
      );
    }
  }
}

async function resolveKrakenLedger(runtime: Runtime, environment: KrakenDepositEnvironment): Promise<Account> {
  if (environment.krakenLedgerId) {
    const account = await getAccount(runtime.client, environment.krakenLedgerId);
    assertKrakenLedger(account);
    return account;
  }
  const accounts = await listAccounts(runtime.client, [["type", "ledger"]]);
  const matches = accounts.filter(isKrakenLedger);
  if (!matches.length) {
    throw new UsageError("No managed Kraken ledger exists; run workspace register-secrets kraken first");
  }
  return chooseAccount(runtime.interaction, "Managed Kraken ledger", matches);
}

async function resolveSourceBank(runtime: Runtime, environment: KrakenDepositEnvironment): Promise<Account> {
  if (environment.sourceBankId) {
    const account = await getAccount(runtime.client, environment.sourceBankId);
    assertSourceBank(account);
    return account;
  }
  const accounts = await listAccounts(runtime.client, [["type", "fiat_bank"]]);
  const matches = accounts.filter(
    (account) => account.type === "fiat_bank" && account.tenant_id == null && account.counterparty_id == null,
  );
  return chooseAccount(runtime.interaction, "Workspace source bank", matches);
}

function assertKrakenLedger(account: Account): void {
  if (!isKrakenLedger(account)) {
    throw new UsageError(`Account ${account.id ?? "<unknown>"} is not a managed Kraken BRL ledger`);
  }
}

function isKrakenLedger(account: Account): boolean {
  return (
    account.type === "ledger" &&
    account.provider === "KRAKEN" &&
    account.is_managed === true &&
    Boolean(account.assets?.some((asset) => asset.currency === "BRL" && asset.network == null))
  );
}

function assertSourceBank(account: Account): void {
  if (account.type !== "fiat_bank" || account.tenant_id != null || account.counterparty_id != null) {
    throw new UsageError(`Account ${account.id ?? "<unknown>"} is not a workspace source bank`);
  }
}

async function getDeposit(runtime: Runtime, depositId: string): Promise<TesserDeposit> {
  const response = await runtime.client.request("GET", `/v1/treasury/deposits/${encodeURIComponent(depositId)}`, {
    operation: "Get Kraken BRL deposit",
  });
  return requireData<TesserDeposit>(response, "Get Kraken BRL deposit");
}

async function waitForInstructions(
  runtime: Runtime,
  depositId: string,
  environment: KrakenDepositEnvironment,
  dashboard?: KrakenDashboard,
): Promise<DepositInstructions> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await runtime.client.request(
      "GET",
      `/v1/treasury/deposits/${encodeURIComponent(depositId)}/instructions`,
      { operation: "Get Kraken BRL deposit instructions" },
    );
    if (response.status !== 409) {
      const instructions = requireData<DepositInstructions>(response, "Get Kraken BRL deposit instructions");
      dashboard?.update("instructions", "Received the Tesser deposit instructions", instructions);
      return instructions;
    }
    dashboard?.update("instructions", "Waiting for safe Tesser deposit instructions", {
      depositId,
      status: response.status,
    });
    runtime.output.progress("kraken.deposit.instructions.pending", {
      depositId,
    });
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError(
    `Timed out waiting for Kraken deposit instructions; resume with ./cli treasury deposit --deposit-id ${depositId}`,
  );
}

async function waitForPlanning(
  runtime: Runtime,
  depositId: string,
  environment: KrakenDepositEnvironment,
  dashboard?: KrakenDashboard,
): Promise<TesserDeposit> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const deposit = await getDeposit(runtime, depositId);
    dashboard?.update("plan", "Waiting for Tesser to plan the Kraken deposit", deposit);
    const depositSteps = steps(deposit);
    const failed = failedSteps(depositSteps);
    if (failed.length) {
      throw new UsageError(`Kraken deposit failed: ${JSON.stringify(failed)}`);
    }
    const state = depositSteps.map((step) => `${step.id}:${step.provider_key}:${step.status}`).join("|");
    if (state !== previousState) {
      showStatus(runtime, depositId, depositSteps);
      previousState = state;
    }
    if (depositSteps.length) {
      if (depositSteps.length !== 1 || depositSteps[0]?.provider_key !== "kraken") {
        throw new UsageError("Expected one Kraken deposit step");
      }
      const status = depositSteps[0].status;
      if (status !== "created" && status !== "completed") {
        throw new UsageError(`Unexpected Kraken deposit step status: ${status}`);
      }
      return deposit;
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError(
    `Timed out waiting for Kraken deposit planning; resume with ./cli treasury deposit --deposit-id ${depositId}`,
  );
}

async function waitForCompletion(
  runtime: Runtime,
  depositId: string,
  environment: KrakenDepositEnvironment,
  dashboard?: KrakenDashboard,
): Promise<TesserDeposit> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const deposit = await getDeposit(runtime, depositId);
    dashboard?.update("reconcile", "Waiting for Tesser to reconcile the Kraken deposit", deposit);
    const depositSteps = steps(deposit);
    const failed = failedSteps(depositSteps);
    if (failed.length) {
      throw new UsageError(`Kraken deposit failed: ${JSON.stringify(failed)}`);
    }
    const state = depositSteps.map((step) => `${step.id}:${step.status}`).join("|");
    if (state !== previousState) {
      showStatus(runtime, depositId, depositSteps);
      previousState = state;
    }
    if (allStepsCompleted(deposit)) return deposit;
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError(
    `Timed out waiting for Kraken deposit completion; resume with ./cli treasury deposit --deposit-id ${depositId}`,
  );
}

function steps(deposit: TesserDeposit): KrakenDepositStep[] {
  if (!Array.isArray(deposit.steps)) {
    throw new UsageError("Kraken deposit response did not contain steps");
  }
  return deposit.steps;
}

function failedSteps(depositSteps: KrakenDepositStep[]): KrakenDepositStep[] {
  return depositSteps.filter((step) => step.status === "failed" || Boolean(step.failed_at));
}

function allStepsCompleted(deposit: TesserDeposit): boolean {
  const depositSteps = steps(deposit);
  return depositSteps.length > 0 && depositSteps.every((step) => step.status === "completed");
}

function assertBrLDeposit(deposit: TesserDeposit): void {
  if (deposit.desired?.from?.currency !== "BRL" || deposit.desired?.to?.currency !== "BRL") {
    throw new UsageError("Existing deposit is not a BRL-to-BRL deposit");
  }
}

function requireDepositAmount(deposit: TesserDeposit): string {
  const amount = deposit.desired?.from?.amount ?? deposit.steps?.[0]?.estimated?.from?.amount;
  if (!amount) throw new UsageError("Kraken deposit does not contain an amount");
  amountInCents(amount, "Kraken deposit amount");
  return amount;
}

function assertMockInstructions(instructions: DepositInstructions, expectedAmount: string): void {
  if (instructions.currency !== "BRL") {
    throw new UsageError("Kraken deposit instructions are not for BRL");
  }
  if (!instructions.amount) {
    throw new UsageError("Kraken deposit instructions do not contain an amount");
  }
  assertSameAmount(expectedAmount, instructions.amount, "Instruction amount");
  if (
    instructions.to_account?.bank_account_number !== "NOT_PAYABLE" ||
    instructions.to_account?.bank_identifier_code !== "TEST_ONLY"
  ) {
    throw new UsageError("Expected non-payable Staging Kraken PIX instructions");
  }
}

function assertActualAmount(deposit: TesserDeposit, expectedAmount: string): void {
  const actualFrom = deposit.actual?.from;
  const actualTo = deposit.actual?.to;
  if (actualFrom?.currency !== "BRL" || actualTo?.currency !== "BRL" || !actualFrom.amount || !actualTo.amount) {
    throw new UsageError("Completed Kraken deposit has no BRL actual amount");
  }
  assertSameAmount(expectedAmount, actualFrom.amount, "Actual source amount");
  assertSameAmount(expectedAmount, actualTo.amount, "Actual destination amount");
}

function requireBrLBalance(account: Account): string {
  const balance = account.assets?.find((asset) => asset.currency === "BRL" && asset.network == null)?.available_balance;
  if (typeof balance !== "string") {
    throw new UsageError("Managed Kraken ledger does not contain a BRL balance");
  }
  amountInCents(balance, "Kraken BRL balance", true);
  return balance;
}

function amountInCents(value: string, label: string, allowZero = false): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new UsageError(`${label} must be a positive decimal with at most two decimals`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount < 0n || (!allowZero && amount === 0n)) {
    throw new UsageError(`${label} must be greater than zero`);
  }
  return amount;
}

function assertSameAmount(expected: string, actual: string, label: string): void {
  if (amountInCents(expected, "Expected BRL amount") !== amountInCents(actual, label)) {
    throw new UsageError(`${label} does not match BRL ${expected}`);
  }
}

function formatCents(value: bigint): string {
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function showEnvironment(runtime: Runtime, environment: KrakenDepositEnvironment, options: KrakenDepositOptions): void {
  runtime.output.progress("kraken.deposit.environment.validated", {
    apiBaseUrl: runtime.client.configuration.baseUrl,
    depositId: options.depositId ?? environment.resumeDepositId ?? "<new>",
    sourceBankId: environment.sourceBankId ?? "<auto>",
    krakenLedgerId: environment.krakenLedgerId ?? "<auto>",
    amount: environment.amount ?? "<from-deposit>",
    currency: "BRL",
    organizationReferenceId: environment.organizationReferenceId,
    pollIntervalSeconds: environment.pollIntervalSeconds,
    timeoutSeconds: environment.timeoutSeconds,
    planOnly: Boolean(options.planOnly),
  });
}

function showStatus(runtime: Runtime, depositId: string, depositSteps: KrakenDepositStep[]): void {
  runtime.output.progress("kraken.deposit.status", {
    depositId,
    steps: depositSteps.map((step) => ({
      id: step.id,
      provider: step.provider_key,
      status: step.status,
    })),
  });
}

function completionResult(
  deposit: TesserDeposit,
  ledger: Account,
  sourceBank: Account | undefined,
  amount: string,
  balanceBefore: string | null,
  balanceAfter: string,
): Record<string, unknown> {
  return {
    deposit_id: deposit.id,
    step_id: deposit.steps?.[0]?.id,
    source_bank_id: sourceBank?.id ?? deposit.desired?.from?.account_id,
    kraken_ledger_id: ledger.id,
    amount,
    currency: "BRL",
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    status: deposit.steps?.[0]?.status,
    deposit,
  };
}

async function promptPositiveNumber(runtime: Runtime, label: string, defaultValue: number): Promise<number> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, String(defaultValue));
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    runtime.output.error(`${label} must be greater than zero`);
  }
}
