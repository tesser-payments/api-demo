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
import { RebalanceDashboard } from "../dashboard.ts";
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

type RebalanceStep = {
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

type Rebalance = {
  id?: string;
  organization_reference_id?: string;
  balance_status?: string;
  steps?: RebalanceStep[];
  [key: string]: unknown;
};

export type RebalanceOptions = {
  rebalanceId?: string;
  sourceWalletId?: string;
  destinationLedgerId?: string;
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

export type RebalanceEnvironment = {
  sourceWalletId?: string;
  destinationLedgerId?: string;
  amount: string;
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  organizationReferenceId: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
  resumeRebalanceId?: string;
};

export async function runRebalance(runtime: Runtime, options: RebalanceOptions): Promise<void> {
  const environment = resolveRebalanceEnvironment(runtime, options);
  getSigningConfiguration(runtime.environment);
  const withUi = await resolveRebalanceUi(runtime, options);
  const dashboard = withUi ? new RebalanceDashboard() : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Rebalance UI: ${dashboard.outputPath}`);
  try {
    if (
      runtime.interaction.interactive &&
      !options.validateOnly &&
      !options.rebalanceId &&
      !environment.resumeRebalanceId
    ) {
      await configureRebalanceEnvironment(runtime, environment);
    }
    runtime.output.progress("rebalance.environment.validated", {
      apiBaseUrl: runtime.client.configuration.baseUrl,
      sourceWalletId: environment.sourceWalletId ?? "<auto>",
      destinationLedgerId: environment.destinationLedgerId ?? "<auto>",
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
    let activeRebalanceId = options.rebalanceId ?? environment.resumeRebalanceId;
    let rebalance: Rebalance;
    if (activeRebalanceId) {
      dashboard?.updateAction("Loading the existing rebalance");
      await runtime.interaction.approve("Load the existing rebalance?");
      rebalance = await getRebalance(runtime, activeRebalanceId, dashboard);
      runtime.output.progress("rebalance.resumed", { rebalanceId: activeRebalanceId });
    } else {
      dashboard?.updateAction("Selecting the source wallet and OpenFX ledger");
      const sourceWallet = await resolveSourceWallet(runtime, environment);
      const destinationLedger = await resolveDestinationLedger(runtime, environment);
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
            account_id: requireAccountId(destinationLedger, "Destination OpenFX ledger"),
            currency: environment.toCurrency,
          },
        },
      };
      dashboard?.updateAction("Creating the rebalance");
      await runtime.interaction.approve("Create the rebalance?");
      const response = await runtime.client.request("POST", "/v1/treasury/rebalances", {
        body,
        operation: "Create rebalance",
      });
      rebalance = requireData<Rebalance>(response, "Create rebalance");
      if (!rebalance.id) {
        throw new ApiError(
          "Create rebalance response did not contain an ID",
          response.status,
          response.body,
        );
      }
      activeRebalanceId = rebalance.id;
      dashboard?.updateRebalance(rebalance);
      runtime.output.progress("rebalance.created", { rebalanceId: activeRebalanceId });
    }
    dashboard?.updateAction("Waiting for the wallet transaction signing step");
    await runtime.interaction.approve("Wait until the rebalance is ready for signing?");
    const signingState = await waitForSigning(runtime, activeRebalanceId, environment, dashboard);
    rebalance = signingState.rebalance;
    if (signingState.step?.status === "signature_requested") {
      const step = signingState.step;
      if (!step.id) throw new UsageError("Rebalance signing step does not contain an ID");
      const sourceAccountId = step.estimated?.from?.account_id;
      const unsignedTransaction = step.unsigned_transaction;
      const network = step.estimated?.from?.network;
      if (!sourceAccountId || !unsignedTransaction || !network) {
        throw new UsageError(
          "Rebalance signing step is missing its source account, transaction, or network",
        );
      }
      const sourceAccount = await getAccount(runtime.client, sourceAccountId);
      dashboard?.updateAction("Signing the wallet transaction locally");
      await runtime.interaction.approve("Sign the rebalance transaction locally?");
      const signature = await signStep(getSigningConfiguration(runtime.environment), {
        unsignedTransaction,
        signWith: requireWalletAddress(sourceAccount, "Source wallet"),
        network,
      });
      dashboard?.updateAction("Submitting the rebalance transaction signature");
      await runtime.interaction.approve("Submit the rebalance signature?");
      const response = await runtime.client.request(
        "POST",
        `/v1/treasury/rebalances/${encodeURIComponent(activeRebalanceId)}/steps/${encodeURIComponent(step.id)}/sign`,
        { body: { signature }, operation: "Submit rebalance signature" },
      );
      rebalance = requireData<Rebalance>(response, "Submit rebalance signature");
      dashboard?.updateRebalance(rebalance);
      runtime.output.progress("rebalance.signature-submitted", {
        rebalanceId: activeRebalanceId,
        stepId: step.id,
      });
    }
    dashboard?.updateAction("Waiting for the OpenFX deposit and every rebalance step");
    await runtime.interaction.approve("Wait until every rebalance step completes?");
    rebalance = await waitForCompletion(runtime, activeRebalanceId, environment, dashboard);
    dashboard?.complete();
    runtime.output.result(rebalance);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function resolveRebalanceUi(
  runtime: Runtime,
  options: RebalanceOptions,
): Promise<boolean> {
  if (options.withUi) return true;
  if (!runtime.interaction.interactive || options.validateOnly) return false;
  return runtime.interaction.confirm(
    "Enable UI? (Creates ui/rebalance/index.html for live progress)",
    false,
  );
}

type RebalanceField =
  | "continue"
  | "sourceWalletId"
  | "destinationLedgerId"
  | "amount"
  | "fromCurrency"
  | "fromNetwork"
  | "toCurrency"
  | "organizationReferenceId"
  | "pollIntervalSeconds"
  | "timeoutSeconds";

export async function configureRebalanceEnvironment(
  runtime: Runtime,
  environment: RebalanceEnvironment,
): Promise<void> {
  while (true) {
    const field = await runtime.interaction.choose<RebalanceField>(
      "Review rebalance values",
      [
        { name: "Use these values", value: "continue" },
        { name: `Amount: ${environment.amount}`, value: "amount" },
        {
          name: `Source wallet: ${environment.sourceWalletId ?? "Automatic selection"}`,
          value: "sourceWalletId",
        },
        {
          name: `Destination OpenFX ledger: ${environment.destinationLedgerId ?? "Automatic selection"}`,
          value: "destinationLedgerId",
        },
        { name: `From currency: ${environment.fromCurrency}`, value: "fromCurrency" },
        { name: `From network: ${environment.fromNetwork}`, value: "fromNetwork" },
        { name: `To currency: ${environment.toCurrency}`, value: "toCurrency" },
        {
          name: `Organization reference: ${environment.organizationReferenceId}`,
          value: "organizationReferenceId",
        },
        {
          name: `Poll interval: ${environment.pollIntervalSeconds} seconds`,
          value: "pollIntervalSeconds",
        },
        { name: `Timeout: ${environment.timeoutSeconds} seconds`, value: "timeoutSeconds" },
      ],
    );

    if (field === "continue") return;
    if (field === "sourceWalletId") {
      environment.sourceWalletId = await runtime.interaction.optionalText(
        "Source wallet ID (empty selects automatically)",
        environment.sourceWalletId,
      );
    }
    if (field === "destinationLedgerId") {
      environment.destinationLedgerId = await runtime.interaction.optionalText(
        "Destination OpenFX ledger ID (empty selects automatically)",
        environment.destinationLedgerId,
      );
    }
    if (field === "amount") {
      environment.amount = await promptPositiveString(runtime, "Amount", environment.amount);
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

function resolveRebalanceEnvironment(
  runtime: Runtime,
  options: RebalanceOptions,
): RebalanceEnvironment {
  const amount = options.amount ?? firstValue(runtime.environment, "REBALANCE_AMOUNT") ?? "100";
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new UsageError("REBALANCE_AMOUNT must be greater than zero");
  }
  return {
    sourceWalletId:
      options.sourceWalletId ?? firstValue(runtime.environment, "REBALANCE_SOURCE_WALLET_ID"),
    destinationLedgerId:
      options.destinationLedgerId ??
      firstValue(runtime.environment, "REBALANCE_DESTINATION_LEDGER_ID"),
    amount,
    fromCurrency: (
      options.fromCurrency ?? firstValue(runtime.environment, "REBALANCE_FROM_CURRENCY") ?? "USDC"
    ).toUpperCase(),
    fromNetwork: (
      options.fromNetwork ??
      firstValue(runtime.environment, "REBALANCE_FROM_NETWORK") ??
      "BASE_SEPOLIA"
    ).toUpperCase(),
    toCurrency: (
      options.toCurrency ?? firstValue(runtime.environment, "REBALANCE_TO_CURRENCY") ?? "USD"
    ).toUpperCase(),
    organizationReferenceId:
      options.organizationReferenceId ??
      firstValue(runtime.environment, "REBALANCE_ORGANIZATION_REFERENCE_ID") ??
      `rebalance-${randomUUID()}`,
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds ??
        firstValue(runtime.environment, "REBALANCE_POLL_INTERVAL_SECONDS"),
      "REBALANCE_POLL_INTERVAL_SECONDS",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds ?? firstValue(runtime.environment, "REBALANCE_TIMEOUT_SECONDS"),
      "REBALANCE_TIMEOUT_SECONDS",
      1800,
    ),
    resumeRebalanceId: firstValue(runtime.environment, "REBALANCE_ID"),
  };
}

async function resolveSourceWallet(
  runtime: Runtime,
  environment: RebalanceEnvironment,
): Promise<Account> {
  if (environment.sourceWalletId) {
    const account = await getAccount(runtime.client, environment.sourceWalletId);
    validateSourceWallet(account, environment);
    return account;
  }
  const matches = (await listAccounts(runtime.client, [["entity_type", "sub_org"]])).filter(
    (account) =>
      account.tenant_id == null &&
      account.counterparty_id == null &&
      account.is_managed === true &&
      Boolean(account.crypto_wallet_address) &&
      accountSupports(account, environment.fromCurrency, environment.fromNetwork),
  );
  return chooseAccount(runtime.interaction, "Workspace source wallet", matches);
}

function validateSourceWallet(account: Account, environment: RebalanceEnvironment): void {
  if (!account.crypto_wallet_address) {
    throw new UsageError(`Source account ${environment.sourceWalletId} is not a wallet`);
  }
  if (account.is_managed !== true) {
    throw new UsageError(`Source wallet ${environment.sourceWalletId} is not managed`);
  }
  if (account.tenant_id != null || account.counterparty_id != null) {
    throw new UsageError(`Source wallet ${environment.sourceWalletId} is not workspace-owned`);
  }
  if (!accountSupports(account, environment.fromCurrency, environment.fromNetwork)) {
    throw new UsageError(
      `Source wallet ${environment.sourceWalletId} does not support ${environment.fromCurrency} on ${environment.fromNetwork}`,
    );
  }
}

async function resolveDestinationLedger(
  runtime: Runtime,
  environment: RebalanceEnvironment,
): Promise<Account> {
  if (environment.destinationLedgerId) {
    const account = await getAccount(runtime.client, environment.destinationLedgerId);
    validateDestinationLedger(account, environment.destinationLedgerId);
    return account;
  }
  const matches = (await listAccounts(runtime.client, [
    ["type", "ledger"],
    ["entity_type", "sub_org"],
  ])).filter(
    (account) =>
      account.type === "ledger" &&
      account.provider === "OPENFX" &&
      account.tenant_id == null &&
      account.counterparty_id == null,
  );
  return chooseAccount(runtime.interaction, "Workspace destination OpenFX ledger", matches);
}

function validateDestinationLedger(account: Account, accountId: string): void {
  if (account.type !== "ledger") {
    throw new UsageError(`Destination account ${accountId} is not a ledger account`);
  }
  if (account.provider !== "OPENFX") {
    throw new UsageError(`Destination ledger ${accountId} is not managed by OpenFX`);
  }
  if (account.tenant_id != null || account.counterparty_id != null) {
    throw new UsageError(`Destination OpenFX ledger ${accountId} is not workspace-owned`);
  }
}

async function getRebalance(
  runtime: Runtime,
  rebalanceId: string,
  dashboard?: RebalanceDashboard,
): Promise<Rebalance> {
  const response = await runtime.client.request(
    "GET",
    `/v1/treasury/rebalances/${encodeURIComponent(rebalanceId)}`,
    { operation: "Get rebalance" },
  );
  const rebalance = requireData<Rebalance>(response, "Get rebalance");
  dashboard?.updateRebalance(rebalance);
  return rebalance;
}

function steps(rebalance: Rebalance): RebalanceStep[] {
  if (!Array.isArray(rebalance.steps)) {
    throw new UsageError("Rebalance response did not contain steps");
  }
  return rebalance.steps;
}

function failedSteps(rebalance: Rebalance): RebalanceStep[] {
  return steps(rebalance).filter((step) => step.status === "failed" || step.failed_at);
}

function showStatus(runtime: Runtime, rebalanceId: string, rebalance: Rebalance): void {
  runtime.output.progress("rebalance.status", {
    rebalanceId,
    balanceStatus: rebalance.balance_status,
    steps: steps(rebalance).map((step) => ({
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
  rebalanceId: string,
  environment: RebalanceEnvironment,
  dashboard?: RebalanceDashboard,
): Promise<{ rebalance: Rebalance; step?: RebalanceStep }> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const rebalance = await getRebalance(runtime, rebalanceId, dashboard);
    const rebalanceSteps = steps(rebalance);
    const failed = failedSteps(rebalance);
    if (failed.length) throw new UsageError(`Rebalance failed: ${JSON.stringify(failed)}`);
    if (rebalanceSteps.length && rebalanceSteps.every((step) => step.status === "completed")) {
      return { rebalance };
    }
    const signingSteps = rebalanceSteps.filter(
      (step) => step.provider_key === "turnkey" && step.step_sequence === 1,
    );
    if (signingSteps.length > 1) throw new UsageError("Expected one rebalance source signing step");
    const step = signingSteps[0];
    const state = `${rebalance.balance_status}:${step?.status}`;
    if (state !== previousState) {
      showStatus(runtime, rebalanceId, rebalance);
      previousState = state;
    }
    if (
      step &&
      ((step.status === "signature_requested" && step.unsigned_transaction) ||
        ["signed", "submitted", "confirmed", "completed"].includes(step.status ?? ""))
    ) {
      return { rebalance, step };
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for the rebalance signing step");
}

async function waitForCompletion(
  runtime: Runtime,
  rebalanceId: string,
  environment: RebalanceEnvironment,
  dashboard?: RebalanceDashboard,
): Promise<Rebalance> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  let openFxPrompted = false;
  while (Date.now() < deadline) {
    const rebalance = await getRebalance(runtime, rebalanceId, dashboard);
    const rebalanceSteps = steps(rebalance);
    const failed = failedSteps(rebalance);
    if (failed.length) throw new UsageError(`Rebalance failed: ${JSON.stringify(failed)}`);
    const state = rebalanceSteps.map((step) => `${step.id}:${step.status}`).join("|");
    if (state !== previousState) {
      showStatus(runtime, rebalanceId, rebalance);
      previousState = state;
    }
    if (rebalanceSteps.length && rebalanceSteps.every((step) => step.status === "completed")) {
      return rebalance;
    }
    const signingStep = rebalanceSteps.find(
      (step) => step.provider_key === "turnkey" && step.step_sequence === 1,
    );
    if (
      signingStep &&
      !openFxPrompted &&
      ["submitted", "confirmed"].includes(signingStep.status ?? "") &&
      signingStep.transaction_hash
    ) {
      const mockDeposit = {
        rebalanceId,
        stepId: signingStep.id,
        amount: signingStep.estimated?.from?.amount,
        currency: signingStep.estimated?.from?.currency,
        network: signingStep.estimated?.from?.network,
        sourceAccountId: signingStep.estimated?.from?.account_id,
        destinationLedgerId: signingStep.estimated?.to?.account_id,
        transactionHash: signingStep.transaction_hash,
      };
      runtime.output.progress("rebalance.openfx-mock-deposit-required", mockDeposit);
      dashboard?.updateAction("Create the matching mock deposit in OpenFX sandbox");
      openFxPrompted = true;
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for rebalance completion");
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
