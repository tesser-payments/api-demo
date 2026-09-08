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
import { getSigningConfiguration, positiveNumber } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { requireData } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { signStep } from "../signer.ts";

const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const evmNetworks = new Set([
  "BASE",
  "BASE_SEPOLIA",
  "ETHEREUM",
  "ETHEREUM_SEPOLIA",
  "POLYGON",
  "POLYGON_AMOY",
]);
const rejectedRiskStatuses = new Set(["automatically_rejected", "manually_rejected"]);

type Step = {
  id?: string;
  step_sequence?: number;
  provider_key?: string;
  step_type?: string;
  status?: string;
  status_reasons?: unknown;
  failed_at?: string | null;
  transaction_hash?: string | null;
  unsigned_transaction?: string | null;
  estimated?: {
    from?: { account_id?: string; network?: string };
  };
};

type Payment = {
  id?: string;
  risk_status?: string;
  risk_status_reasons?: unknown;
  balance_status?: string;
  steps?: Step[];
  [key: string]: unknown;
};

export type PaymentOptions = {
  paymentId?: string;
  sourceWalletId?: string;
  destinationAccountId?: string;
  destinationName?: string;
  destinationCounterpartyId?: string;
  fundingAccountId?: string;
  amount?: string;
  currency?: string;
  network?: string;
  organizationReferenceId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
};

type PaymentEnvironment = {
  sourceWalletId?: string;
  fundingAccountId?: string;
  amount?: string;
  currency: string;
  network: string;
  organizationReferenceId: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
};

export async function runPayment(
  runtime: Runtime,
  destinationWalletAddress: string | undefined,
  options: PaymentOptions,
): Promise<void> {
  if (options.paymentId && (destinationWalletAddress || options.destinationAccountId)) {
    throw new UsageError("Do not pass a destination when resuming with --payment-id");
  }
  if (destinationWalletAddress && options.destinationAccountId) {
    throw new UsageError("Use either a destination wallet address or --destination-account-id");
  }
  const environment = resolvePaymentEnvironment(options);
  await runtime.interaction.approve("authenticating with Auth0 client credentials");
  await runtime.client.authenticate();
  let activePaymentId = options.paymentId;
  let sourceWallet: Account | undefined;

  if (!activePaymentId) {
    sourceWallet = await resolveSourceWallet(runtime, environment);
    const amount = validateAmount(
      await runtime.interaction.text("Payment amount", environment.amount),
    );
    const fundingAccount = await resolveFundingAccount(runtime, environment.fundingAccountId);
    const destinationWallet = await resolveDestinationWallet(
      runtime,
      sourceWallet,
      destinationWalletAddress,
      options,
    );
    const requestBody = {
      organization_reference_id: environment.organizationReferenceId,
      funding_account_id: requireAccountId(fundingAccount, "Funding account"),
      desired: {
        from: {
          account_id: requireAccountId(sourceWallet, "Source wallet"),
          amount,
          currency: environment.currency,
          network: environment.network,
        },
        to: {
          account_id: requireAccountId(destinationWallet, "Destination wallet"),
          currency: environment.currency,
          network: environment.network,
        },
      },
    };
    await runtime.interaction.approve("creating the payment");
    const response = await runtime.client.request("POST", "/v1/payments", {
      body: requestBody,
      operation: "Create payment",
    });
    const payment = requireData<Payment>(response, "Create payment");
    if (!payment.id) throw new ApiError("Create payment response did not contain an ID", response.status, response.body);
    activePaymentId = payment.id;
    runtime.output.progress("payment.created", { paymentId: activePaymentId });
  }

  await runtime.interaction.approve("polling until the payment is ready for signing");
  const signingState = await waitForSigning(runtime, activePaymentId, environment);
  if (!signingState.step) {
    runtime.output.result(signingState.payment);
    return;
  }
  let payment = signingState.payment;
  const step = signingState.step;
  if (step.status === "signature_requested") {
    if (!step.id) throw new UsageError("Payment signing step does not contain an ID");
    const sourceAccountId = step.estimated?.from?.account_id;
    if (!sourceAccountId) throw new UsageError("Payment signing step does not contain estimated.from.account_id");
    sourceWallet ??= await getAccount(runtime.client, sourceAccountId);
    const unsignedTransaction = step.unsigned_transaction;
    const network = step.estimated?.from?.network;
    if (!unsignedTransaction || !network) {
      throw new UsageError("Payment signing step is missing its unsigned transaction or network");
    }
    await runtime.interaction.approve("signing the payment transaction locally");
    const signature = await signStep(getSigningConfiguration(runtime.environment), {
      unsignedTransaction,
      signWith: requireWalletAddress(sourceWallet, "Source wallet"),
      network,
    });
    await runtime.interaction.approve("submitting the payment signature");
    const response = await runtime.client.request(
      "POST",
      `/v1/payments/${encodeURIComponent(activePaymentId)}/steps/${encodeURIComponent(step.id)}/sign`,
      { body: { signature }, operation: "Submit payment signature" },
    );
    payment = requireData<Payment>(response, "Submit payment signature");
    runtime.output.progress("payment.signature-submitted", {
      paymentId: activePaymentId,
      stepId: step.id,
    });
  }
  await runtime.interaction.approve("polling until every payment step completes");
  payment = await waitForCompletion(runtime, activePaymentId, environment);
  runtime.output.result(payment);
}

