import { firstValue, getKrakenConfiguration, positiveNumber } from "../config.ts";
import { CancelledError, UsageError } from "../errors.ts";
import { KrakenDashboard, resolveKrakenUi } from "../kraken-dashboard.ts";
import { KrakenFundingClient, KrakenSpotClient, type KrakenFundingApi, type KrakenSpotApi } from "../kraken.ts";
import type { KrakenRuntime } from "./kraken.ts";
import { availableKrakenBalance, loadKrakenBalances } from "./kraken-balances.ts";

type KrakenFundingMethod = {
  asset?: { class?: string; name?: string };
  method_id?: string;
  method_name?: string;
  minimum_amount?: string;
  network?: { network_id?: string; network_name?: string } | null;
  [key: string]: unknown;
};

type KrakenFundingAddress = {
  address_id?: string;
  name?: string;
  verified?: boolean;
  address_details?: {
    crypto?: { address?: string; memo?: string; tag?: string };
  };
  [key: string]: unknown;
};

type KrakenFundingWithdrawal = {
  withdrawal_id?: string;
  method_id?: string;
  address_id?: string;
  status?: string;
  amount?: unknown;
  fee?: unknown;
  create_time?: string;
  [key: string]: unknown;
};

type FeeMode = "total" | "receive";

export type KrakenRegisterAddressOptions = {
  asset?: string;
  accountId?: string;
  methodId?: string;
  address?: string;
  name?: string;
  memo?: string;
};

export type KrakenWithdrawOptions = {
  asset?: string;
  accountId?: string;
  methodId?: string;
  addressId?: string;
  amount?: string;
  feeMode?: FeeMode;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  withUi?: boolean;
};

export async function runKrakenWithdrawMenu(runtime: KrakenRuntime): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("A Kraken withdrawal subcommand is required in non-interactive mode");
  }
  while (true) {
    const selection = await runtime.interaction.choose("Kraken withdrawal", [
      { name: "Register new onchain target address", value: "register" },
      { name: "Withdraw to existing target address", value: "withdraw" },
      { name: "Back", value: "back" },
    ] as const);
    if (selection === "back") return;
    try {
      if (selection === "register") await runKrakenRegisterAddress(runtime);
      if (selection === "withdraw") await runKrakenWithdraw(runtime);
    } catch (error) {
      showMenuError(runtime, error);
    }
  }
}

export async function runKrakenRegisterAddress(
  runtime: KrakenRuntime,
  options: KrakenRegisterAddressOptions = {},
  fundingApi?: KrakenFundingApi,
): Promise<void> {
  const client = fundingApi ?? new KrakenFundingClient(getKrakenConfiguration(runtime.environment), runtime.output);
  const asset = (options.asset ?? firstValue(runtime.environment, "KRAKEN_WITHDRAW_ASSET") ?? "USDC").toUpperCase();
  const accountId = options.accountId ?? firstValue(runtime.environment, "KRAKEN_ACCOUNT_ID");
  const method = await selectWithdrawalMethod(runtime, client, asset, accountId, options.methodId);
  const methodId = requireText(method.method_id, "Selected Kraken withdrawal method has no method_id");
  const address = await requiredInput(runtime, "Onchain target address", options.address);
  const name = await requiredInput(runtime, "Target address name", options.name);
  const memo = runtime.interaction.interactive
    ? await runtime.interaction.optionalText("Memo or tag (empty if not required)", options.memo)
    : options.memo;
  runtime.output.info(
    [
      "Register Kraken onchain target:",
      `Asset: ${asset}`,
      `Network: ${method.network?.network_name ?? "Unspecified"}`,
      `Name: ${name}`,
      `Address: ${address}`,
      ...(memo ? [`Memo or tag: ${memo}`] : []),
    ].join("\n"),
  );
  await runtime.interaction.approve("Register this onchain target address in Kraken?", false);
  const response = await client.request("POST", "/funding/v1/addresses", {
    query: { account_id: accountId },
    body: {
      scope: { method_id: methodId },
      address_details: { crypto: { address, ...(memo ? { memo } : {}) } },
      name,
    },
    operation: "Register Kraken onchain target address",
  });
  if (!runtime.output.verbose) runtime.output.result({ ...response, address, method_id: methodId });
}

