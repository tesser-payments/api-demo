import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import type { KrakenSpotApi, KrakenSpotRequest } from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";
import { normalizeKrakenAsset, runKrakenBalances } from "../src/workflows/kraken-balances.ts";
import { runKrakenSwap } from "../src/workflows/kraken-swap.ts";

describe("Kraken account workflows", () => {
  test("normalizes Kraken BRL1 balances to BRL", () => {
    expect(normalizeKrakenAsset("BRL1")).toBe("BRL");
  });

  test("shows total, held, and available balances", async () => {
    const request = mock(async () => ({
      error: [],
      result: {
        ZUSD: { balance: "10", hold_trade: "1.5" },
        USDC: { balance: "4", hold_trade: "0" },
      },
    }));
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);

    const balances = await runKrakenBalances(runtime(), { request } as KrakenSpotApi);

    expect(balances).toEqual([
      {
        asset: "USD",
        krakenAsset: "ZUSD",
        balance: 10,
        credit: 0,
        creditUsed: 0,
        tradingHold: 1.5,
        available: 8.5,
      },
      {
        asset: "USDC",
        krakenAsset: "USDC",
        balance: 4,
        credit: 0,
        creditUsed: 0,
        tradingHold: 0,
        available: 4,
      },
    ]);
    expect(standardOutput.mock.calls[0]?.[0]).toContain('"available": 8.5');
    standardOutput.mockRestore();
  });

  test("validates and executes a USD to USDC market order using quote volume", async () => {
    const responses: Record<string, unknown>[] = [
      { error: [], result: { ZUSD: { balance: "10", hold_trade: "0" } } },
      {
        error: [],
        result: {
          USDCUSD: {
            altname: "USDCUSD",
            wsname: "USDC/USD",
            base: "USDC",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { error: [], result: { descr: { order: "validated" } } },
      { error: [], result: { txid: ["order-1"] } },
      {
        error: [],
        result: {
          "order-1": {
            status: "closed",
            vol_exec: "5.01",
            cost: "5.00",
            fee: "0.01",
            price: "0.998",
          },
        },
      },
    ];
    const request = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenSwap(
      runtime(),
      { amount: "5", pollIntervalSeconds: 0.001, timeoutSeconds: 1 },
      { request } as KrakenSpotApi,
    );

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[2]?.[1]).toBe("/0/private/AddOrder");
    expect(request.mock.calls[2]?.[2].body).toMatchObject({
      pair: "USDCUSD",
      ordertype: "market",
      type: "buy",
      volume: "5",
      oflags: "viqc,fcib",
      validate: true,
    });
    expect(request.mock.calls[3]?.[2].body).not.toHaveProperty("validate");
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"orderId": "order-1"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("executes BRL to USD and spends the net USD result on USDC", async () => {
    const responses: Record<string, unknown>[] = [
      { error: [], result: { BRL1: { balance: "50", hold_trade: "0" } } },
      {
        error: [],
        result: {
          BRL1USD: {
            altname: "BRL1USD",
            wsname: "BRL1/USD",
            base: "BRL1",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { error: [], result: { descr: { order: "validated" } } },
      { error: [], result: { txid: ["brl-usd-order"] } },
      {
        error: [],
        result: {
          "brl-usd-order": {
            status: "closed",
            vol_exec: "20",
            cost: "4.00",
            fee: "0.01",
            price: "0.20",
          },
        },
      },
      {
        error: [],
        result: {
          USDCUSD: {
            altname: "USDCUSD",
            wsname: "USDC/USD",
            base: "USDC",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { error: [], result: { descr: { order: "validated" } } },
      { error: [], result: { txid: ["usd-usdc-order"] } },
      {
        error: [],
        result: {
          "usd-usdc-order": {
            status: "closed",
            vol_exec: "3.98",
            cost: "3.99",
            fee: "0.01",
            price: "1.0025",
          },
        },
      },
    ];
    const request = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenSwap(
      runtime(),
      {
        amount: "20",
        fromCurrency: "BRL",
        toCurrency: "USDC",
        pollIntervalSeconds: 0.001,
        timeoutSeconds: 1,
      },
      { request } as KrakenSpotApi,
    );

    const addOrderCalls = request.mock.calls.filter((call) => call[1] === "/0/private/AddOrder");
    expect(addOrderCalls).toHaveLength(4);
    expect(addOrderCalls[0]?.[2].body).toMatchObject({
      pair: "BRL1USD",
      ordertype: "market",
      type: "sell",
      volume: "20",
      oflags: "fciq",
      validate: true,
    });
    expect(addOrderCalls[2]?.[2].body).toMatchObject({
      pair: "USDCUSD",
      ordertype: "market",
      type: "buy",
      volume: "3.99",
      oflags: "viqc,fcib",
      validate: true,
    });
    const output = String(standardOutput.mock.calls.at(-1)?.[0]);
    expect(output).toContain('"from_currency": "BRL"');
    expect(output).toContain('"output_amount": "3.97002506"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });
});

function runtime(): KrakenRuntime {
  return {
    environment: {
      KRAKEN_API_KEY: "api-key",
      KRAKEN_API_SECRET: "c2VjcmV0",
    } as Environment,
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", false),
  };
}
