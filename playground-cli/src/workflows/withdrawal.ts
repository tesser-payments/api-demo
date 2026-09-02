import { randomUUID } from "node:crypto";
import {
  accountSupports,
  chooseAccount,
  getAccount,
  listAccounts,
  requireAccountId,
  requireWalletAddress,
  type Account,
} from "../accounts.ts";
import { firstValue, getSigningConfiguration, positiveNumber } from "../config.ts";
import { WithdrawalDashboard } from "../dashboard.ts";
import { ApiError, UsageError } from "../errors.ts";
import { requireData } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { signStep } from "../signer.ts";

type TransferEndpoint = {
  account_id?: string;
  amount?: string;
  currency?: string;
  network?: string;
};

type WithdrawalStep = {
  id?: string;
  step_sequence?: number;
  provider_key?: string;
  step_type?: string;
  status?: string;
  status_reasons?: unknown;
  failed_at?: string | null;
  transaction_hash?: string | null;
  unsigned_transaction?: string | null;
  estimated?: { from?: TransferEndpoint; to?: TransferEndpoint };
  [key: string]: unknown;
};

type Withdrawal = {
  id?: string;
  organization_reference_id?: string;
  balance_status?: string;
  steps?: WithdrawalStep[];
  [key: string]: unknown;
};

export type WithdrawalOptions = {
  withdrawalId?: string;
  sourceWalletId?: string;
  destinationBankAccountId?: string;
  amount?: string;
  fromCurrency?: string;
  fromNetwork?: string;
  toCurrency?: string;
  organizationReferenceId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  validateOnly?: boolean;
  withUi?: boolean;
};

export type WithdrawalEnvironment = {
  sourceWalletId?: string;
  destinationBankAccountId?: string;
  amount: string;
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  organizationReferenceId: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
  resumeWithdrawalId?: string;
};