export async function runKrakenWithdraw(
  runtime: KrakenRuntime,
  options: KrakenWithdrawOptions = {},
  fundingApi?: KrakenFundingApi,
  spotApi?: KrakenSpotApi,
): Promise<void> {
  const withUi = await resolveKrakenUi(runtime.interaction, options.withUi, "withdrawal");
  const dashboard = withUi ? new KrakenDashboard("withdrawal") : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Kraken withdrawal UI: ${dashboard.outputPath}`);
  try {
    const configuration = getKrakenConfiguration(runtime.environment);
    const fundingClient = fundingApi ?? new KrakenFundingClient(configuration, runtime.output);
    const spotClient = spotApi ?? new KrakenSpotClient(configuration, runtime.output);
    const asset = (options.asset ?? firstValue(runtime.environment, "KRAKEN_WITHDRAW_ASSET") ?? "USDC").toUpperCase();
    const accountId = options.accountId ?? firstValue(runtime.environment, "KRAKEN_ACCOUNT_ID");
    dashboard?.update("configure", "Selecting the Kraken withdrawal network and target", {
      asset,
      accountId,
      methodId: options.methodId,
      addressId: options.addressId,
    });
    const method = await selectWithdrawalMethod(runtime, fundingClient, asset, accountId, options.methodId);
    const methodId = requireText(method.method_id, "Selected Kraken withdrawal method has no method_id");
    const target = await selectExistingAddress(runtime, fundingClient, methodId, accountId, options.addressId);
    const addressId = requireText(target.address_id, "Selected Kraken target has no address_id");
    const address = requireText(
      target.address_details?.crypto?.address,
      "Selected Kraken target has no crypto address",
    );
    const feeMode =
      options.feeMode ??
      (await runtime.interaction.choose<FeeMode>("How should Kraken interpret the withdrawal amount?", [
        {
          name: "Total deducted from Kraken, including the fee",
          value: "total",
        },
        {
          name: "Exact amount received; add the fee on top",
          value: "receive",
        },
      ]));
    const amount = await requiredPositiveAmount(runtime, options.amount);
    const minimumAmount = Number(method.minimum_amount);
    if (Number.isFinite(minimumAmount) && Number(amount) < minimumAmount) {
      throw new UsageError(`Kraken requires at least ${method.minimum_amount} ${asset} for this withdrawal network`);
    }
    const feeIncluded = feeMode === "total";
    dashboard?.update("quote", "Calculating the Kraken withdrawal fee", {
      asset,
      amount,
      feeMode,
      method,
      target,
    });
    const feeQuote = await fundingClient.request("GET", `/funding/v1/fees/${encodeURIComponent(methodId)}`, {
      query: { amount, fee_included: feeIncluded, account_id: accountId },
      operation: "Calculate Kraken withdrawal fee",
    });
    const feeToken = requireText(
      feeQuote.withdrawal_fee_token,
      "Kraken withdrawal fee response did not contain withdrawal_fee_token",
    );
    const grossAmount = amountFrom(feeQuote.gross_amount, "gross_amount");
    const netAmount = amountFrom(feeQuote.net_amount, "net_amount");
    const feeAmount = amountFrom(feeQuote.fee, "fee");
    dashboard?.update("balance", "Checking the available Kraken balance", {
      asset,
      grossAmount,
      netAmount,
      feeAmount,
    });
    const balances = await loadKrakenBalances(spotClient);
    const available = availableKrakenBalance(balances, asset);
    if (available < Number(grossAmount)) {
      throw new UsageError(
        `Kraken has ${available} ${asset} available, less than the quoted ${grossAmount} ${asset} debit`,
      );
    }
    runtime.output.info(
      [
        "Kraken onchain withdrawal:",
        `Network: ${method.network?.network_name ?? "Unspecified"}`,
        `Target: ${target.name ?? addressId}`,
        `Address: ${address}`,
        `Kraken debit: ${grossAmount} ${asset}`,
        `Target receives: ${netAmount} ${asset}`,
        `Fee: ${feeAmount} ${asset}`,
      ].join("\n"),
    );
    await runtime.interaction.approve("Create this live Kraken withdrawal?", false);
    const startedAt = new Date().toISOString();
    dashboard?.update("create", "Creating the Kraken withdrawal", {
      asset,
      addressId,
      amount,
      grossAmount,
      netAmount,
      feeAmount,
    });
    const createResponse = await fundingClient.request("POST", "/funding/v1/withdrawals", {
      query: { account_id: accountId },
      body: {
        scope: { method_id: methodId },
        address_id: addressId,
        amount: {
          asset_amount: { asset: { class: "currency", name: asset }, amount },
        },
        fee: { quoted_fee: { token: feeToken }, fee_included: feeIncluded },
        expected_address: address,
      },
      operation: "Create Kraken funding withdrawal",
    });
    if (createResponse.approval_request_id) {
      dashboard?.complete(createResponse);
      if (!runtime.output.verbose) runtime.output.result(createResponse);
      return;
    }
    const withdrawalId = requireText(
      createResponse.withdrawal_id,
      "Kraken withdrawal response did not contain withdrawal_id",
    );
    const pollIntervalSeconds = positiveNumber(
      options.pollIntervalSeconds ?? firstValue(runtime.environment, "KRAKEN_POLL_INTERVAL_SECONDS"),
      "KRAKEN_POLL_INTERVAL_SECONDS",
      3,
    );
    const timeoutSeconds = positiveNumber(
      options.timeoutSeconds ?? firstValue(runtime.environment, "KRAKEN_TIMEOUT_SECONDS"),
      "KRAKEN_TIMEOUT_SECONDS",
      1800,
    );
    dashboard?.update("settle", "Waiting for the Kraken withdrawal to complete", {
      withdrawalId,
      asset,
      addressId,
    });
    const withdrawal = await waitForWithdrawal(
      fundingClient,
      withdrawalId,
      methodId,
      asset,
      accountId,
      startedAt,
      pollIntervalSeconds,
      timeoutSeconds,
      dashboard,
    );
    dashboard?.complete(withdrawal);
    if (!runtime.output.verbose) runtime.output.result(withdrawal);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function selectWithdrawalMethod(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  asset: string,
  accountId: string | undefined,
  configuredMethodId: string | undefined,
): Promise<KrakenFundingMethod> {
  const response = await client.request("GET", "/funding/v1/methods/withdraw", {
    query: {
      asset: { class: "currency", name: asset },
      account_id: accountId,
      limit: 500,
    },
    operation: "List Kraken withdrawal funding methods",
  });
  const methods = requireArray<KrakenFundingMethod>(
    response.methods,
    "Kraken withdrawal-method response did not contain methods",
  ).filter((method) => method.asset?.name?.toUpperCase() === asset);
  if (!methods.length) throw new UsageError(`Kraken returned no ${asset} withdrawal methods`);
  if (configuredMethodId) {
    const configured = methods.find((method) => method.method_id === configuredMethodId);
    if (!configured) throw new UsageError(`Kraken withdrawal method ${configuredMethodId} is unavailable`);
    return configured;
  }
  const selectedMethodId = await runtime.interaction.choose(
    `Select the Kraken ${asset} withdrawal network`,
    methods.map((method) => ({
      name: [
        method.network?.network_name ?? method.method_name ?? "Unnamed network",
        method.minimum_amount ? `minimum ${method.minimum_amount}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      value: requireText(method.method_id, "Kraken withdrawal method has no method_id"),
    })),
  );
  return methods.find((method) => method.method_id === selectedMethodId)!;
}

