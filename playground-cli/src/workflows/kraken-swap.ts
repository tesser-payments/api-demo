import { randomUUID } from "node:crypto";
import { firstValue, getKrakenConfiguration, positiveNumber } from "../config.ts";
import { UsageError } from "../errors.ts";
import { KrakenDashboard, resolveKrakenUi } from "../kraken-dashboard.ts";
import { KrakenSpotClient, type KrakenSpotApi } from "../kraken.ts";
import type { KrakenRuntime } from "./kraken.ts";
import { availableKrakenBalance, loadKrakenBalances, normalizeKrakenAsset } from "./kraken-balances.ts";

type KrakenSwapSourceCurrency = "BRL" | "USD";
type KrakenSwapDestinationCurrency = "USDC";
type KrakenSwapDashboardStage = "brl-usd" | "usd-usdc";

type KrakenPair = {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
  status?: string;
  lot_decimals?: number;
};

type KrakenOrder = {
  status?: string;
  reason?: string | null;
  vol_exec?: string;
  cost?: string;
  fee?: string;
  price?: string;
};

type KrakenMarketOrderInput = {
  requestedPair: string;
  baseAsset: string;
  quoteAsset: string;
  side: "buy" | "sell";
  volume: string;
  flags: string;
  inputCurrency: KrakenSwapSourceCurrency | "USD";
  outputCurrency: "USD" | KrakenSwapDestinationCurrency;
  dashboardStage: KrakenSwapDashboardStage;
};

type KrakenMarketOrderResult = {
  orderId: string;
  pair: string;
  side: "buy" | "sell";
  inputCurrency: string;
  inputAmount: string;
  outputCurrency: string;
  outputAmount: string;
  executedVolume: string;
  cost: string;
  fee: string;
  feeCurrency: string;
  outputFeeAmount: string;
  outputFeeCurrency: string;
  averagePrice?: string;
};

export type KrakenSwapOptions = {
  amount?: string;
  fromCurrency?: string;
  toCurrency?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  withUi?: boolean;
};

