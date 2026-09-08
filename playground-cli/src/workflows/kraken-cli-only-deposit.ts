import { randomUUID } from "node:crypto";
import { firstValue, getKrakenConfiguration, positiveNumber } from "../config.ts";
import { UsageError } from "../errors.ts";
import { KrakenDashboard, resolveKrakenUi } from "../kraken-dashboard.ts";
import {
  KrakenFundingClient,
  KrakenSpotClient,
  type KrakenFundingApi,
  type KrakenSpotApi,
} from "../kraken.ts";
import {
  availableKrakenBalance,
  loadKrakenBalances,
  normalizeKrakenAsset,
} from "./kraken-balances.ts";
import { runKraken, type KrakenDeposit, type KrakenRuntime } from "./kraken.ts";

type KrakenWithdrawalNetwork = "ETHEREUM" | "BASE";

type KrakenCliOnlyDepositEnvironment = {
  amount?: string;
  resumeUsdAmount?: string;
  destinationAddress?: string;
  network?: KrakenWithdrawalNetwork;
  depositMethodId?: string;
  krakenDepositId?: string;
  withdrawalMethodId?: string;
  accountId?: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
};

type KrakenFundingMethod = {
  asset?: { class?: string; name?: string };
  method_id?: string;
  method_name?: string;
  minimum_amount?: string;
  network?: {
    network_id?: string;
    network_name?: string;
    contract_address?: string;
    on_chain_asset_symbol?: string;
  } | null;
};

type KrakenFundingAddress = {
  address_id?: string;
  verified?: boolean;
  address_details?: { crypto?: { address?: string } };
};

type KrakenPair = {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
  status?: string;
  lot_decimals?: number;
};

type KrakenAsset = {
  altname?: string;
  decimals?: number;
};

type KrakenOrder = {
  status?: string;
  reason?: string | null;
  vol?: string;
  vol_exec?: string;
  cost?: string;
  fee?: string;
  price?: string;
};

type KrakenMarketOrderResult = {
  orderId: string;
  pair: string;
  side: "buy" | "sell";
  inputAmount: string;
  outputAmount: string;
  executedVolume: string;
  cost: string;
  fee: string;
  averagePrice?: string;
};

type KrakenWithdrawal = {
  withdrawal_id?: string;
  status?: string;
  amount?: unknown;
  fee?: unknown;
  onchain_transaction?: unknown;
};

type KrakenWithdrawalResult = {
  withdrawalId: string;
  grossAmount: string;
  netAmount: string;
  feeAmount: string;
  status: string;
  transactionHash?: string;
  approvalRequestId?: string;
};

export type KrakenCliOnlyDepositOptions = {
  amount?: string;
  resumeUsdAmount?: string;
  destinationAddress?: string;
  network?: string;
  depositMethodId?: string;
  krakenDepositId?: string;
  withdrawalMethodId?: string;
  accountId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  validateOnly?: boolean;
  withUi?: boolean;
};

export type KrakenCliOnlyDepositApis = {
  fundingApi?: KrakenFundingApi;
  spotApi?: KrakenSpotApi;
};

const nativeUsdcContracts: Record<KrakenWithdrawalNetwork, string> = {
  ETHEREUM: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  BASE: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
};

