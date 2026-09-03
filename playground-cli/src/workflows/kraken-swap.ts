import { randomUUID } from "node:crypto";
import { firstValue, getKrakenConfiguration, positiveNumber } from "../config.ts";
import { UsageError } from "../errors.ts";
import { KrakenSpotClient, type KrakenSpotApi } from "../kraken.ts";
import type { KrakenRuntime } from "./kraken.ts";
import {
  availableKrakenBalance,
  loadKrakenBalances,
  normalizeKrakenAsset,
} from "./kraken-balances.ts";

type KrakenPair = {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
  ordermin?: string;
  costmin?: string;
  status?: string;
  [key: string]: unknown;
};

type KrakenOrder = {
  status?: string;
  reason?: string | null;
  vol?: string;
  vol_exec?: string;
  cost?: string;
  fee?: string;
  price?: string;
  [key: string]: unknown;
};

export type KrakenSwapOptions = {
  amount?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
};

export async function runKrakenSwap(
  runtime: KrakenRuntime,
  options: KrakenSwapOptions = {},
  spotApi?: KrakenSpotApi,
): Promise<void> {
  const client = spotApi ?? new KrakenSpotClient(getKrakenConfiguration(runtime.environment), runtime.output);
  const amount = await resolveAmount(runtime, options.amount);
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
  const balances = await loadKrakenBalances(client);
  const availableUsd = availableKrakenBalance(balances, "USD");
  if (availableUsd < Number(amount)) {
    throw new UsageError(`Kraken has ${availableUsd} USD available, less than the requested ${amount} USD`);
  }
  const pair = await resolveUsdUsdcPair(runtime, client);
  const pairName = pair.altname ?? pair.wsname?.replace("/", "");
  if (!pairName) throw new UsageError("Kraken USD/USDC pair did not contain an order symbol");
  const clientOrderId = randomUUID();
  const order = {
    ordertype: "market",
    type: "buy",
    volume: amount,
    pair: pairName,
    oflags: "viqc",
    cl_ord_id: clientOrderId,
  };
  await client.request("POST", "/0/private/AddOrder", {
    body: { ...order, validate: true },
    operation: "Validate Kraken USD to USDC market order",
  });
  runtime.output.info(
    [
      "Kraken market swap is valid:",
      `Spend: ${amount} USD`,
      `Receive: USDC at the available market price`,
      `Pair: ${pairName}`,
    ].join("\n"),
  );
  await runtime.interaction.approve("Place this live Kraken market order?", false);
  const createResponse = await client.request("POST", "/0/private/AddOrder", {
    body: order,
    operation: "Place Kraken USD to USDC market order",
  });
  const createResult = requireRecord(createResponse.result, "Kraken Add Order response did not contain result");
  const orderIds = requireArray<string>(createResult.txid, "Kraken Add Order response did not contain txid");
  const orderId = requireText(orderIds[0], "Kraken Add Order returned an empty txid");
  const completedOrder = await waitForOrder(client, orderId, pollIntervalSeconds, timeoutSeconds);
  if (!runtime.output.verbose) runtime.output.result({ orderId, ...completedOrder });
}

async function resolveAmount(runtime: KrakenRuntime, suppliedAmount: string | undefined): Promise<string> {
  const configuredAmount = suppliedAmount ?? firstValue(runtime.environment, "KRAKEN_SWAP_AMOUNT");
  const amount = runtime.interaction.interactive
    ? await runtime.interaction.text("USD amount to spend", configuredAmount)
    : configuredAmount;
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new UsageError("A positive USD swap amount is required");
  }
  return amount;
}

async function resolveUsdUsdcPair(runtime: KrakenRuntime, client: KrakenSpotApi): Promise<KrakenPair> {
  const response = await client.request("GET", "/0/public/AssetPairs", {
    operation: "Get Kraken tradable asset pairs",
  });
  const result = requireRecord(response.result, "Kraken Asset Pairs response did not contain result");
  const matches = Object.values(result)
    .filter(isRecord)
    .filter(
      (pair) =>
        normalizeKrakenAsset(String(pair.base ?? "")) === "USDC" &&
        normalizeKrakenAsset(String(pair.quote ?? "")) === "USD" &&
        pair.status !== "cancel_only" &&
        pair.status !== "post_only",
    ) as KrakenPair[];
  if (!matches.length) throw new UsageError("Kraken returned no tradable USDC/USD pair");
  if (matches.length === 1) return matches[0]!;
  const selected = await runtime.interaction.choose(
    "Select the Kraken USDC/USD pair",
    matches.map((pair, index) => ({
      name: pair.wsname ?? pair.altname ?? `USDC/USD pair ${index + 1}`,
      value: index,
    })),
  );
  return matches[selected]!;
}

async function waitForOrder(
  client: KrakenSpotApi,
  orderId: string,
  pollIntervalSeconds: number,
  timeoutSeconds: number,
): Promise<KrakenOrder> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await client.request("POST", "/0/private/QueryOrders", {
      body: { txid: orderId, trades: true },
      operation: "Query Kraken market order",
    });
    const result = requireRecord(response.result, "Kraken Query Orders response did not contain result");
    const order = result[orderId];
    if (isRecord(order)) {
      const status = String(order.status ?? "").toLowerCase();
      if (status === "closed") return order as KrakenOrder;
      if (status === "canceled" || status === "expired") {
        throw new UsageError(`Kraken order ${orderId} ended with status ${status}: ${String(order.reason ?? "")}`);
      }
    }
    await Bun.sleep(pollIntervalSeconds * 1000);
  }
  throw new UsageError(`Timed out waiting for Kraken order ${orderId}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
