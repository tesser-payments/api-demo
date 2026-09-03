import { getKrakenConfiguration } from "../config.ts";
import { UsageError } from "../errors.ts";
import { KrakenSpotClient, type KrakenSpotApi } from "../kraken.ts";
import type { KrakenRuntime } from "./kraken.ts";

export type KrakenBalance = {
  asset: string;
  krakenAsset: string;
  balance: number;
  credit: number;
  creditUsed: number;
  tradingHold: number;
  available: number;
};

export async function runKrakenBalances(
  runtime: KrakenRuntime,
  spotApi?: KrakenSpotApi,
): Promise<KrakenBalance[]> {
  const client = spotApi ?? new KrakenSpotClient(getKrakenConfiguration(runtime.environment), runtime.output);
  const balances = await loadKrakenBalances(client);
  if (!runtime.output.verbose) {
    if (runtime.output.format === "json") runtime.output.result({ balances });
    else runtime.output.info(renderBalances(balances));
  }
  return balances;
}

export async function loadKrakenBalances(client: KrakenSpotApi): Promise<KrakenBalance[]> {
  const response = await client.request("POST", "/0/private/BalanceEx", {
    operation: "Get Kraken extended balance",
  });
  const result = requireRecord(response.result, "Kraken extended-balance response did not contain result");
  return Object.entries(result)
    .map(([krakenAsset, value]) => balanceFrom(krakenAsset, value))
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

export function normalizeKrakenAsset(asset: string): string {
  const withoutBalanceSuffix = asset.split(".")[0]!.toUpperCase();
  if (/^[XZ][A-Z]{3}$/.test(withoutBalanceSuffix)) return withoutBalanceSuffix.slice(1);
  return withoutBalanceSuffix;
}

export function availableKrakenBalance(balances: KrakenBalance[], asset: string): number {
  const normalizedAsset = normalizeKrakenAsset(asset);
  return balances
    .filter((balance) => balance.asset === normalizedAsset)
    .reduce((total, balance) => total + balance.available, 0);
}

function balanceFrom(krakenAsset: string, value: unknown): KrakenBalance {
  const fields = requireRecord(value, `Kraken balance ${krakenAsset} was not an object`);
  const balance = numberValue(fields.balance);
  const credit = numberValue(fields.credit);
  const creditUsed = numberValue(fields.credit_used);
  const tradingHold = numberValue(fields.hold_trade);
  return {
    asset: normalizeKrakenAsset(krakenAsset),
    krakenAsset,
    balance,
    credit,
    creditUsed,
    tradingHold,
    available: balance + credit - creditUsed - tradingHold,
  };
}

function renderBalances(balances: KrakenBalance[]): string {
  if (!balances.length) return "Kraken returned no balances.";
  return [
    "Kraken balances:",
    ...balances.map(
      (balance) =>
        `${balance.asset} (${balance.krakenAsset}): total ${balance.balance}, held ${balance.tradingHold}, available ${balance.available}`,
    ),
  ].join("\n");
}

function numberValue(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`Kraken returned an invalid balance value: ${String(value)}`);
  return parsed;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(message);
  return value as Record<string, unknown>;
}