function resolvePaymentEnvironment(options: PaymentOptions): PaymentEnvironment {
  const currency = (options.currency ?? "USDC").toUpperCase();
  const network = (options.network ?? "BASE_SEPOLIA").toUpperCase();
  if (!evmNetworks.has(network)) {
    throw new UsageError(`Payment supports EVM networks only: ${[...evmNetworks].join(", ")}`);
  }
  return {
    sourceWalletId: options.sourceWalletId,
    fundingAccountId: options.fundingAccountId,
    amount: options.amount,
    currency,
    network,
    organizationReferenceId:
      options.organizationReferenceId ?? `payment-${randomUUID()}`,
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
  };
}

async function resolveSourceWallet(
  runtime: Runtime,
  environment: PaymentEnvironment,
): Promise<Account> {
  const account = environment.sourceWalletId
    ? await getAccount(runtime.client, environment.sourceWalletId)
    : await chooseAccount(
        runtime.interaction,
        "Managed source wallet",
        (await listAccounts(runtime.client, [["entity_type", "sub_org"]])).filter(
          (candidate) =>
            candidate.tenant_id == null &&
            candidate.counterparty_id == null &&
            candidate.is_managed === true &&
            Boolean(candidate.crypto_wallet_address) &&
            accountSupports(candidate, environment.currency, environment.network),
        ),
      );
  const id = requireAccountId(account, "Source wallet");
  requireWalletAddress(account, `Source wallet ${id}`);
  if (account.is_managed !== true) throw new UsageError(`Source wallet ${id} is not managed`);
  if (!accountSupports(account, environment.currency, environment.network)) {
    throw new UsageError(`Source wallet ${id} does not support ${environment.currency} on ${environment.network}`);
  }
  return account;
}

async function resolveFundingAccount(
  runtime: Runtime,
  fundingAccountId: string | undefined,
): Promise<Account> {
  if (fundingAccountId) {
    const account = await getAccount(runtime.client, fundingAccountId);
    if (account.type !== "fiat_bank") throw new UsageError(`Funding account ${fundingAccountId} is not a fiat bank account`);
    return account;
  }
  const matches = (await listAccounts(runtime.client, [
    ["type", "fiat_bank"],
    ["entity_type", "sub_org"],
  ])).filter(
    (account) =>
      account.type === "fiat_bank" && account.tenant_id == null && account.counterparty_id == null,
  );
  return chooseAccount(runtime.interaction, "Workspace funding account", matches);
}