async function selectExistingAddress(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  methodId: string,
  accountId: string | undefined,
  configuredAddressId: string | undefined,
): Promise<KrakenFundingAddress> {
  const response = await client.request("GET", "/funding/v1/addresses", {
    query: {
      scope: { method_id: methodId },
      account_id: accountId,
      limit: 500,
    },
    operation: "List Kraken onchain target addresses",
  });
  const addresses = (
    Object.keys(response).length === 0
      ? []
      : requireArray<KrakenFundingAddress>(response.addresses, "Kraken address response did not contain addresses")
  ).filter((address) => address.verified && address.address_details?.crypto?.address);
  if (!addresses.length) {
    throw new UsageError(
      "No verified targets exist for this network; register one from the Kraken withdrawal menu first",
    );
  }
  if (configuredAddressId) {
    const configured = addresses.find((address) => address.address_id === configuredAddressId);
    if (!configured) throw new UsageError(`Kraken target ${configuredAddressId} is unavailable for this network`);
    return configured;
  }
  const selectedAddressId = await runtime.interaction.choose(
    "Select the existing Kraken target address",
    addresses.map((address) => ({
      name: [
        address.name ?? "Unnamed target",
        address.address_details?.crypto?.address,
        address.address_details?.crypto?.memo ?? address.address_details?.crypto?.tag,
      ]
        .filter(Boolean)
        .join(" · "),
      value: requireText(address.address_id, "Kraken target has no address_id"),
    })),
  );
  return addresses.find((address) => address.address_id === selectedAddressId)!;
}