export async function runWithdrawal(runtime: Runtime, options: WithdrawalOptions): Promise<void> {
  const environment = resolveWithdrawalEnvironment(runtime, options);
  getSigningConfiguration(runtime.environment);
  const withUi = await resolveWithdrawalUi(runtime, options);
  const dashboard = withUi ? new WithdrawalDashboard() : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Withdrawal UI: ${dashboard.outputPath}`);
  try {
    if (
      runtime.interaction.interactive &&
      !options.validateOnly &&
      !options.withdrawalId &&
      !environment.resumeWithdrawalId
    ) {
      await configureWithdrawalEnvironment(runtime, environment);
    }
    runtime.output.progress("withdrawal.environment.validated", {
      apiBaseUrl: runtime.client.configuration.baseUrl,
      sourceWalletId: environment.sourceWalletId ?? "<auto>",
      destinationBankAccountId: environment.destinationBankAccountId ?? "<auto>",
      amount: environment.amount,
      fromCurrency: environment.fromCurrency,
      fromNetwork: environment.fromNetwork,
      toCurrency: environment.toCurrency,
      organizationReferenceId: environment.organizationReferenceId,
    });
    if (options.validateOnly) {
      dashboard?.complete();
      runtime.output.result({ valid: true });
      return;
    }
    dashboard?.updateAction("Authenticating with Auth0 client credentials");
    await runtime.interaction.approve("Authenticate with Auth0 client credentials?");
    await runtime.client.authenticate();
    let activeWithdrawalId = options.withdrawalId ?? environment.resumeWithdrawalId;
    let withdrawal: Withdrawal;
    if (activeWithdrawalId) {
      dashboard?.updateAction("Loading the existing withdrawal");
      await runtime.interaction.approve("Load the existing withdrawal?");
      withdrawal = await getWithdrawal(runtime, activeWithdrawalId, dashboard);
      runtime.output.progress("withdrawal.resumed", { withdrawalId: activeWithdrawalId });
    } else {
      dashboard?.updateAction("Selecting source and destination accounts");
      const sourceWallet = await resolveSourceWallet(runtime, environment);
      const destinationBankAccount = await resolveDestinationBankAccount(runtime, environment);
      const body = {
        organization_reference_id: environment.organizationReferenceId,
        desired: {
          from: {
            account_id: requireAccountId(sourceWallet, "Source wallet"),
            amount: environment.amount,
            currency: environment.fromCurrency,
            network: environment.fromNetwork,
          },
          to: {
            account_id: requireAccountId(destinationBankAccount, "Destination bank account"),
            currency: environment.toCurrency,
          },
        },
      };
      dashboard?.updateAction("Creating the withdrawal");
      await runtime.interaction.approve("Create the withdrawal?");
      const response = await runtime.client.request("POST", "/v1/treasury/withdrawals", {
        body,
        operation: "Create withdrawal",
      });
      withdrawal = requireData<Withdrawal>(response, "Create withdrawal");
      if (!withdrawal.id) throw new ApiError("Create withdrawal response did not contain an ID", response.status, response.body);
      activeWithdrawalId = withdrawal.id;
      dashboard?.updateWithdrawal(withdrawal);
      runtime.output.progress("withdrawal.created", { withdrawalId: activeWithdrawalId });
    }
    dashboard?.updateAction("Waiting for the transaction signing step");
    await runtime.interaction.approve("Wait until the withdrawal is ready for signing?");
    const signingState = await waitForSigning(runtime, activeWithdrawalId, environment, dashboard);
    withdrawal = signingState.withdrawal;
    if (signingState.step?.status === "signature_requested") {
      const step = signingState.step;
      if (!step.id) throw new UsageError("Withdrawal signing step does not contain an ID");
      const sourceAccountId = step.estimated?.from?.account_id;
      const unsignedTransaction = step.unsigned_transaction;
      const network = step.estimated?.from?.network;
      if (!sourceAccountId || !unsignedTransaction || !network) {
        throw new UsageError("Withdrawal signing step is missing its source account, transaction, or network");
      }
      const sourceAccount = await getAccount(runtime.client, sourceAccountId);
      dashboard?.updateAction("Signing the transaction locally");
      await runtime.interaction.approve("Sign the withdrawal transaction locally?");
      const signature = await signStep(getSigningConfiguration(runtime.environment), {
        unsignedTransaction,
        signWith: requireWalletAddress(sourceAccount, "Source wallet"),
        network,
      });
      dashboard?.updateAction("Submitting the transaction signature");
      await runtime.interaction.approve("Submit the withdrawal signature?");
      const response = await runtime.client.request(
        "POST",
        `/v1/treasury/withdrawals/${encodeURIComponent(activeWithdrawalId)}/steps/${encodeURIComponent(step.id)}/sign`,
        { body: { signature }, operation: "Submit withdrawal signature" },
      );
      withdrawal = requireData<Withdrawal>(response, "Submit withdrawal signature");
      dashboard?.updateWithdrawal(withdrawal);
      runtime.output.progress("withdrawal.signature-submitted", {
        withdrawalId: activeWithdrawalId,
        stepId: step.id,
      });
    }
    dashboard?.updateAction("Waiting for every provider step to complete");
    await runtime.interaction.approve("Wait until every withdrawal step completes?");
    withdrawal = await waitForCompletion(runtime, activeWithdrawalId, environment, dashboard);
    dashboard?.complete();
    runtime.output.result(withdrawal);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function resolveWithdrawalUi(
  runtime: Runtime,
  options: WithdrawalOptions,
): Promise<boolean> {
  if (options.withUi) return true;
  if (!runtime.interaction.interactive || options.validateOnly) return false;
  return runtime.interaction.confirm(
    "Enable UI? (Creates ui/withdrawal/index.html for live progress)",
    false,
  );
}

type WithdrawalField =
  | "continue"
  | "sourceWalletId"
  | "destinationBankAccountId"
  | "amount"
  | "fromCurrency"
  | "fromNetwork"
  | "toCurrency"
  | "organizationReferenceId"
  | "pollIntervalSeconds"
  | "timeoutSeconds";

export async function configureWithdrawalEnvironment(
  runtime: Runtime,
  environment: WithdrawalEnvironment,
): Promise<void> {
  while (true) {
    const field = await runtime.interaction.choose<WithdrawalField>(
      "Review withdrawal values",
      [
        { name: "Use these values", value: "continue" },
        {
          name: `Amount: ${environment.amount}`,
          value: "amount",
        },
        {
          name: `Source wallet: ${environment.sourceWalletId ?? "Automatic selection"}`,
          value: "sourceWalletId",
        },
        {
          name: `Destination bank account: ${environment.destinationBankAccountId ?? "Automatic selection"}`,
          value: "destinationBankAccountId",
        },
        {
          name: `From currency: ${environment.fromCurrency}`,
          value: "fromCurrency",
        },
        {
          name: `From network: ${environment.fromNetwork}`,
          value: "fromNetwork",
        },
        {
          name: `To currency: ${environment.toCurrency}`,
          value: "toCurrency",
        },
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
      ],
    );

    if (field === "continue") return;
    if (field === "sourceWalletId") {
      environment.sourceWalletId = await runtime.interaction.optionalText(
        "Source wallet ID (empty selects automatically)",
        environment.sourceWalletId,
      );
    }
    if (field === "destinationBankAccountId") {
      environment.destinationBankAccountId = await runtime.interaction.optionalText(
        "Destination bank account ID (empty selects automatically)",
        environment.destinationBankAccountId,
      );
    }
    if (field === "amount") {
      environment.amount = await promptPositiveString(
        runtime,
        "Amount",
        environment.amount,
      );
    }
    if (field === "fromCurrency") {
      environment.fromCurrency = (
        await runtime.interaction.text("From currency", undefined, environment.fromCurrency)
      ).toUpperCase();
    }
    if (field === "fromNetwork") {
      environment.fromNetwork = (
        await runtime.interaction.text("From network", undefined, environment.fromNetwork)
      ).toUpperCase();
    }
    if (field === "toCurrency") {
      environment.toCurrency = (
        await runtime.interaction.text("To currency", undefined, environment.toCurrency)
      ).toUpperCase();
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

async function promptPositiveString(
  runtime: Runtime,
  label: string,
  defaultValue: string,
): Promise<string> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, defaultValue);
    if (Number.isFinite(Number(value)) && Number(value) > 0) return value;
    runtime.output.error(`${label} must be greater than zero`);
  }
}

async function promptPositiveNumber(
  runtime: Runtime,
  label: string,
  defaultValue: number,
): Promise<number> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, String(defaultValue));
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue) && parsedValue > 0) return parsedValue;
    runtime.output.error(`${label} must be greater than zero`);
  }
}

function resolveWithdrawalEnvironment(
  runtime: Runtime,
  options: WithdrawalOptions,
): WithdrawalEnvironment {
  const amount = options.amount ?? firstValue(runtime.environment, "WITHDRAWAL_AMOUNT") ?? "100";
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new UsageError("WITHDRAWAL_AMOUNT must be greater than zero");
  }
  return {
    sourceWalletId:
      options.sourceWalletId ?? firstValue(runtime.environment, "WITHDRAWAL_SOURCE_WALLET_ID"),
    destinationBankAccountId:
      options.destinationBankAccountId ??
      firstValue(runtime.environment, "WITHDRAWAL_DESTINATION_BANK_ACCOUNT_ID"),
    amount,
    fromCurrency: (
      options.fromCurrency ?? firstValue(runtime.environment, "WITHDRAWAL_FROM_CURRENCY") ?? "USDC"
    ).toUpperCase(),
    fromNetwork: (
      options.fromNetwork ?? firstValue(runtime.environment, "WITHDRAWAL_FROM_NETWORK") ?? "BASE_SEPOLIA"
    ).toUpperCase(),
    toCurrency: (
      options.toCurrency ?? firstValue(runtime.environment, "WITHDRAWAL_TO_CURRENCY") ?? "USD"
    ).toUpperCase(),
    organizationReferenceId:
      options.organizationReferenceId ??
      firstValue(runtime.environment, "WITHDRAWAL_ORGANIZATION_REFERENCE_ID") ??
      `withdrawal-${randomUUID()}`,
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds ?? firstValue(runtime.environment, "WITHDRAWAL_POLL_INTERVAL_SECONDS"),
      "WITHDRAWAL_POLL_INTERVAL_SECONDS",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds ?? firstValue(runtime.environment, "WITHDRAWAL_TIMEOUT_SECONDS"),
      "WITHDRAWAL_TIMEOUT_SECONDS",
      1800,
    ),
    resumeWithdrawalId: firstValue(runtime.environment, "WITHDRAWAL_ID"),
  };
}

async function resolveSourceWallet(
  runtime: Runtime,
  environment: WithdrawalEnvironment,
): Promise<Account> {
  if (environment.sourceWalletId) {
    const account = await getAccount(runtime.client, environment.sourceWalletId);
    if (!accountSupports(account, environment.fromCurrency, environment.fromNetwork)) {
      throw new UsageError(
        `Source wallet ${environment.sourceWalletId} does not support ${environment.fromCurrency} on ${environment.fromNetwork}`,
      );
    }
    return account;
  }
  const matches = (await listAccounts(runtime.client, [["entity_type", "sub_org"]])).filter(
    (account) =>
      account.tenant_id == null &&
      account.counterparty_id == null &&
      Boolean(account.crypto_wallet_address) &&
      accountSupports(account, environment.fromCurrency, environment.fromNetwork),
  );
  return chooseAccount(runtime.interaction, "Workspace source wallet", matches);
}

async function resolveDestinationBankAccount(
  runtime: Runtime,
  environment: WithdrawalEnvironment,
): Promise<Account> {
  if (environment.destinationBankAccountId) {
    const account = await getAccount(runtime.client, environment.destinationBankAccountId);
    if (account.type !== "fiat_bank") {
      throw new UsageError(`Destination account ${environment.destinationBankAccountId} is not a fiat bank account`);
    }
    return account;
  }
  const matches = (await listAccounts(runtime.client, [
    ["type", "fiat_bank"],
    ["entity_type", "sub_org"],
  ])).filter(
    (account) =>
      account.type === "fiat_bank" && account.tenant_id == null && account.counterparty_id == null,
  );
  return chooseAccount(runtime.interaction, "Workspace destination bank account", matches);
}

async function getWithdrawal(
  runtime: Runtime,
  withdrawalId: string,
  dashboard?: WithdrawalDashboard,
): Promise<Withdrawal> {
  const response = await runtime.client.request(
    "GET",
    `/v1/treasury/withdrawals/${encodeURIComponent(withdrawalId)}`,
    { operation: "Get withdrawal" },
  );
  const withdrawal = requireData<Withdrawal>(response, "Get withdrawal");
  dashboard?.updateWithdrawal(withdrawal);
  return withdrawal;
}

function steps(withdrawal: Withdrawal): WithdrawalStep[] {
  if (!Array.isArray(withdrawal.steps)) throw new UsageError("Withdrawal response did not contain steps");
  return withdrawal.steps;
}

function failedSteps(withdrawal: Withdrawal): WithdrawalStep[] {
  return steps(withdrawal).filter((step) => step.status === "failed" || step.failed_at);
}

function showStatus(runtime: Runtime, withdrawalId: string, withdrawal: Withdrawal): void {
  runtime.output.progress("withdrawal.status", {
    withdrawalId,
    balanceStatus: withdrawal.balance_status,
    steps: steps(withdrawal).map((step) => ({
      id: step.id,
      sequence: step.step_sequence,
      provider: step.provider_key,
      status: step.status,
      transactionHash: step.transaction_hash,
    })),
  });
}

async function waitForSigning(
  runtime: Runtime,
  withdrawalId: string,
  environment: WithdrawalEnvironment,
  dashboard?: WithdrawalDashboard,
): Promise<{ withdrawal: Withdrawal; step?: WithdrawalStep }> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const withdrawal = await getWithdrawal(runtime, withdrawalId, dashboard);
    const withdrawalSteps = steps(withdrawal);
    const failed = failedSteps(withdrawal);
    if (failed.length) throw new UsageError(`Withdrawal failed: ${JSON.stringify(failed)}`);
    if (withdrawalSteps.length && withdrawalSteps.every((step) => step.status === "completed")) {
      return { withdrawal };
    }
    const signingSteps = withdrawalSteps.filter(
      (step) => step.provider_key === "turnkey" && step.step_sequence === 1,
    );
    if (signingSteps.length > 1) throw new UsageError("Expected one withdrawal source signing step");
    const step = signingSteps[0];
    const state = `${withdrawal.balance_status}:${step?.status}`;
    if (state !== previousState) {
      showStatus(runtime, withdrawalId, withdrawal);
      previousState = state;
    }
    if (
      step &&
      ((step.status === "signature_requested" && step.unsigned_transaction) ||
        ["signed", "submitted", "confirmed", "completed"].includes(step.status ?? ""))
    ) {
      return { withdrawal, step };
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for the withdrawal signing step");
}

async function waitForCompletion(
  runtime: Runtime,
  withdrawalId: string,
  environment: WithdrawalEnvironment,
  dashboard?: WithdrawalDashboard,
): Promise<Withdrawal> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  let openFxPrompted = false;
  while (Date.now() < deadline) {
    const withdrawal = await getWithdrawal(runtime, withdrawalId, dashboard);
    const withdrawalSteps = steps(withdrawal);
    const failed = failedSteps(withdrawal);
    if (failed.length) throw new UsageError(`Withdrawal failed: ${JSON.stringify(failed)}`);
    const state = withdrawalSteps.map((step) => `${step.id}:${step.status}`).join("|");
    if (state !== previousState) {
      showStatus(runtime, withdrawalId, withdrawal);
      previousState = state;
    }
    if (withdrawalSteps.length && withdrawalSteps.every((step) => step.status === "completed")) {
      return withdrawal;
    }
    const signingStep = withdrawalSteps.find(
      (step) => step.provider_key === "turnkey" && step.step_sequence === 1,
    );
    if (
      signingStep &&
      !openFxPrompted &&
      ["submitted", "confirmed"].includes(signingStep.status ?? "") &&
      signingStep.transaction_hash
    ) {
      runtime.output.progress("withdrawal.openfx-mock-deposit-required", {
        withdrawalId,
        stepId: signingStep.id,
        amount: signingStep.estimated?.from?.amount,
        currency: signingStep.estimated?.from?.currency,
        network: signingStep.estimated?.from?.network,
        sourceAccountId: signingStep.estimated?.from?.account_id,
        destinationAccountId: signingStep.estimated?.to?.account_id,
        transactionHash: signingStep.transaction_hash,
      });
      openFxPrompted = true;
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for withdrawal completion");
}