export async function runKrakenSwap(
  runtime: KrakenRuntime,
  options: KrakenSwapOptions = {},
  spotApi?: KrakenSpotApi,
): Promise<void> {
  const withUi = await resolveKrakenUi(runtime.interaction, options.withUi, "swap");
  const dashboard = withUi ? new KrakenDashboard("swap") : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Kraken swap UI: ${dashboard.outputPath}`);
  try {
    const fromCurrency = await resolveSourceCurrency(runtime, options.fromCurrency);
    const toCurrency = resolveDestinationCurrency(runtime, options.toCurrency);
    dashboard?.update("configure", "Reviewing the Kraken swap route", {
      amount: options.amount,
      fromCurrency,
      toCurrency,
    });
    const client = spotApi ?? new KrakenSpotClient(getKrakenConfiguration(runtime.environment), runtime.output);
    const balances = await loadKrakenBalances(client);
    const availableAmount = availableKrakenBalance(balances, fromCurrency);
    dashboard?.update("balance", `Checking the available Kraken ${fromCurrency} balance`, {
      availableAmount,
      currency: fromCurrency,
    });
    runtime.output.info(`Kraken has ${availableAmount} ${fromCurrency} available.`);
    const amount = await resolveAmount(runtime, options.amount, fromCurrency);
    if (availableAmount < Number(amount)) {
      throw new UsageError(
        `Kraken has ${availableAmount} ${fromCurrency} available, less than the requested ${amount} ${fromCurrency}`,
      );
    }
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
    const legs: KrakenMarketOrderResult[] = [];
    let usdAmount = amount;
    if (fromCurrency === "BRL") {
      const brlToUsd = await executeMarketOrder(
        runtime,
        client,
        {
          requestedPair: "BRL1USD",
          baseAsset: "BRL",
          quoteAsset: "USD",
          side: "sell",
          volume: amount,
          flags: "fciq",
          inputCurrency: "BRL",
          outputCurrency: "USD",
          dashboardStage: "brl-usd",
        },
        pollIntervalSeconds,
        timeoutSeconds,
        dashboard,
      );
      legs.push(brlToUsd);
      usdAmount = brlToUsd.outputAmount;
    }
    const usdToUsdc = await executeMarketOrder(
      runtime,
      client,
      {
        requestedPair: "USDCUSD",
        baseAsset: "USDC",
        quoteAsset: "USD",
        side: "buy",
        volume: usdAmount,
        flags: "viqc,fcib",
        inputCurrency: "USD",
        outputCurrency: "USDC",
        dashboardStage: "usd-usdc",
      },
      pollIntervalSeconds,
      timeoutSeconds,
      dashboard,
    );
    legs.push(usdToUsdc);
    const result = {
      status: "completed",
      from_currency: fromCurrency,
      to_currency: toCurrency,
      input_amount: amount,
      output_amount: usdToUsdc.outputAmount,
      legs,
    };
    dashboard?.complete(result);
    runtime.output.result(result);
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function resolveSourceCurrency(
  runtime: KrakenRuntime,
  suppliedCurrency: string | undefined,
): Promise<KrakenSwapSourceCurrency> {
  const configuredCurrency = suppliedCurrency ?? firstValue(runtime.environment, "KRAKEN_SWAP_FROM_CURRENCY");
  if (!configuredCurrency && runtime.interaction.interactive) {
    return runtime.interaction.choose("Currency to spend", [
      { name: "BRL", value: "BRL" as const },
      { name: "USD", value: "USD" as const },
    ]);
  }
  const currency = (configuredCurrency ?? "USD").trim().toUpperCase();
  if (currency !== "BRL" && currency !== "USD") {
    throw new UsageError("Kraken swap source currency must be BRL or USD");
  }
  return currency;
}

function resolveDestinationCurrency(
  runtime: KrakenRuntime,
  suppliedCurrency: string | undefined,
): KrakenSwapDestinationCurrency {
  const currency = (
    suppliedCurrency ?? firstValue(runtime.environment, "KRAKEN_SWAP_TO_CURRENCY") ?? "USDC"
  )
    .trim()
    .toUpperCase();
  if (currency !== "USDC") throw new UsageError("Kraken swap destination currency must be USDC");
  return currency;
}

async function resolveAmount(
  runtime: KrakenRuntime,
  suppliedAmount: string | undefined,
  currency: KrakenSwapSourceCurrency,
): Promise<string> {
  const configuredAmount = suppliedAmount ?? firstValue(runtime.environment, "KRAKEN_SWAP_AMOUNT");
  const amount = runtime.interaction.interactive
    ? await runtime.interaction.text(`${currency} amount to spend`, configuredAmount)
    : configuredAmount;
  if (!amount || !/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new UsageError(`A positive ${currency} swap amount is required`);
  }
  return amount;
}

async function executeMarketOrder(
  runtime: KrakenRuntime,
  client: KrakenSpotApi,
  input: KrakenMarketOrderInput,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
  dashboard?: KrakenDashboard,
): Promise<KrakenMarketOrderResult> {
  dashboard?.update(input.dashboardStage, `Selecting the Kraken ${input.requestedPair} market`, {
    amount: input.volume,
    fromCurrency: input.inputCurrency,
    toCurrency: input.outputCurrency,
  });
  const pair = await resolvePair(client, input);
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
  dashboard?.update(input.dashboardStage, `Validating the Kraken ${pairName} market order`, order);
  await client.request("POST", "/0/private/AddOrder", {
    body: { ...order, validate: true },
    operation: `Validate Kraken ${input.inputCurrency} to ${input.outputCurrency} market order`,
  });
  runtime.output.info(
    [
      `Kraken ${input.inputCurrency} to ${input.outputCurrency} market order is valid:`,
      `Spend: ${input.volume} ${input.inputCurrency}`,
      `Receive: ${input.outputCurrency} at the available market price`,
      `Pair: ${pairName}`,
    ].join("\n"),
  );
  await runtime.interaction.approve(
    `Place the live ${input.inputCurrency} to ${input.outputCurrency} Kraken market order?`,
    false,
  );
  dashboard?.update(input.dashboardStage, `Placing the Kraken ${pairName} market order`, order);
  const createResponse = await client.request("POST", "/0/private/AddOrder", {
    body: { ...order, deadline: new Date(Date.now() + 15_000).toISOString() },
    operation: `Place Kraken ${input.inputCurrency} to ${input.outputCurrency} market order`,
  });
  const createResult = requireRecord(createResponse.result, "Kraken Add Order response did not contain result");
  const orderIds = requireArray<string>(createResult.txid, "Kraken Add Order response did not contain txid");
  if (orderIds.length !== 1) throw new UsageError("Kraken Add Order did not return exactly one order ID");
  const orderId = requireText(orderIds[0], "Kraken Add Order returned an empty txid");
  const completedOrder = await waitForOrder(
    client,
    orderId,
    pollIntervalSeconds,
    timeoutSeconds,
    dashboard,
    input.dashboardStage,
  );
  const executedVolume = requireDecimal(completedOrder.vol_exec, "Kraken executed volume");
  const cost = requireDecimal(completedOrder.cost, "Kraken order cost");
  const fee = requireDecimal(completedOrder.fee, "Kraken order fee", true);
  const outputFeeAmount =
    input.side === "sell"
      ? fee
      : decimalMultiplyDivide(
          executedVolume,
          fee,
          cost,
          requirePrecision(pair.lot_decimals, `${pairName} lot_decimals`),
        );
  const outputAmount =
    input.side === "sell"
      ? decimalSubtract(cost, outputFeeAmount)
      : decimalSubtract(executedVolume, outputFeeAmount);
  if (decimalCompare(outputAmount, "0") <= 0) {
    throw new UsageError(`Kraken ${input.inputCurrency} to ${input.outputCurrency} order produced no output`);
  }
  return {
    orderId,
    pair: pairName,
    side: input.side,
    inputCurrency: input.inputCurrency,
    inputAmount: input.volume,
    outputCurrency: input.outputCurrency,
    outputAmount,
    executedVolume,
    cost,
    fee,
    feeCurrency: input.quoteAsset,
    outputFeeAmount,
    outputFeeCurrency: input.outputCurrency,
    averagePrice: optionalText(completedOrder.price),
  };
}

async function resolvePair(client: KrakenSpotApi, input: KrakenMarketOrderInput): Promise<KrakenPair> {
  const response = await client.request("GET", "/0/public/AssetPairs", {
    query: { pair: input.requestedPair },
    operation: `Get Kraken ${input.requestedPair} market`,
  });
  const result = requireRecord(response.result, "Kraken Asset Pairs response did not contain result");
  const matches = Object.values(result)
    .filter(isRecord)
    .filter(
      (pair) =>
        normalizeKrakenAsset(String(pair.base ?? "")) === input.baseAsset &&
        normalizeKrakenAsset(String(pair.quote ?? "")) === input.quoteAsset &&
        pair.status === "online",
    ) as KrakenPair[];
  if (matches.length !== 1) {
    throw new UsageError(
      `Kraken returned ${matches.length} online ${input.baseAsset}/${input.quoteAsset} markets`,
    );
  }
  return matches[0]!;
}

async function waitForOrder(
  client: KrakenSpotApi,
  orderId: string,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
  dashboard: KrakenDashboard | undefined,
  dashboardStage: KrakenSwapDashboardStage,
): Promise<KrakenOrder> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await client.request("POST", "/0/private/QueryOrders", {
      body: { txid: orderId, trades: false },
      operation: "Query Kraken market order",
    });
    const result = requireRecord(response.result, "Kraken Query Orders response did not contain result");
    const order = result[orderId];
    if (isRecord(order)) {
      const status = String(order.status ?? "").toLowerCase();
      dashboard?.update(
        dashboardStage,
        "Waiting for the Kraken market order to close",
        { orderId, ...order },
        `Status: ${status || "unknown"}`,
      );
      if (status === "closed") return order as KrakenOrder;
      if (status === "canceled" || status === "expired") {
        throw new UsageError(
          `Kraken order ${orderId} ended with status ${status}: ${String(order.reason ?? "")}`,
        );
      }
    }
    await Bun.sleep(pollIntervalSeconds * 1000);
  }
  throw new UsageError(`Timed out waiting for Kraken order ${orderId}`);
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