export async function runKrakenCliOnlyDeposit(
  runtime: KrakenRuntime,
  options: KrakenCliOnlyDepositOptions,
  apis: KrakenCliOnlyDepositApis = {},
): Promise<void> {
  const environment = resolveEnvironment(runtime, options);
  const withUi = await resolveKrakenUi(
    runtime.interaction,
    options.withUi,
    "cli-only-deposit",
    options.validateOnly,
  );
  const dashboard = withUi ? new KrakenDashboard("cli-only-deposit") : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Kraken CLI-only deposit UI: ${dashboard.outputPath}`);
  try {
    if (runtime.interaction.interactive && !options.validateOnly) {
      await configureEnvironment(runtime, environment);
    }
    const expectedAmount = environment.amount
      ? requirePositiveDecimal(environment.amount, "BRL amount")
      : undefined;
    const resumeUsdAmount = environment.resumeUsdAmount
      ? requirePositiveDecimal(environment.resumeUsdAmount, "Resume USD amount")
      : undefined;
    if (resumeUsdAmount && (expectedAmount || environment.krakenDepositId || environment.depositMethodId)) {
      throw new UsageError(
        "Resume USD amount cannot be combined with BRL amount, Kraken deposit ID, or deposit method ID",
      );
    }
    const network = requireNetwork(environment.network);
    const destinationAddress = requireEvmAddress(environment.destinationAddress);
    const configuration = getKrakenConfiguration(runtime.environment);
    showEnvironment(runtime, environment, expectedAmount, destinationAddress, network, configuration.baseUrl);
    if (options.validateOnly) {
      dashboard?.complete({ valid: true });
      runtime.output.result({ valid: true });
      return;
    }
    const fundingApi = apis.fundingApi ?? new KrakenFundingClient(configuration, runtime.output);
    const spotApi = apis.spotApi ?? new KrakenSpotClient(configuration, runtime.output);
    dashboard?.update("target", "Preparing the destination address", {
      destinationAddress: maskedAddress(destinationAddress),
      network,
    });
    const withdrawalMethod = await resolveWithdrawalMethod(
      runtime,
      fundingApi,
      network,
      environment.withdrawalMethodId,
      environment.accountId,
    );
    const withdrawalMethodId = requireText(
      withdrawalMethod.method_id,
      "Selected Kraken withdrawal method has no method_id",
    );
    const withdrawalAddressId = await resolveWithdrawalAddress(
      fundingApi,
      withdrawalMethodId,
      destinationAddress,
      network,
      environment.accountId,
    );
    dashboard?.update("target", "Prepared the destination address", {
      destinationAddress: maskedAddress(destinationAddress),
      network,
      withdrawalMethodId,
      withdrawalAddressId,
    });
    runtime.output.info(
      [
        "Kraken CLI-only deposit:",
        resumeUsdAmount
          ? `Recovery: resume after BRL to USD with ${resumeUsdAmount} available USD`
          : `Deposit: ${expectedAmount ? `${expectedAmount} BRL` : "select an existing deposit or enter a new amount"}`,
        resumeUsdAmount
          ? "Execution: USD to USDC market order"
          : "Execution: BRL1 to USD market order, then USD to USDC market order",
        `Destination: ${maskedAddress(destinationAddress)} on ${network} mainnet`,
        "This command calls Kraken directly and does not call the Tesser API.",
      ].join("\n"),
    );
    let deposit: KrakenDeposit | undefined;
    let depositedAmount: string | undefined;
    let brlToUsd: KrakenMarketOrderResult | undefined;
    let usdAmount = resumeUsdAmount;
    if (resumeUsdAmount) {
      const balances = await loadKrakenBalances(spotApi);
      const availableUsd = String(availableKrakenBalance(balances, "USD"));
      if (decimalCompare(availableUsd, resumeUsdAmount) < 0) {
        throw new UsageError(
          `Kraken has ${availableUsd} USD available, less than the ${resumeUsdAmount} USD recovery amount`,
        );
      }
    } else {
      dashboard?.update("funding", "Waiting for the Kraken BRL deposit", {
        amount: expectedAmount,
        krakenDepositId: environment.krakenDepositId,
        depositMethodId: environment.depositMethodId,
      });
      deposit = await runKraken(
        runtime,
        {
          asset: "BRL",
          methodId: environment.depositMethodId,
          pollIntervalSeconds: environment.pollIntervalSeconds,
          timeoutSeconds: environment.timeoutSeconds,
          embedded: true,
          allowExistingDeposit: true,
          existingDepositId: environment.krakenDepositId,
          expectedAmount,
        },
        fundingApi,
      );
      if (!deposit) throw new UsageError("Kraken BRL deposit did not complete");
      depositedAmount = requireDepositAmount(deposit);
      if (expectedAmount && !decimalEquals(expectedAmount, depositedAmount)) {
        throw new UsageError(
          `Expected a ${expectedAmount} BRL deposit but Kraken reported ${depositedAmount} BRL`,
        );
      }
      const balances = await loadKrakenBalances(spotApi);
      if (decimalCompare(String(availableKrakenBalance(balances, "BRL")), depositedAmount) < 0) {
        throw new UsageError(`Kraken does not have the deposited ${depositedAmount} BRL available for trading`);
      }
      dashboard?.update("brl-usd", "Executing the Kraken BRL1 to USD market order", {
        amount: depositedAmount,
        fromCurrency: "BRL",
        toCurrency: "USD",
      });
      brlToUsd = await executeMarketOrder(
        runtime,
        spotApi,
        {
          requestedPair: "BRL1USD",
          baseAsset: "BRL",
          quoteAsset: "USD",
          side: "sell",
          volume: depositedAmount,
          flags: "fciq",
          inputCurrency: "BRL",
          outputCurrency: "USD",
        },
        environment,
        dashboard,
        "brl-usd",
      );
      usdAmount = brlToUsd.outputAmount;
      const updatedBalances = await loadKrakenBalances(spotApi);
      const availableUsd = String(availableKrakenBalance(updatedBalances, "USD"));
      if (decimalCompare(availableUsd, usdAmount) < 0) {
        throw new UsageError(
          `Kraken reported ${usdAmount} USD from the BRL order but only ${availableUsd} USD is available`,
        );
      }
    }
    if (!usdAmount) throw new UsageError("Kraken USD amount is missing");
    dashboard?.update("usd-usdc", "Executing the Kraken USD to USDC market order", {
      amount: usdAmount,
      fromCurrency: "USD",
      toCurrency: "USDC",
    });
    const usdToUsdc = await executeMarketOrder(
      runtime,
      spotApi,
      {
        requestedPair: "USDCUSD",
        baseAsset: "USDC",
        quoteAsset: "USD",
        side: "buy",
        volume: usdAmount,
        flags: "viqc,fcib",
        inputCurrency: "USD",
        outputCurrency: "USDC",
      },
      environment,
      dashboard,
      "usd-usdc",
    );
    dashboard?.update("withdrawal", "Withdrawing USDC to the destination address", {
      amount: usdToUsdc.outputAmount,
      destinationAddress: maskedAddress(destinationAddress),
      network,
      withdrawalMethodId,
      withdrawalAddressId,
    });
    const withdrawal = await executeWithdrawal(
      runtime,
      fundingApi,
      {
        amount: usdToUsdc.outputAmount,
        method: withdrawalMethod,
        addressId: withdrawalAddressId,
        expectedAddress: destinationAddress,
        accountId: environment.accountId,
      },
      environment,
      dashboard,
    );
    const result = {
      mode: "cli-only",
      status: "completed",
      source: resumeUsdAmount
        ? { currency: "USD", amount: resumeUsdAmount, recovery: "after-brl-to-usd" }
        : { currency: "BRL", amount: depositedAmount },
      destination: {
        address: maskedAddress(destinationAddress),
        currency: "USDC",
        network,
        net_amount: withdrawal.netAmount,
      },
      kraken_deposit_id: deposit?.deposit_id,
      brl_to_usd: brlToUsd,
      usd_to_usdc: usdToUsdc,
      withdrawal,
    };
    dashboard?.complete(result);
    runtime.output.result(result);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function resolveEnvironment(
  runtime: KrakenRuntime,
  options: KrakenCliOnlyDepositOptions,
): KrakenCliOnlyDepositEnvironment {
  return {
    amount: options.amount ?? firstValue(runtime.environment, "KRAKEN_CLI_ONLY_DEPOSIT_AMOUNT"),
    resumeUsdAmount: options.resumeUsdAmount,
    destinationAddress:
      options.destinationAddress ??
      firstValue(runtime.environment, "KRAKEN_CLI_ONLY_DESTINATION_ADDRESS"),
    network: parseNetwork(
      options.network ?? firstValue(runtime.environment, "KRAKEN_CLI_ONLY_DESTINATION_NETWORK"),
    ),
    depositMethodId:
      options.depositMethodId ?? firstValue(runtime.environment, "KRAKEN_CLI_ONLY_DEPOSIT_METHOD_ID"),
    krakenDepositId:
      options.krakenDepositId ?? firstValue(runtime.environment, "KRAKEN_CLI_ONLY_KRAKEN_DEPOSIT_ID"),
    withdrawalMethodId:
      options.withdrawalMethodId ??
      firstValue(runtime.environment, "KRAKEN_CLI_ONLY_WITHDRAWAL_METHOD_ID"),
    accountId: options.accountId ?? firstValue(runtime.environment, "KRAKEN_ACCOUNT_ID"),
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds ?? firstValue(runtime.environment, "KRAKEN_POLL_INTERVAL_SECONDS"),
      "KRAKEN_POLL_INTERVAL_SECONDS",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds ?? firstValue(runtime.environment, "KRAKEN_TIMEOUT_SECONDS"),
      "KRAKEN_TIMEOUT_SECONDS",
      1800,
    ),
  };
}

async function configureEnvironment(
  runtime: KrakenRuntime,
  environment: KrakenCliOnlyDepositEnvironment,
): Promise<void> {
  if (!environment.destinationAddress) {
    environment.destinationAddress = await runtime.interaction.text("Destination EVM address");
  }
  if (!environment.network) {
    environment.network = await runtime.interaction.choose("Destination mainnet", [
      { name: "Base", value: "BASE" as const },
      { name: "Ethereum", value: "ETHEREUM" as const },
    ]);
  }
  type Field =
    | "continue"
    | "amount"
    | "resumeUsdAmount"
    | "destinationAddress"
    | "network"
    | "depositMethodId"
    | "krakenDepositId"
    | "withdrawalMethodId"
    | "accountId"
    | "pollIntervalSeconds"
    | "timeoutSeconds";
  while (true) {
    const field = await runtime.interaction.choose<Field>("Review Kraken CLI-only deposit values", [
      { name: "Use these values", value: "continue" },
      {
        name: `Expected amount: ${environment.amount ? `${environment.amount} BRL` : "From selected deposit"}`,
        value: "amount",
      },
      {
        name: `Resume USD amount: ${environment.resumeUsdAmount ?? "Disabled"}`,
        value: "resumeUsdAmount",
      },
      {
        name: `Destination address: ${environment.destinationAddress ? maskedAddress(environment.destinationAddress) : "Required"}`,
        value: "destinationAddress",
      },
      { name: `Network: ${environment.network}`, value: "network" },
      {
        name: `Deposit method: ${environment.depositMethodId ?? "Interactive selection"}`,
        value: "depositMethodId",
      },
      {
        name: `Existing Kraken deposit: ${environment.krakenDepositId ?? "Interactive choice"}`,
        value: "krakenDepositId",
      },
      {
        name: `Withdrawal method: ${environment.withdrawalMethodId ?? "Automatic native USDC match"}`,
        value: "withdrawalMethodId",
      },
      { name: `Kraken account: ${environment.accountId ?? "Default"}`, value: "accountId" },
      { name: `Poll interval: ${environment.pollIntervalSeconds} seconds`, value: "pollIntervalSeconds" },
      { name: `Timeout: ${environment.timeoutSeconds} seconds`, value: "timeoutSeconds" },
    ]);
    if (field === "continue") return;
    if (field === "amount") {
      environment.amount = await runtime.interaction.optionalText(
        "Expected BRL amount (empty uses the selected deposit amount)",
        environment.amount,
      );
    }
    if (field === "resumeUsdAmount") {
      environment.resumeUsdAmount = await runtime.interaction.optionalText(
        "Available USD amount after the completed BRL to USD order",
        environment.resumeUsdAmount,
      );
    }
    if (field === "destinationAddress") {
      environment.destinationAddress = await runtime.interaction.optionalText(
        "Destination EVM address",
        environment.destinationAddress,
      );
    }
    if (field === "network") {
      environment.network = await runtime.interaction.choose("Destination mainnet", [
        { name: "Base", value: "BASE" as const },
        { name: "Ethereum", value: "ETHEREUM" as const },
      ]);
    }
    if (field === "depositMethodId") {
      environment.depositMethodId = await runtime.interaction.optionalText(
        "Kraken BRL deposit method ID (empty selects interactively)",
        environment.depositMethodId,
      );
    }
    if (field === "krakenDepositId") {
      environment.krakenDepositId = await runtime.interaction.optionalText(
        "Successful Kraken deposit ID (empty asks interactively)",
        environment.krakenDepositId,
      );
    }
    if (field === "withdrawalMethodId") {
      environment.withdrawalMethodId = await runtime.interaction.optionalText(
        "Kraken USDC withdrawal method ID (empty matches native USDC automatically)",
        environment.withdrawalMethodId,
      );
    }
    if (field === "accountId") {
      environment.accountId = await runtime.interaction.optionalText(
        "Kraken account ID (empty uses the API key default)",
        environment.accountId,
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

async function resolveWithdrawalMethod(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  network: KrakenWithdrawalNetwork,
  configuredMethodId: string | undefined,
  accountId: string | undefined,
): Promise<KrakenFundingMethod> {
  const methods = await listWithdrawalMethods(client, accountId);
  const matchingMethods = methods.filter((method) => isNativeUsdcMethod(method, network));
  if (configuredMethodId) {
    const configuredMethod = matchingMethods.find((method) => method.method_id === configuredMethodId);
    if (!configuredMethod) {
      throw new UsageError(
        `Kraken withdrawal method ${configuredMethodId} is not native USDC on ${network}`,
      );
    }
    return configuredMethod;
  }
  if (!matchingMethods.length) throw new UsageError(`Kraken returned no native USDC withdrawal method for ${network}`);
  if (matchingMethods.length > 1) {
    const methodId = await runtime.interaction.choose(
      `Select the Kraken native USDC ${network} withdrawal method`,
      matchingMethods.map((method) => ({
        name: `${method.method_name ?? "Unnamed method"} · ${method.network?.network_name ?? network}`,
        value: requireText(method.method_id, "Kraken withdrawal method has no method_id"),
      })),
    );
    return matchingMethods.find((method) => method.method_id === methodId)!;
  }
  return matchingMethods[0]!;
}

async function listWithdrawalMethods(
  client: KrakenFundingApi,
  accountId: string | undefined,
): Promise<KrakenFundingMethod[]> {
  const methods: KrakenFundingMethod[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.request("GET", "/funding/v1/methods/withdraw", {
      query: cursor
        ? { cursor }
        : {
            asset: { class: "currency", name: "USDC" },
            account_id: accountId,
            limit: 500,
          },
      operation: "List Kraken USDC withdrawal methods",
    });
    methods.push(...requireArray<KrakenFundingMethod>(response.methods, "Kraken withdrawal methods are missing"));
    cursor = optionalText(response.next_cursor);
    if (!cursor) return methods;
  }
  throw new UsageError("Kraken withdrawal methods exceeded the 10-page limit");
}

function isNativeUsdcMethod(method: KrakenFundingMethod, network: KrakenWithdrawalNetwork): boolean {
  return (
    method.asset?.class === "currency" &&
    method.asset.name?.toUpperCase() === "USDC" &&
    normalizeNetwork(method.network?.network_name) === network &&
    method.network?.on_chain_asset_symbol?.toUpperCase() === "USDC" &&
    method.network.contract_address?.toLowerCase() === nativeUsdcContracts[network]
  );
}

async function resolveWithdrawalAddress(
  client: KrakenFundingApi,
  methodId: string,
  destinationAddress: string,
  network: KrakenWithdrawalNetwork,
  accountId: string | undefined,
): Promise<string> {
  const addresses = await listWithdrawalAddresses(client, methodId, accountId);
  const matches = addresses.filter(
    (address) =>
      address.address_details?.crypto?.address?.toLowerCase() === destinationAddress.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new UsageError(`Kraken returned multiple ${network} registrations for the destination address`);
  }
  const existingAddress = matches[0];
  if (existingAddress) {
    if (!existingAddress.verified) {
      throw new UsageError("Kraken registration for the destination address is not verified");
    }
    return requireText(existingAddress.address_id, "Kraken withdrawal address has no address_id");
  }
  throw new UsageError(
    `The destination address must be registered manually in Kraken for native USDC on ${network} before retrying`,
  );
}

async function listWithdrawalAddresses(
  client: KrakenFundingApi,
  methodId: string,
  accountId: string | undefined,
): Promise<KrakenFundingAddress[]> {
  const addresses: KrakenFundingAddress[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.request("GET", "/funding/v1/addresses", {
      query: cursor
        ? { cursor }
        : { scope: { method_id: methodId }, account_id: accountId, limit: 500 },
      operation: "List Kraken CLI-only withdrawal addresses",
    });
    if (Object.keys(response).length !== 0) {
      addresses.push(...requireArray<KrakenFundingAddress>(response.addresses, "Kraken addresses are missing"));
    }
    cursor = optionalText(response.next_cursor);
    if (!cursor) return addresses;
  }
  throw new UsageError("Kraken withdrawal addresses exceeded the 10-page limit");
}

type MarketOrderInput = {
  requestedPair: string;
  baseAsset: string;
  quoteAsset: string;
  side: "buy" | "sell";
  volume: string;
  flags: string;
  inputCurrency: string;
  outputCurrency: string;
};

async function executeMarketOrder(
  runtime: KrakenRuntime,
  client: KrakenSpotApi,
  input: MarketOrderInput,
  environment: KrakenCliOnlyDepositEnvironment,
  dashboard: KrakenDashboard | undefined,
  dashboardStage: "brl-usd" | "usd-usdc",
): Promise<KrakenMarketOrderResult> {
  const pair = await resolvePair(client, input.requestedPair, input.baseAsset, input.quoteAsset);
  const pairName = pair.altname ?? pair.wsname?.replace("/", "");
  if (!pairName) throw new UsageError(`Kraken ${input.requestedPair} pair has no order symbol`);
  const order = {
    ordertype: "market",
    type: input.side,
    volume: input.volume,
    pair: pairName,
    oflags: input.flags,
    cl_ord_id: randomUUID(),
  };
  await client.request("POST", "/0/private/AddOrder", {
    body: { ...order, validate: true },
    operation: `Validate Kraken ${input.inputCurrency} to ${input.outputCurrency} market order`,
  });
  runtime.output.info(
    [
      `Kraken ${input.inputCurrency} to ${input.outputCurrency} market order is valid:`,
      `Input: ${input.volume} ${input.inputCurrency}`,
      `Execution: immediate available market price on ${pairName}`,
    ].join("\n"),
  );
  await runtime.interaction.approve(
    `Place the live ${input.inputCurrency} to ${input.outputCurrency} Kraken market order?`,
    false,
  );
  const response = await client.request("POST", "/0/private/AddOrder", {
    body: { ...order, deadline: new Date(Date.now() + 15_000).toISOString() },
    operation: `Place Kraken ${input.inputCurrency} to ${input.outputCurrency} market order`,
  });
  const result = requireRecord(response.result, "Kraken Add Order response did not contain result");
  const orderIds = requireArray<string>(result.txid, "Kraken Add Order response did not contain txid");
  if (orderIds.length !== 1) throw new UsageError("Kraken Add Order did not return exactly one order ID");
  const orderId = requireText(orderIds[0], "Kraken Add Order returned an empty order ID");
  const completedOrder = await waitForOrder(
    client,
    orderId,
    environment.pollIntervalSeconds,
    environment.timeoutSeconds,
    dashboard,
    dashboardStage,
  );
  const executedVolume = requireDecimal(completedOrder.vol_exec, "Kraken executed volume");
  const cost = requireDecimal(completedOrder.cost, "Kraken order cost");
  const fee = requireDecimal(completedOrder.fee, "Kraken order fee", true);
  const consumedInput = input.side === "sell" ? executedVolume : cost;
  if (!decimalEquals(consumedInput, input.volume)) {
    throw new UsageError(
      `Kraken ${input.inputCurrency} to ${input.outputCurrency} order consumed ${consumedInput} of ${input.volume} ${input.inputCurrency}`,
    );
  }
  const outputFeeAmount =
    input.side === "sell"
      ? fee
      : decimalMultiplyDivide(
          executedVolume,
          fee,
          cost,
          requirePrecision(pair.lot_decimals, `${pairName} lot_decimals`),
        );
  const calculatedOutputAmount =
    input.side === "sell"
      ? decimalSubtract(cost, outputFeeAmount)
      : decimalSubtract(executedVolume, outputFeeAmount);
  const outputAmount = input.side === "sell"
    ? decimalRound(
        calculatedOutputAmount,
        await resolveAssetPrecision(client, input.outputCurrency),
      )
    : calculatedOutputAmount;
  if (decimalCompare(outputAmount, "0") <= 0) {
    throw new UsageError(`Kraken ${input.inputCurrency} to ${input.outputCurrency} order produced no output`);
  }
  return {
    orderId,
    pair: pairName,
    side: input.side,
    inputAmount: input.volume,
    outputAmount,
    executedVolume,
    cost,
    fee,
    averagePrice: optionalText(completedOrder.price),
  };
}

async function resolvePair(
  client: KrakenSpotApi,
  requestedPair: string,
  baseAsset: string,
  quoteAsset: string,
): Promise<KrakenPair> {
  const response = await client.request("GET", "/0/public/AssetPairs", {
    query: { pair: requestedPair },
    operation: `Get Kraken ${requestedPair} market`,
  });
  const result = requireRecord(response.result, "Kraken Asset Pairs response did not contain result");
  const matches = Object.values(result)
    .filter(isRecord)
    .filter(
      (pair) =>
        normalizeKrakenAsset(String(pair.base ?? "")) === baseAsset &&
        normalizeKrakenAsset(String(pair.quote ?? "")) === quoteAsset &&
        pair.status === "online",
    ) as KrakenPair[];
  if (matches.length !== 1) {
    throw new UsageError(`Kraken returned ${matches.length} online ${baseAsset}/${quoteAsset} markets`);
  }
  return matches[0]!;
}

async function resolveAssetPrecision(client: KrakenSpotApi, asset: string): Promise<number> {
  const response = await client.request("GET", "/0/public/Assets", {
    query: { asset },
    operation: `Get Kraken ${asset} asset precision`,
  });
  const result = requireRecord(response.result, "Kraken Assets response did not contain result");
  const matches = Object.values(result)
    .filter(isRecord)
    .filter((candidate) => normalizeKrakenAsset(String(candidate.altname ?? "")) === asset) as KrakenAsset[];
  if (matches.length !== 1) throw new UsageError(`Kraken returned ${matches.length} ${asset} assets`);
  const decimals = matches[0]?.decimals;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0) {
    throw new UsageError(`Kraken ${asset} asset has invalid decimal precision`);
  }
  return decimals;
}

async function waitForOrder(
  client: KrakenSpotApi,
  orderId: string,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
  dashboard: KrakenDashboard | undefined,
  dashboardStage: "brl-usd" | "usd-usdc",
): Promise<KrakenOrder> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await client.request("POST", "/0/private/QueryOrders", {
      body: { txid: orderId, trades: false },
      operation: "Query Kraken CLI-only market order",
    });
    const result = requireRecord(response.result, "Kraken Query Orders response did not contain result");
    const order = result[orderId];
    if (isRecord(order)) {
      const status = String(order.status ?? "").toLowerCase();
      dashboard?.update(
        dashboardStage,
        "Waiting for the Kraken market order to close",
        { orderId, status },
        `Status: ${status || "unknown"}`,
      );
      if (status === "closed") return order as KrakenOrder;
      if (status === "canceled" || status === "expired") {
        throw new UsageError(`Kraken order ${orderId} ended with status ${status}: ${String(order.reason ?? "")}`);
      }
    }
    await Bun.sleep(pollIntervalSeconds * 1000);
  }
  throw new UsageError(`Timed out waiting for Kraken order ${orderId}`);
}

async function executeWithdrawal(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  input: {
    amount: string;
    method: KrakenFundingMethod;
    addressId: string;
    expectedAddress: string;
    accountId?: string;
  },
  environment: KrakenCliOnlyDepositEnvironment,
  dashboard?: KrakenDashboard,
): Promise<KrakenWithdrawalResult> {
  const methodId = requireText(input.method.method_id, "Kraken withdrawal method has no method_id");
  const minimumAmount = optionalText(input.method.minimum_amount);
  if (minimumAmount && decimalCompare(input.amount, minimumAmount) < 0) {
    throw new UsageError(`Kraken requires at least ${minimumAmount} USDC for this withdrawal network`);
  }
  const quote = await client.request("GET", `/funding/v1/fees/${encodeURIComponent(methodId)}`, {
    query: { amount: input.amount, fee_included: true, account_id: input.accountId },
    operation: "Calculate Kraken CLI-only withdrawal fee",
  });
  const feeToken = requireText(quote.withdrawal_fee_token, "Kraken withdrawal fee quote has no token");
  const quotedGrossAmount = fundingAmount(quote.gross_amount, "gross_amount");
  const quotedNetAmount = fundingAmount(quote.net_amount, "net_amount");
  const quotedFeeAmount = fundingAmount(quote.fee, "fee", true);
  if (decimalCompare(quotedNetAmount, "0") <= 0) throw new UsageError("Kraken withdrawal net amount is not positive");
  runtime.output.info(
    [
      "Kraken USDC withdrawal is ready:",
      `Kraken debit: ${quotedGrossAmount} USDC`,
      `Destination receives: ${quotedNetAmount} USDC`,
      `Fee: ${quotedFeeAmount} USDC`,
    ].join("\n"),
  );
  await runtime.interaction.approve("Create the live Kraken withdrawal to the destination address?", false);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const response = await client.request("POST", "/funding/v1/withdrawals", {
    query: { account_id: input.accountId },
    body: {
      scope: { method_id: methodId },
      address_id: input.addressId,
      amount: {
        asset_amount: {
          asset: { class: "currency", name: "USDC" },
          amount: input.amount,
        },
      },
      fee: { quoted_fee: { token: feeToken }, fee_included: true },
      expected_address: input.expectedAddress,
    },
    operation: "Create Kraken CLI-only withdrawal",
  });
  const withdrawalId = requireText(response.withdrawal_id, "Kraken withdrawal response has no withdrawal_id");
  const grossAmount = fundingAmount(response.gross_amount, "created gross_amount");
  const netAmount = fundingAmount(response.net_amount, "created net_amount");
  const feeAmount = fundingAmount(response.fee, "created fee", true);
  const approvalRequestId = optionalText(response.approval_request_id);
  if (approvalRequestId) {
    runtime.output.info("Kraken requires external approval for this withdrawal; polling will continue.");
  }
  const withdrawal = await waitForWithdrawal(
    client,
    withdrawalId,
    methodId,
    input.accountId,
    startedAt,
    environment.pollIntervalSeconds,
    environment.timeoutSeconds,
    dashboard,
  );
  return {
    withdrawalId,
    grossAmount,
    netAmount,
    feeAmount,
    status: requireText(withdrawal.status, "Completed Kraken withdrawal has no status"),
    transactionHash: withdrawalTransactionHash(withdrawal),
    approvalRequestId,
  };
}

async function waitForWithdrawal(
  client: KrakenFundingApi,
  withdrawalId: string,
  methodId: string,
  accountId: string | undefined,
  startedAt: string,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
  dashboard?: KrakenDashboard,
): Promise<KrakenWithdrawal> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const withdrawals = await listWithdrawals(client, methodId, accountId, startedAt);
    const withdrawal = withdrawals.find((candidate) => candidate.withdrawal_id === withdrawalId);
    const status = withdrawal?.status?.toLowerCase();
    dashboard?.update(
      "withdrawal",
      "Waiting for the Kraken withdrawal to complete",
      { withdrawalId, status: status ?? "pending" },
      `Status: ${status ?? "pending"}`,
    );
    if (status === "success") return withdrawal!;
    if (status === "failed") throw new UsageError(`Kraken withdrawal ${withdrawalId} failed`);
    await Bun.sleep(pollIntervalSeconds * 1000);
  }
  throw new UsageError(`Timed out waiting for Kraken withdrawal ${withdrawalId}`);
}

async function listWithdrawals(
  client: KrakenFundingApi,
  methodId: string,
  accountId: string | undefined,
  startedAt: string,
): Promise<KrakenWithdrawal[]> {
  const withdrawals: KrakenWithdrawal[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.request("GET", "/funding/v1/withdrawals", {
      query: cursor
        ? { cursor }
        : {
            asset: { class: "currency", name: "USDC" },
            scope: { method_id: methodId },
            account_id: accountId,
            start_time: startedAt,
            limit: 500,
          },
      operation: "List Kraken CLI-only withdrawals",
    });
    if (Object.keys(response).length !== 0) {
      withdrawals.push(...requireArray<KrakenWithdrawal>(response.withdrawals, "Kraken withdrawals are missing"));
    }
    cursor = optionalText(response.next_cursor);
    if (!cursor) return withdrawals;
  }
  throw new UsageError("Kraken withdrawals exceeded the 10-page limit");
}

function requireDepositAmount(deposit: KrakenDeposit): string {
  const amount = requireRecord(deposit.amount, "Kraken deposit amount is missing");
  const asset = requireRecord(amount.asset, "Kraken deposit amount asset is missing");
  if (normalizeKrakenAsset(String(asset.name ?? "")) !== "BRL") {
    throw new UsageError("Kraken deposit amount is not BRL");
  }
  return requirePositiveDecimal(amount.amount, "Kraken BRL deposit amount");
}

function withdrawalTransactionHash(withdrawal: KrakenWithdrawal): string | undefined {
  const transaction = withdrawal.onchain_transaction;
  if (typeof transaction === "string") return validTransactionHash(transaction);
  if (!isRecord(transaction)) return undefined;
  for (const value of [transaction.transaction_hash, transaction.transaction_id, transaction.hash, transaction.id]) {
    if (typeof value === "string") {
      const hash = validTransactionHash(value);
      if (hash) return hash;
    }
  }
  return undefined;
}

function validTransactionHash(value: string): string | undefined {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
}

function fundingAmount(value: unknown, name: string, allowZero = false): string {
  const amount = requireRecord(value, `Kraken funding response does not contain ${name}`);
  const nestedAmount = isRecord(amount.asset_amount) ? amount.asset_amount : amount;
  return requireDecimal(nestedAmount.amount, `Kraken ${name}`, allowZero);
}

function showEnvironment(
  runtime: KrakenRuntime,
  environment: KrakenCliOnlyDepositEnvironment,
  amount: string | undefined,
  destinationAddress: string,
  network: KrakenWithdrawalNetwork,
  krakenBaseUrl: string,
): void {
  runtime.output.progress("kraken.cli-only.deposit.environment.validated", {
    krakenBaseUrl,
    amount: amount ?? "From selected deposit",
    resumeUsdAmount: environment.resumeUsdAmount ?? "Disabled",
    destinationAddress: maskedAddress(destinationAddress),
    network,
    depositMethodId: environment.depositMethodId ?? "Interactive selection",
    krakenDepositId: environment.krakenDepositId ?? "Interactive choice",
    withdrawalMethodId: environment.withdrawalMethodId ?? "Automatic native USDC match",
    accountId: environment.accountId ?? "Default",
    pollIntervalSeconds: environment.pollIntervalSeconds,
    timeoutSeconds: environment.timeoutSeconds,
  });
}

function parseNetwork(value: string | undefined): KrakenWithdrawalNetwork | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "ETHEREUM" || normalized === "BASE") return normalized;
  throw new UsageError("Kraken CLI-only destination network must be ETHEREUM or BASE");
}

function requireNetwork(value: KrakenWithdrawalNetwork | undefined): KrakenWithdrawalNetwork {
  if (!value) throw new UsageError("Kraken CLI-only destination network is required");
  return value;
}

function requireEvmAddress(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new UsageError("Kraken CLI-only destination address must be a valid EVM address");
  }
  return value.trim();
}

function maskedAddress(address: string): string {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return "Invalid address";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function normalizeNetwork(value: string | undefined): KrakenWithdrawalNetwork | undefined {
  const normalized = value?.replace(/[^a-z]/gi, "").toUpperCase();
  if (normalized === "ETHEREUM") return "ETHEREUM";
  if (normalized === "BASE") return "BASE";
  return undefined;
}

type ParsedDecimal = { units: bigint; scale: number };

function parseDecimal(value: string): ParsedDecimal {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new UsageError(`Invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function decimalSubtract(left: string, right: string): string {
  const aligned = alignDecimals(left, right);
  if (aligned.right > aligned.left) throw new UsageError(`Cannot subtract ${right} from ${left}`);
  return formatDecimal(aligned.left - aligned.right, aligned.scale);
}

function decimalCompare(left: string, right: string): number {
  const aligned = alignDecimals(left, right);
  if (aligned.left < aligned.right) return -1;
  if (aligned.left > aligned.right) return 1;
  return 0;
}

function decimalMultiplyDivide(
  value: string,
  multiplier: string,
  divisor: string,
  resultScale: number,
): string {
  const parsedValue = parseDecimal(value);
  const parsedMultiplier = parseDecimal(multiplier);
  const parsedDivisor = parseDecimal(divisor);
  if (parsedDivisor.units === 0n) throw new UsageError("Cannot divide by zero");
  const numerator =
    parsedValue.units *
    parsedMultiplier.units *
    10n ** BigInt(parsedDivisor.scale + resultScale);
  const denominator =
    parsedDivisor.units *
    10n ** BigInt(parsedValue.scale + parsedMultiplier.scale);
  const roundedUnits = (numerator + denominator / 2n) / denominator;
  return formatDecimal(roundedUnits, resultScale);
}

function decimalRound(value: string, resultScale: number): string {
  const parsed = parseDecimal(value);
  if (parsed.scale <= resultScale) return value;
  const divisor = 10n ** BigInt(parsed.scale - resultScale);
  const roundedUnits = (parsed.units + divisor / 2n) / divisor;
  return formatDecimal(roundedUnits, resultScale);
}

function decimalEquals(left: string, right: string): boolean {
  return decimalCompare(left, right) === 0;
}

function alignDecimals(left: string, right: string): { left: bigint; right: bigint; scale: number } {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return {
    left: parsedLeft.units * 10n ** BigInt(scale - parsedLeft.scale),
    right: parsedRight.units * 10n ** BigInt(scale - parsedRight.scale),
    scale,
  };
}

function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return String(units);
  const digits = String(units).padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function requirePositiveDecimal(value: unknown, name: string): string {
  const decimal = requireDecimal(value, name);
  if (decimalCompare(decimal, "0") <= 0) throw new UsageError(`${name} must be greater than zero`);
  return decimal;
}

function requireDecimal(value: unknown, name: string, allowZero = false): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new UsageError(`${name} must be a decimal amount`);
  }
  if (!allowZero && decimalCompare(value, "0") <= 0) {
    throw new UsageError(`${name} must be greater than zero`);
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new UsageError(message);
  return value;
}

function requireArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new UsageError(message);
  return value as T[];
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(message);
  return value;
}

function requirePrecision(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 18) {
    throw new UsageError(`Kraken ${name} is invalid`);
  }
  return Number(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function promptPositiveNumber(
  runtime: KrakenRuntime,
  label: string,
  defaultValue: number,
): Promise<number> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, String(defaultValue));
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    runtime.output.error(`${label} must be greater than zero`);
  }
}