async function resolveDestinationWallet(
  runtime: Runtime,
  sourceWallet: Account,
  addressInput: string | undefined,
  options: PaymentOptions,
): Promise<Account> {
  let destination: Account;
  if (options.destinationAccountId) {
    destination = await getAccount(runtime.client, options.destinationAccountId);
  } else {
    const address = await runtime.interaction.text("Destination wallet address", addressInput);
    if (!evmAddress.test(address)) throw new UsageError("Destination wallet address must be a 20-byte EVM address");
    const matches = (await listAccounts(runtime.client)).filter(
      (account) => account.crypto_wallet_address?.toLowerCase() === address.toLowerCase(),
    );
    if (matches.length > 1) throw new UsageError(`Multiple destination accounts use ${address}`);
    if (matches.length === 1) destination = matches[0]!;
    else {
      const name = await runtime.interaction.text(
        "Destination account name",
        options.destinationName,
        `External wallet ${address.slice(0, 10)}`,
      );
      const body: Record<string, unknown> = {
        name,
        type: "stablecoin_ethereum",
        is_managed: false,
        wallet_address: address,
      };
      if (options.destinationCounterpartyId) body.counterparty_id = options.destinationCounterpartyId;
      await runtime.interaction.approve("registering the destination wallet address");
      const response = await runtime.client.request("POST", "/v1/accounts/wallets", {
        body,
        operation: "Register destination wallet",
      });
      destination = requireData<Account>(response, "Register destination wallet");
    }
  }
  const destinationId = requireAccountId(destination, "Destination wallet");
  const destinationAddress = requireWalletAddress(destination, `Destination wallet ${destinationId}`);
  const sourceId = requireAccountId(sourceWallet, "Source wallet");
  const sourceAddress = requireWalletAddress(sourceWallet, "Source wallet");
  if (destinationId === sourceId || destinationAddress.toLowerCase() === sourceAddress.toLowerCase()) {
    throw new UsageError("Source and destination wallets must be different");
  }
  return destination;
}

async function getPayment(runtime: Runtime, paymentId: string): Promise<Payment> {
  const response = await runtime.client.request("GET", `/v1/payments/${encodeURIComponent(paymentId)}`, {
    operation: "Get payment",
  });
  return requireData<Payment>(response, "Get payment");
}

function steps(payment: Payment): Step[] {
  if (!Array.isArray(payment.steps)) throw new UsageError("Payment response did not contain steps");
  return payment.steps;
}

function failIfTerminal(payment: Payment): void {
  if (payment.risk_status && rejectedRiskStatuses.has(payment.risk_status)) {
    throw new UsageError(`Payment risk status is ${payment.risk_status}: ${JSON.stringify(payment.risk_status_reasons ?? [])}`);
  }
  const failed = steps(payment).filter((step) => step.status === "failed" || step.failed_at);
  if (failed.length) throw new UsageError(`Payment failed: ${JSON.stringify(failed)}`);
}

async function waitForSigning(
  runtime: Runtime,
  paymentId: string,
  environment: PaymentEnvironment,
): Promise<{ payment: Payment; step?: Step }> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const payment = await getPayment(runtime, paymentId);
    failIfTerminal(payment);
    const paymentSteps = steps(payment);
    if (paymentSteps.length && paymentSteps.every((step) => step.status === "completed")) {
      return { payment };
    }
    const signingSteps = paymentSteps.filter(
      (step) => step.provider_key === "turnkey" && step.step_sequence === 1,
    );
    if (signingSteps.length > 1) throw new UsageError("Expected one source signing step");
    const step = signingSteps[0];
    const state = `${payment.risk_status}:${step?.status}`;
    if (state !== previousState) {
      runtime.output.progress("payment.status", {
        paymentId,
        riskStatus: payment.risk_status,
        balanceStatus: payment.balance_status,
        steps: paymentSteps.map((item) => ({ id: item.id, status: item.status, provider: item.provider_key })),
      });
      previousState = state;
    }
    if (
      step &&
      ((step.status === "signature_requested" && step.unsigned_transaction) ||
        ["signed", "submitted", "confirmed", "completed"].includes(step.status ?? ""))
    ) {
      return { payment, step };
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for the payment signing step");
}

async function waitForCompletion(
  runtime: Runtime,
  paymentId: string,
  environment: PaymentEnvironment,
): Promise<Payment> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  while (Date.now() < deadline) {
    const payment = await getPayment(runtime, paymentId);
    failIfTerminal(payment);
    const paymentSteps = steps(payment);
    const state = paymentSteps.map((step) => `${step.id}:${step.status}`).join("|");
    if (state !== previousState) {
      runtime.output.progress("payment.status", {
        paymentId,
        balanceStatus: payment.balance_status,
        steps: paymentSteps.map((step) => ({ id: step.id, status: step.status, provider: step.provider_key })),
      });
      previousState = state;
    }
    if (paymentSteps.length && paymentSteps.every((step) => step.status === "completed")) return payment;
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  throw new UsageError("Timed out waiting for payment completion");
}

function validateAmount(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new UsageError("Payment amount must be greater than zero");
  return value;
}