async function waitForWithdrawal(
  client: KrakenFundingApi,
  withdrawalId: string,
  methodId: string,
  asset: string,
  accountId: string | undefined,
  startedAt: string,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
  dashboard?: KrakenDashboard,
): Promise<KrakenFundingWithdrawal> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await client.request("GET", "/funding/v1/withdrawals", {
      query: {
        asset: { class: "currency", name: asset },
        scope: { method_id: methodId },
        account_id: accountId,
        start_time: startedAt,
        limit: 500,
      },
      operation: "List Kraken funding withdrawals",
    });
    const withdrawals =
      Object.keys(response).length === 0
        ? []
        : requireArray<KrakenFundingWithdrawal>(
            response.withdrawals,
            "Kraken withdrawal-history response did not contain withdrawals",
          );
    const withdrawal = withdrawals.find((candidate) => candidate.withdrawal_id === withdrawalId);
    const status = withdrawal?.status?.toLowerCase();
    dashboard?.update(
      "settle",
      "Waiting for the Kraken withdrawal to complete",
      withdrawal ?? { withdrawalId, status: "pending" },
      `Status: ${status ?? "pending"}`,
    );
    if (status === "success") return withdrawal!;
    if (status === "failed") throw new UsageError(`Kraken withdrawal ${withdrawalId} failed`);
    await Bun.sleep(pollIntervalSeconds * 1000);
  }
  throw new UsageError(`Timed out waiting for Kraken withdrawal ${withdrawalId}`);
}

async function requiredInput(
  runtime: KrakenRuntime,
  label: string,
  suppliedValue: string | undefined,
): Promise<string> {
  if (runtime.interaction.interactive) return runtime.interaction.text(label, suppliedValue);
  return requireText(suppliedValue, `${label} is required in non-interactive mode`);
}

async function requiredPositiveAmount(runtime: KrakenRuntime, suppliedValue: string | undefined): Promise<string> {
  const configured = suppliedValue ?? firstValue(runtime.environment, "KRAKEN_WITHDRAW_AMOUNT");
  const amount = runtime.interaction.interactive
    ? await runtime.interaction.text("USDC amount", configured)
    : configured;
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new UsageError("A positive USDC withdrawal amount is required");
  }
  return amount;
}

function amountFrom(value: unknown, name: string): string {
  const record = requireRecord(value, `Kraken fee response did not contain ${name}`);
  return requireText(record.amount, `Kraken ${name} did not contain amount`);
}

function showMenuError(runtime: KrakenRuntime, error: unknown): void {
  if (error instanceof CancelledError) runtime.output.info(error.message);
  else if (error instanceof Error) runtime.output.error(error.message);
  else runtime.output.error(String(error));
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(message);
  return value as Record<string, unknown>;
}

function requireArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new UsageError(message);
  return value as T[];
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(message);
  return value;
}
